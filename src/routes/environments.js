import { resolveGithubSource } from '../services/github-url.js';
import { hasTemplate, provisionTemplate } from '../templates/catalog.js';
import { privateHostname } from '../engine/private-network.js';
import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapEnvironment, mapService, mapConnection, mapVariable, mapDeployment, mapDomain } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict, validationError } from '../middleware/error-handler.js';
import { eventBus } from '../engine/event-bus.js';
import { logManager } from '../engine/log-manager.js';
import { metricsCollector } from '../engine/metrics-collector.js';
import { buildManager } from '../engine/build-manager.js';
import { isValidImageRef, defaultNameFromImage } from '../engine/image-ref.js';
import stagedChangesRouter from './staged-changes.js';
import { createStagedChange } from '../services/staged-changes-helper.js';

const router = Router();
router.use(requireAuth);

function getEnvironment(envId) {
  const env = queryOne('SELECT * FROM environments WHERE id = ?', envId);
  if (!env) throw notFound('Environment not found');
  return env;
}

// GET /environments/:environmentId
router.get('/:environmentId', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const serviceCount = queryOne('SELECT COUNT(*) as count FROM services WHERE environment_id = ?', env.id)?.count || 0;
  return res.json(mapEnvironment(env, serviceCount));
});

// PATCH /environments/:environmentId
router.patch('/:environmentId', (req, res, next) => {
  try {
    const env = getEnvironment(req.params.environmentId);
    const { name, type, protected: isProtected } = req.body || {};

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (type !== undefined) {
      updates.push('type = ?');
      params.push(type);
    }
    if (isProtected !== undefined) {
      updates.push('protected = ?');
      params.push(isProtected ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(env.id);
      execute(`UPDATE environments SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const updated = queryOne('SELECT * FROM environments WHERE id = ?', env.id);
    const serviceCount = queryOne('SELECT COUNT(*) as count FROM services WHERE environment_id = ?', env.id)?.count || 0;
    return res.json(mapEnvironment(updated, serviceCount));
  } catch (err) {
    next(err);
  }
});

// DELETE /environments/:environmentId
router.delete('/:environmentId', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  execute('DELETE FROM environments WHERE id = ?', env.id);
  return res.status(204).end();
});

// GET /environments/:environmentId/status
router.get('/:environmentId/status', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const services = queryAll('SELECT * FROM services WHERE environment_id = ?', env.id);

  let status = 'empty';
  if (services.length > 0) {
    const online = services.filter(s => s.status === 'online');
    if (online.length === services.length) status = 'healthy';
    else if (services.some(s => s.status === 'crashed')) status = 'degraded';
    else if (services.some(s => s.status === 'deploying')) status = 'deploying';
    else status = 'sleeping';
  }

  return res.json({
    status,
    serviceCount: services.length,
    services: services.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      port: s.port
    }))
  });
});

// GET /environments/:environmentId/events (SSE)
router.get('/:environmentId/events', (req, res) => {
  const env = getEnvironment(req.params.environmentId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const onEvent = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  eventBus.on(`environment:${env.id}`, onEvent);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off(`environment:${env.id}`, onEvent);
  });
});

// GET /environments/:environmentId/canvas
router.get('/:environmentId/canvas', (req, res) => {
  const env = getEnvironment(req.params.environmentId);

  const serviceRows = queryAll('SELECT * FROM services WHERE environment_id = ? ORDER BY created_at ASC', env.id);
  const connectionRows = queryAll('SELECT * FROM connections WHERE environment_id = ? ORDER BY created_at ASC', env.id);

  const services = serviceRows.map(s => {
    const activeDep = s.active_deployment_id ? queryOne('SELECT * FROM deployments WHERE id = ?', s.active_deployment_id) : null;
    const buildingDep = s.building_deployment_id ? queryOne('SELECT * FROM deployments WHERE id = ?', s.building_deployment_id) : null;
    return mapService(s, {
      activeDeployment: activeDep ? mapDeployment(activeDep) : null,
      buildingDeployment: buildingDep ? mapDeployment(buildingDep) : null
    });
  });

  const connections = connectionRows.map(mapConnection);

  return res.json({
    environmentId: env.id,
    revision: env.canvas_revision,
    services,
    connections,
    viewport: env.viewport_zoom ? {
      x: env.viewport_x || 0,
      y: env.viewport_y || 0,
      zoom: env.viewport_zoom || 1
    } : null
  });
});

// PATCH /environments/:environmentId/canvas/layout
router.patch('/:environmentId/canvas/layout', (req, res, next) => {
  try {
    const env = getEnvironment(req.params.environmentId);
    const { revision, positions } = req.body || {};

    if (revision !== undefined && revision !== env.canvas_revision) {
      // Optimistic concurrency conflict -> return current canvas
      const serviceRows = queryAll('SELECT * FROM services WHERE environment_id = ?', env.id);
      const connectionRows = queryAll('SELECT * FROM connections WHERE environment_id = ?', env.id);
      return res.status(409).json({
        environmentId: env.id,
        revision: env.canvas_revision,
        services: serviceRows.map(s => mapService(s)),
        connections: connectionRows.map(mapConnection),
        viewport: { x: env.viewport_x, y: env.viewport_y, zoom: env.viewport_zoom }
      });
    }

    if (Array.isArray(positions)) {
      transaction(() => {
        for (const p of positions) {
          execute('UPDATE services SET position_x = ?, position_y = ? WHERE id = ? AND environment_id = ?',
            p.x, p.y, p.serviceId, env.id);
        }
        execute('UPDATE environments SET canvas_revision = canvas_revision + 1, updated_at = ? WHERE id = ?',
          new Date().toISOString(), env.id);
      });
    }

    const updated = queryOne('SELECT canvas_revision FROM environments WHERE id = ?', env.id);
    eventBus.emitEnvironmentEvent(env.id, {
      type: 'canvas.updated',
      at: new Date().toISOString(),
      actorId: req.user.id,
      canvasRevision: updated.canvas_revision,
      data: { positions }
    });

    return res.json({ revision: updated.canvas_revision });
  } catch (err) {
    next(err);
  }
});

// PUT /environments/:environmentId/canvas/viewport
router.put('/:environmentId/canvas/viewport', (req, res, next) => {
  try {
    const env = getEnvironment(req.params.environmentId);
    const { x, y, zoom } = req.body || {};

    execute('UPDATE environments SET viewport_x = ?, viewport_y = ?, viewport_zoom = ? WHERE id = ?',
      x || 0, y || 0, zoom || 1, env.id);

    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /environments/:environmentId/services
router.get('/:environmentId/services', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const rows = queryAll('SELECT * FROM services WHERE environment_id = ? ORDER BY created_at ASC', env.id);
  const data = rows.map(s => {
    const activeDep = s.active_deployment_id ? queryOne('SELECT * FROM deployments WHERE id = ?', s.active_deployment_id) : null;
    const buildingDep = s.building_deployment_id ? queryOne('SELECT * FROM deployments WHERE id = ?', s.building_deployment_id) : null;
    return mapService(s, {
      activeDeployment: activeDep ? mapDeployment(activeDep) : null,
      buildingDeployment: buildingDep ? mapDeployment(buildingDep) : null
    });
  });
  return res.json({ data });
});

// POST /environments/:environmentId/services
router.post('/:environmentId/services', async (req, res, next) => {
  try {
    const env = getEnvironment(req.params.environmentId);
    const { name, templateId, source, position, settings, variables, deploy = true } = req.body || {};

    // Docker image sources: validate the reference and port up front, with errors the form can show.
    const isImage = source?.type === 'image' || source?.type === 'docker';
    if (isImage) {
      const image = String(source.image || '').trim();
      if (!image) throw validationError('Enter a Docker image, for example nginx:latest', { 'source.image': 'Required' });
      if (!isValidImageRef(image)) throw validationError('That does not look like a Docker image reference', { 'source.image': 'Use the form name:tag, e.g. ghcr.io/acme/app:1.0' });
      if (source.port != null && source.port !== '' && !(Number.isInteger(Number(source.port)) && Number(source.port) > 0 && Number(source.port) < 65536)) {
        throw validationError('Port must be between 1 and 65535', { 'source.port': 'Invalid port' });
      }
      source.image = image;
    }
    const imagePort = isImage && source.port ? Number(source.port) : null;

    const serviceName = name || (isImage ? defaultNameFromImage(source.image) : (templateId ? templateId : 'service')) + (name || isImage ? '' : '-' + Math.floor(100 + Math.random() * 900));
    const serviceId = `srv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    const posX = position?.x || 100;
    const posY = position?.y || 100;
    const sourceType = isImage ? 'image' : (source?.type || (templateId ? 'template' : 'template'));
    // A pasted GitHub URL (optionally .../tree/<branch>/<folder>) is cloned anonymously.
    const fromUrl = await resolveGithubSource(source?.url || source?.repo);
    const sourceRepo = fromUrl?.repo || source?.repo || null;
    const sourceUrl = source?.url || null;
    // No branch unless one was asked for; the build then uses the repository's default branch.
    const sourceBranch = (source?.branch || fromUrl?.branch || '').trim() || null;
    const sourceRootDir = source?.rootDirectory || fromUrl?.rootDirectory || null;
    const sourceImage = source?.image || null;
    const sourceTemplateId = templateId || source?.templateId || null;
    const sourceDisplay = source?.display || (isImage ? source.image : serviceName);
    const isGithubImport = source?.type === 'github' || Boolean(sourceUrl);

    let logo = isImage ? 'docker' : 'js';
    let kind = 'app';
    if (sourceTemplateId) {
      const tmpl = queryOne('SELECT * FROM templates WHERE id = ?', sourceTemplateId);
      if (tmpl) {
        logo = tmpl.logo;
        kind = tmpl.kind;
      }
    }

    transaction(() => {
      execute(`
        INSERT INTO services (id, environment_id, name, kind, logo, status, position_x, position_y, source_type, source_repo, source_branch, source_root_dir, source_url, source_image, source_template_id, source_display, region, replicas, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'us-east-1', 1, ?, ?)
      `, serviceId, env.id, serviceName, kind, logo, posX, posY,
        sourceUrl ? 'github' : sourceType,
        sourceRepo, sourceBranch, sourceRootDir, sourceUrl, sourceImage, sourceTemplateId, sourceDisplay, now, now);

      execute(`
        INSERT INTO service_settings (service_id, branch, root_directory, auto_deploy, build_command, start_command, healthcheck_path, healthcheck_timeout_sec, restart_policy, replicas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, serviceId, settings?.branch || sourceBranch, settings?.rootDirectory || sourceRootDir,
        settings?.autoDeploy ?? 1, settings?.buildCommand || null, settings?.startCommand || 'node server.js',
        settings?.healthcheckPath || '/', settings?.healthcheckTimeoutSec || 30, settings?.restartPolicy || 'on-failure', settings?.replicas || 1);

      execute(`
        INSERT INTO service_networking (service_id, public, target_port)
        VALUES (?, 1, ?)
      `, serviceId, isImage ? imagePort : 3000); // image services without a port auto-detect it at deploy time

      // Ingest variables
      if (Array.isArray(variables)) {
        for (const v of variables) {
          execute(`
            INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
            VALUES (?, 'service', ?, ?, ?, ?, ?, ?)
          `, `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, serviceId, v.key, v.value, v.secret ? 1 : 0, now, now);
        }
      }

      // Template services deploy from their folder in the templates repository. This runs after
      // the request's own variables are stored, so anything the caller set wins over defaults.
      if (!sourceUrl && hasTemplate(sourceTemplateId)) provisionTemplate(serviceId, sourceTemplateId, now);
    });

    const srvRow = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    const serviceMapped = mapService(srvRow);

    eventBus.emitEnvironmentEvent(env.id, {
      type: 'service.created',
      at: now,
      actorId: req.user.id,
      canvasRevision: env.canvas_revision,
      data: serviceMapped
    });

    // A repository import needs a configuration step first. Most applications
    // require secrets or a monorepo root before a useful first deployment.
    // Record it in staged changes so the user can edit Settings and Variables,
    // then deploy everything deliberately from the staged-change action.
    if (isGithubImport) {
      createStagedChange({
        environmentId: env.id,
        serviceId,
        serviceName,
        type: 'source.import',
        summary: `Imported ${serviceName} from GitHub — configure settings and variables before deploying`,
        payload: { source: 'github', repository: sourceRepo, branch: sourceBranch }
      });
    } else if (deploy) {
      const depId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      execute(`
        INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, created_by, created_at)
        VALUES (?, ?, ?, ?, 'queued', 'manual', ?, ?)
      `, depId, serviceId, serviceName, env.id, req.user.id, now);

      buildManager.buildAndDeploy(serviceId, depId).catch(e => {
        console.error('[Deploy Error]', e);
      });
    }

    return res.status(201).json({
      service: serviceMapped,
      data: serviceMapped,
      ...serviceMapped
    });
  } catch (err) {
    next(err);
  }
});

// POST /environments/:environmentId/connections
router.post('/:environmentId/connections', (req, res, next) => {
  try {
    const env = getEnvironment(req.params.environmentId);
    const { fromServiceId, toServiceId, protocol = 'http', port = null, injectVariables = true } = req.body || {};

    if (!fromServiceId || !toServiceId) {
      throw validationError('fromServiceId and toServiceId are required');
    }
    if (fromServiceId === toServiceId) {
      return res.status(400).json({
        code: 'invalid_connection',
        message: 'Cannot connect a service to itself'
      });
    }

    const fromSrv = queryOne('SELECT * FROM services WHERE id = ? AND environment_id = ?', fromServiceId, env.id);
    const toSrv = queryOne('SELECT * FROM services WHERE id = ? AND environment_id = ?', toServiceId, env.id);
    if (!fromSrv || !toSrv) {
      return res.status(400).json({
        code: 'invalid_connection',
        message: 'Both services must belong to the same environment'
      });
    }

    const existing = queryOne('SELECT id FROM connections WHERE from_service_id = ? AND to_service_id = ?', fromServiceId, toServiceId);
    if (existing) {
      throw conflict('A connection already exists between these services', 'connection_exists');
    }

    const connId = `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const effectivePort = port || toSrv.port || 3000;
    const label = `${protocol} :${effectivePort}`;

    const injectedVars = [];

    transaction(() => {
      execute(`
        INSERT INTO connections (id, environment_id, from_service_id, to_service_id, protocol, port, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, connId, env.id, fromServiceId, toServiceId, protocol, effectivePort, label, now);

      if (injectVariables) {
        const key = `${toSrv.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;
        const val = `http://${privateHostname(toSrv)}:${effectivePort}`;
        const varId = `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

        execute(`
          INSERT INTO variables (id, scope_type, scope_id, key, value, secret, is_reference, source, created_at, updated_at)
          VALUES (?, 'service', ?, ?, ?, 0, 1, ?, ?, ?)
          ON CONFLICT(scope_type, scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `, varId, fromServiceId, key, val, toSrv.name, now, now);

        const vRow = queryOne('SELECT * FROM variables WHERE id = ?', varId);
        if (vRow) injectedVars.push(mapVariable(vRow));
      }

      createStagedChange({
        environmentId: env.id,
        serviceId: fromServiceId,
        serviceName: fromSrv.name,
        type: 'connection.created',
        summary: `Connected to ${toSrv.name} (${label})`,
        payload: { connectionId: connId, fromServiceId, toServiceId }
      });
    });

    const connRow = queryOne('SELECT * FROM connections WHERE id = ?', connId);
    const mappedConn = mapConnection(connRow);

    eventBus.emitEnvironmentEvent(env.id, {
      type: 'connection.created',
      at: now,
      actorId: req.user.id,
      canvasRevision: env.canvas_revision,
      data: mappedConn
    });

    return res.status(201).json({
      connection: mappedConn,
      injectedVariables: injectedVars
    });
  } catch (err) {
    next(err);
  }
});

// GET /environments/:environmentId/deployments
router.get('/:environmentId/deployments', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const limit = parseInt(req.query.limit || '20', 10);
  const cursor = req.query.cursor;

  let sql = 'SELECT * FROM deployments WHERE environment_id = ?';
  const params = [env.id];

  if (cursor) {
    sql += ' AND created_at < ?';
    params.push(cursor);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);

  const rows = queryAll(sql, ...params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1].created_at : null;

  return res.json({
    data: items.map(r => mapDeployment(r)),
    nextCursor
  });
});

// GET /environments/:environmentId/domains
router.get('/:environmentId/domains', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const rows = queryAll('SELECT * FROM domains WHERE environment_id = ? ORDER BY created_at ASC', env.id);
  return res.json({ data: rows.map(mapDomain) });
});

// GET /environments/:environmentId/variables
router.get('/:environmentId/variables', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const rows = queryAll('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? ORDER BY key ASC', 'environment', env.id);
  return res.json({ data: rows.map(mapVariable) });
});

// PUT /environments/:environmentId/variables
router.put('/:environmentId/variables', (req, res, next) => {
  try {
    const env = getEnvironment(req.params.environmentId);
    const { variables } = req.body || {};

    if (!Array.isArray(variables)) {
      throw validationError('variables array is required');
    }

    const now = new Date().toISOString();
    transaction(() => {
      execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ?', 'environment', env.id);
      for (const v of variables) {
        execute(`
          INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
          VALUES (?, 'environment', ?, ?, ?, ?, ?, ?)
        `, `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, env.id, v.key, v.value, v.secret ? 1 : 0, now, now);
      }
    });

    const rows = queryAll('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? ORDER BY key ASC', 'environment', env.id);
    return res.json({ data: rows.map(mapVariable) });
  } catch (err) {
    next(err);
  }
});

