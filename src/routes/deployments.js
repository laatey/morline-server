import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { mapDeployment, mapDeploymentDetail } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict } from '../middleware/error-handler.js';
import { logManager } from '../engine/log-manager.js';
import { buildManager } from '../engine/build-manager.js';
import { eventBus } from '../engine/event-bus.js';
import { PUBLIC_URL } from '../config.js';
import { getDiagnosis, startDiagnosis, dismissDiagnosis, createDiagnosisPullRequest } from '../engine/diagnosis-manager.js';
import { validationError } from '../middleware/error-handler.js';

const router = Router();
router.use(requireAuth);

function getDeployment(deploymentId) {
  const dep = queryOne('SELECT * FROM deployments WHERE id = ?', deploymentId);
  if (!dep) throw notFound('Deployment not found');
  return dep;
}

function parsePhase(value) {
  if (value === undefined || value === '') return null;
  if (value === 'build' || value === 'deploy') return value;
  throw validationError('phase must be "build" or "deploy"', { phase: 'Expected build or deploy' });
}

// GET /deployments/:deploymentId
router.get('/:deploymentId', (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  const user = dep.created_by ? queryOne('SELECT id, name, username, avatar_url FROM users WHERE id = ?', dep.created_by) : null;
  const srv = queryOne('SELECT name, port, primary_domain FROM services WHERE id = ?', dep.service_id);

  let url = null;
  if (srv?.primary_domain) {
    url = `https://${srv.primary_domain}`;
  } else if (srv?.port) {
    url = `${PUBLIC_URL}/proxy/${dep.service_id}`;
  }

  const mapped = mapDeployment(dep, user);

  // What this deployment actually ran with, recorded when it was built. Deployments that
  // predate snapshots get empty variables and null config; source falls back to the service.
  let snapshot = null;
  try { snapshot = dep.snapshot ? JSON.parse(dep.snapshot) : null; } catch { /* corrupt snapshot */ }
  let source = snapshot?.source ?? null;
  if (!snapshot) {
    const svc = queryOne('SELECT source_type, source_repo FROM services WHERE id = ?', dep.service_id);
    if (svc?.source_repo) source = { type: svc.source_type || 'github', repo: svc.source_repo, branch: dep.commit_branch || null };
  }

  return res.json({
    ...mapDeploymentDetail(mapped, [], url),
    variables: snapshot?.variables ?? [],
    config: snapshot?.config ?? null,
    source
  });
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
  const phase = parsePhase(req.query.phase);

  const page = logManager.getDeploymentLogs(dep.id, { limit, cursor, level, q, phase });
  return res.json(page);
});

// GET /deployments/:deploymentId/logs/stream (SSE)
router.get('/:deploymentId/logs/stream', (req, res) => {
  const dep = getDeployment(req.params.deploymentId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const phase = parsePhase(req.query.phase);

  // Send existing logs first
  const existing = logManager.getDeploymentLogs(dep.id, { limit: 100, phase });
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
    if (phase && logLine.phase !== phase) return;
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

// GET /deployments/:deploymentId/diagnosis
router.get('/:deploymentId/diagnosis', (req, res) => {
  const dep = getDeployment(req.params.deploymentId);
  const diagnosis = getDiagnosis(dep.id);
  if (!diagnosis) throw notFound('No diagnosis for this deployment', 'diagnosis_not_found');
  return res.json(diagnosis);
});

// POST /deployments/:deploymentId/diagnosis - start the analysis; the app polls the GET above
router.post('/:deploymentId/diagnosis', (req, res, next) => {
  try {
    const dep = getDeployment(req.params.deploymentId);
    return res.status(202).json(startDiagnosis(dep));
  } catch (err) {
    next(err);
  }
});

// POST /deployments/:deploymentId/diagnosis/pull-request
router.post('/:deploymentId/diagnosis/pull-request', async (req, res, next) => {
  try {
    const dep = getDeployment(req.params.deploymentId);
    const { url, number } = await createDiagnosisPullRequest(dep);
    return res.json({ url, number });
  } catch (err) {
    next(err);
  }
});

// POST /deployments/:deploymentId/diagnosis/dismiss
router.post('/:deploymentId/diagnosis/dismiss', (req, res, next) => {
  try {
    const dep = getDeployment(req.params.deploymentId);
    return res.json(dismissDiagnosis(dep.id));
  } catch (err) {
    next(err);
  }
});

export default router;
