import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { mapDeployment, mapDeploymentDetail } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict } from '../middleware/error-handler.js';
import { logManager } from '../engine/log-manager.js';
import { buildManager } from '../engine/build-manager.js';
import { eventBus } from '../engine/event-bus.js';

const router = Router();
router.use(requireAuth);

function getDeployment(deploymentId) {
  const dep = queryOne('SELECT * FROM deployments WHERE id = ?', deploymentId);
  if (!dep) throw notFound('Deployment not found');
  return dep;
}

// GET /deployments/:deploymentId
router.get('/:deploymentId', (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  const user = dep.created_by ? queryOne('SELECT id, name, username, avatar_url FROM users WHERE id = ?', dep.created_by) : null;
  const srv = queryOne('SELECT name, port FROM services WHERE id = ?', dep.service_id);

  const url = srv?.port ? `http://localhost:${srv.port}` : null;
  const mapped = mapDeployment(dep, user);
  return res.json(mapDeploymentDetail(mapped, [], url));
});

// POST /deployments/:deploymentId/redeploy
router.post('/:deploymentId/redeploy', async (req, res, next) => {
  try {
    const dep = getDeployment(req.params.deploymentId);
    const newId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, commit_sha, commit_message, commit_author, commit_branch, image, created_by, created_at)
      VALUES (?, ?, ?, ?, 'queued', 'redeploy', ?, ?, ?, ?, ?, ?, ?)
    `, newId, dep.service_id, dep.service_name, dep.environment_id,
      dep.commit_sha, dep.commit_message, dep.commit_author, dep.commit_branch,
      dep.image, req.user.id, now);

    buildManager.buildAndDeploy(dep.service_id, newId).catch(err => {
      console.error('[Redeploy Error]', err);
    });

    const newDep = queryOne('SELECT * FROM deployments WHERE id = ?', newId);
    return res.status(202).json(mapDeployment(newDep));
  } catch (err) {
    next(err);
  }
});

// POST /deployments/:deploymentId/rollback
router.post('/:deploymentId/rollback', async (req, res, next) => {
  try {
    const dep = getDeployment(req.params.deploymentId);
    const newId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, commit_sha, commit_message, commit_author, commit_branch, image, created_by, rollback_of_deployment_id, created_at)
      VALUES (?, ?, ?, ?, 'queued', 'rollback', ?, ?, ?, ?, ?, ?, ?, ?)
    `, newId, dep.service_id, dep.service_name, dep.environment_id,
      dep.commit_sha, dep.commit_message, dep.commit_author, dep.commit_branch,
      dep.image, req.user.id, dep.id, now);

    buildManager.buildAndDeploy(dep.service_id, newId).catch(err => {
      console.error('[Rollback Error]', err);
    });

    const newDep = queryOne('SELECT * FROM deployments WHERE id = ?', newId);
    return res.status(202).json(mapDeployment(newDep));
  } catch (err) {
    next(err);
  }
});

// POST /deployments/:deploymentId/cancel
router.post('/:deploymentId/cancel', (req, res, next) => {
  try {
    const dep = getDeployment(req.params.deploymentId);
    if (!['queued', 'building', 'deploying'].includes(dep.state)) {
      throw conflict('Deployment is already in a terminal state', 'invalid_state');
    }

    const now = new Date().toISOString();
    execute('UPDATE deployments SET state = ?, finished_at = ? WHERE id = ?', 'cancelled', now, dep.id);
    execute('UPDATE services SET building_deployment_id = NULL WHERE building_deployment_id = ?', dep.id);

    eventBus.emitEnvironmentEvent(dep.environment_id, {
      type: 'deployment.updated',
      at: now,
      actorId: req.user.id,
      canvasRevision: null,
      data: { id: dep.id, state: 'cancelled' }
    });

    const updated = queryOne('SELECT * FROM deployments WHERE id = ?', dep.id);
    return res.json(mapDeployment(updated));
  } catch (err) {
    next(err);
  }
});

// GET /deployments/:deploymentId/logs
router.get('/:deploymentId/logs', (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  const limit = parseInt(req.query.limit || '100', 10);
  const cursor = req.query.cursor;
  const level = req.query.level ? (Array.isArray(req.query.level) ? req.query.level : [req.query.level]) : null;
  const q = req.query.q || null;

  const page = logManager.getDeploymentLogs(dep.id, { limit, cursor, level, q });
  return res.json(page);
});

// GET /deployments/:deploymentId/logs/stream (SSE)
router.get('/:deploymentId/logs/stream', (req, res) => {
  const dep = getDeployment(req.params.deploymentId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send existing logs first
  const existing = logManager.getDeploymentLogs(dep.id, { limit: 100 });
  for (const line of existing.data) {
    res.write(`event: line\n`);
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  // If already finished, emit end event and close
  if (['active', 'failed', 'cancelled', 'crashed'].includes(dep.state)) {
    res.write(`event: end\n`);
    res.write(`data: ${JSON.stringify({ state: dep.state })}\n\n`);
    return res.end();
  }

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const onLog = (logLine) => {
    res.write(`event: line\n`);
    res.write(`data: ${JSON.stringify(logLine)}\n\n`);
  };

  eventBus.on(`deployment:${dep.id}:log`, onLog);

  const onEnvEvent = (event) => {
    if (event.type === 'deployment.updated' && event.data?.id === dep.id) {
      const state = event.data.state;
      if (['active', 'failed', 'cancelled', 'crashed'].includes(state)) {
        res.write(`event: end\n`);
        res.write(`data: ${JSON.stringify({ state })}\n\n`);
        clearInterval(heartbeat);
        eventBus.off(`deployment:${dep.id}:log`, onLog);
        eventBus.off(`environment:${dep.environment_id}`, onEnvEvent);
        res.end();
      }
    }
  };

  eventBus.on(`environment:${dep.environment_id}`, onEnvEvent);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off(`deployment:${dep.id}:log`, onLog);
    eventBus.off(`environment:${dep.environment_id}`, onEnvEvent);
  });
});

export default router;