// GET /environments/:environmentId/logs
router.get('/:environmentId/logs', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const limit = parseInt(req.query.limit || '100', 10);
  const cursor = req.query.cursor;
  const serviceId = req.query.serviceId ? (Array.isArray(req.query.serviceId) ? req.query.serviceId : [req.query.serviceId]) : null;
  const level = req.query.level ? (Array.isArray(req.query.level) ? req.query.level : [req.query.level]) : null;
  const q = req.query.q || null;

  const page = logManager.getEnvironmentLogs(env.id, { limit, cursor, serviceId, level, q });
  return res.json(page);
});

// GET /environments/:environmentId/logs/stream (SSE)
router.get('/:environmentId/logs/stream', (req, res) => {
  const env = getEnvironment(req.params.environmentId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const onLog = (logLine) => {
    res.write(`event: line\n`);
    res.write(`data: ${JSON.stringify(logLine)}\n\n`);
  };

  eventBus.on(`environment:${env.id}:log`, onLog);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.off(`environment:${env.id}:log`, onLog);
  });
});

// GET /environments/:environmentId/metrics
router.get('/:environmentId/metrics', (req, res) => {
  const env = getEnvironment(req.params.environmentId);
  const range = req.query.range || '1h';
  const serviceId = req.query.serviceId || null;
  const metricNames = req.query.names ? (Array.isArray(req.query.names) ? req.query.names : [req.query.names]) : null;

  const result = metricsCollector.getEnvironmentMetrics(env.id, range, serviceId, metricNames);
  return res.json(result);
});

// Nested staged-changes routes
router.use('/:envId/staged-changes', stagedChangesRouter);

export default router;
