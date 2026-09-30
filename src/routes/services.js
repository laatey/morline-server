import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapService, mapServiceDetail, mapDeployment, mapDomain, mapVariable, mapVolume } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict, validationError } from '../middleware/error-handler.js';
import { processSupervisor } from '../engine/process-supervisor.js';
import { buildManager } from '../engine/build-manager.js';
import { metricsCollector } from '../engine/metrics-collector.js';
import { eventBus } from '../engine/event-bus.js';
import { BASE_DOMAIN } from '../config.js';

const router = Router();
router.use('/services', requireAuth);
router.use('/volumes', requireAuth);

function getService(serviceId) {
  const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service) throw notFound('Service not found');
  return service;
}

function getServiceDetail(service) {
  const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', service.id);
  const networking = queryOne('SELECT * FROM service_networking WHERE service_id = ?', service.id);
  const activeDep = service.active_deployment_id ? queryOne('SELECT * FROM deployments WHERE id = ?', service.active_deployment_id) : null;
  const buildingDep = service.building_deployment_id ? queryOne('SELECT * FROM deployments WHERE id = ?', service.building_deployment_id) : null;
  const volumeRow = queryOne('SELECT * FROM volumes WHERE service_id = ? LIMIT 1', service.id);

  const deps = queryAll(`
    SELECT s.id, s.name, s.logo, s.status, c.label as via
    FROM connections c
    JOIN services s ON s.id = c.to_service_id
    WHERE c.from_service_id = ?
  `, service.id);

  const consumers = queryAll(`
    SELECT s.id, s.name, s.logo, s.status, c.label as via
    FROM connections c
    JOIN services s ON s.id = c.from_service_id
    WHERE c.to_service_id = ?
  `, service.id);

  const domains = queryAll('SELECT host FROM domains WHERE service_id = ?', service.id);

  const baseService = mapService(service, {
    activeDeployment: activeDep ? mapDeployment(activeDep) : null,
    buildingDeployment: buildingDep ? mapDeployment(buildingDep) : null,
    volume: volumeRow ? mapVolume(volumeRow) : null
  });

  const topology = {
    privateEndpoint: `${service.name}.moorline.internal:${networking?.target_port || service.port || 3000}`,
    publicEndpoints: domains.map(d => `https://${d.host}`),
    dependencies: deps.map(d => ({ id: d.id, name: d.name, logo: d.logo, status: d.status, via: d.via })),
    consumers: consumers.map(c => ({ id: c.id, name: c.name, logo: c.logo, status: c.status, via: c.via }))
  };

  const mappedSettings = settings ? {
    branch: settings.branch || 'main',
    rootDirectory: settings.root_directory || null,
    autoDeploy: Boolean(settings.auto_deploy),
    buildCommand: settings.build_command || null,
    startCommand: settings.start_command || 'node server.js',
    dockerfilePath: settings.dockerfile_path || null,
    healthcheckPath: settings.healthcheck_path || '/',
    healthcheckTimeoutSec: Number(settings.healthcheck_timeout_sec || 30),
    restartPolicy: settings.restart_policy || 'on-failure',
    replicas: Number(settings.replicas || 1),
    cronSchedule: settings.cron_schedule || null,
    sleepAfterMinutes: settings.sleep_after_minutes ? Number(settings.sleep_after_minutes) : null,
    cpuLimit: settings.cpu_limit ? Number(settings.cpu_limit) : null,
    memoryLimitMb: settings.memory_limit_mb ? Number(settings.memory_limit_mb) : null
  } : null;

  return mapServiceDetail(baseService, mappedSettings, topology);
}

// GET /services/:serviceId
router.get('/services/:serviceId', (req, res) => {
  const service = getService(req.params.serviceId);
  return res.json(getServiceDetail(service));
});

// PATCH /services/:serviceId
router.patch('/services/:serviceId', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { name, logo, source, settings } = req.body || {};

    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }
    if (logo) {
      updates.push('logo = ?');
      params.push(logo);
    }
    if (source) {
      if (source.repo) { updates.push('source_repo = ?'); params.push(source.repo); }
      if (source.branch) { updates.push('source_branch = ?'); params.push(source.branch); }
      if (source.rootDirectory) { updates.push('source_root_dir = ?'); params.push(source.rootDirectory); }
      if (source.image) { updates.push('source_image = ?'); params.push(source.image); }
      if (source.display) { updates.push('source_display = ?'); params.push(source.display); }
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(service.id);
      execute(`UPDATE services SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    if (settings) {
      const sUpdates = [];
      const sParams = [];

      if (settings.branch !== undefined) { sUpdates.push('branch = ?'); sParams.push(settings.branch); }
      if (settings.rootDirectory !== undefined) { sUpdates.push('root_directory = ?'); sParams.push(settings.rootDirectory); }
      if (settings.autoDeploy !== undefined) { sUpdates.push('auto_deploy = ?'); sParams.push(settings.autoDeploy ? 1 : 0); }
      if (settings.buildCommand !== undefined) { sUpdates.push('build_command = ?'); sParams.push(settings.buildCommand); }
      if (settings.startCommand !== undefined) { sUpdates.push('start_command = ?'); sParams.push(settings.startCommand); }
      if (settings.dockerfilePath !== undefined) { sUpdates.push('dockerfile_path = ?'); sParams.push(settings.dockerfilePath); }
      if (settings.healthcheckPath !== undefined) { sUpdates.push('healthcheck_path = ?'); sParams.push(settings.healthcheckPath); }
      if (settings.healthcheckTimeoutSec !== undefined) { sUpdates.push('healthcheck_timeout_sec = ?'); sParams.push(settings.healthcheckTimeoutSec); }
      if (settings.restartPolicy !== undefined) { sUpdates.push('restart_policy = ?'); sParams.push(settings.restartPolicy); }
      if (settings.replicas !== undefined) { sUpdates.push('replicas = ?'); sParams.push(settings.replicas); }

      if (sUpdates.length > 0) {
        sParams.push(service.id);
        execute(`UPDATE service_settings SET ${sUpdates.join(', ')} WHERE service_id = ?`, ...sParams);
      }
    }

    const updated = queryOne('SELECT * FROM services WHERE id = ?', service.id);
    const detail = getServiceDetail(updated);

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'service.updated',
      at: new Date().toISOString(),
      actorId: req.user.id,
      canvasRevision: null,
      data: detail
    });

    return res.json(detail);
  } catch (err) {
    next(err);
  }
});

// DELETE /services/:serviceId
router.delete('/services/:serviceId', async (req, res) => {
  const service = getService(req.params.serviceId);
  await processSupervisor.stopService(service.id, true);
  execute('DELETE FROM services WHERE id = ?', service.id);

  eventBus.emitEnvironmentEvent(service.environment_id, {
    type: 'service.deleted',
    at: new Date().toISOString(),
    actorId: req.user.id,
    canvasRevision: null,
    data: { id: service.id }
  });

  return res.status(204).end();
});

// POST /services/:serviceId/restart
router.post('/services/:serviceId/restart', async (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    execute('UPDATE services SET status = ? WHERE id = ?', 'deploying', service.id);

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'service.status',
      at: new Date().toISOString(),
      actorId: req.user.id,
      canvasRevision: null,
      data: { id: service.id, status: 'deploying' }
    });

    processSupervisor.restartService(service.id).catch(err => {
      console.error('[Restart Error]', err);
    });

    const updated = queryOne('SELECT * FROM services WHERE id = ?', service.id);
    return res.status(202).json(mapService(updated));
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/sleep
router.post('/services/:serviceId/sleep', async (req, res) => {
  const service = getService(req.params.serviceId);
  await processSupervisor.stopService(service.id, true);
  execute('UPDATE services SET status = ? WHERE id = ?', 'sleeping', service.id);

  eventBus.emitEnvironmentEvent(service.environment_id, {
    type: 'service.status',
    at: new Date().toISOString(),
    actorId: req.user.id,
    canvasRevision: null,
    data: { id: service.id, status: 'sleeping' }
  });

  const updated = queryOne('SELECT * FROM services WHERE id = ?', service.id);
  return res.json(mapService(updated));
});

// POST /services/:serviceId/wake
router.post('/services/:serviceId/wake', async (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    execute('UPDATE services SET status = ? WHERE id = ?', 'deploying', service.id);

    const depId = service.active_deployment_id || `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    buildManager.buildAndDeploy(service.id, depId).catch(err => {
      console.error('[Wake Error]', err);
    });

    const updated = queryOne('SELECT * FROM services WHERE id = ?', service.id);
    return res.json(mapService(updated));
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/duplicate
router.post('/services/:serviceId/duplicate', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { name, position } = req.body || {};

    const newId = `srv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const newName = name || `${service.name}-copy`;
    const posX = position?.x ?? (service.position_x + 40);
    const posY = position?.y ?? (service.position_y + 40);
    const now = new Date().toISOString();

    transaction(() => {
      execute(`
        INSERT INTO services (id, environment_id, name, kind, logo, status, position_x, position_y, source_type, source_repo, source_branch, source_root_dir, source_image, source_template_id, source_display, region, replicas, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, newId, service.environment_id, newName, service.kind, service.logo, posX, posY,
        service.source_type, service.source_repo, service.source_branch, service.source_root_dir,
        service.source_image, service.source_template_id, service.source_display, service.region, service.replicas, now, now);

      const origSettings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', service.id);
      if (origSettings) {
        execute(`
          INSERT INTO service_settings (service_id, branch, root_directory, auto_deploy, build_command, start_command, healthcheck_path, healthcheck_timeout_sec, restart_policy, replicas)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, newId, origSettings.branch, origSettings.root_directory, origSettings.auto_deploy,
          origSettings.build_command, origSettings.start_command, origSettings.healthcheck_path,
          origSettings.healthcheck_timeout_sec, origSettings.restart_policy, origSettings.replicas);
      }

      execute(`
        INSERT INTO service_networking (service_id, public, target_port)
        VALUES (?, 1, 3000)
      `, newId);
    });

    const newRow = queryOne('SELECT * FROM services WHERE id = ?', newId);
    const mapped = mapService(newRow);

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'service.created',
      at: now,
      actorId: req.user.id,
      canvasRevision: null,
      data: mapped
    });

    return res.status(201).json(mapped);
  } catch (err) {
    next(err);
  }
});

// GET /services/:serviceId/deployments
router.get('/services/:serviceId/deployments', (req, res) => {
  const service = getService(req.params.serviceId);
  const limit = parseInt(req.query.limit || '20', 10);
  const cursor = req.query.cursor;

  let sql = 'SELECT * FROM deployments WHERE service_id = ?';
  const params = [service.id];

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

// POST /services/:serviceId/deployments
router.post('/services/:serviceId/deployments', async (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const depId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, created_by, created_at)
      VALUES (?, ?, ?, ?, 'queued', 'manual', ?, ?)
    `, depId, service.id, service.name, service.environment_id, req.user.id, now);

    buildManager.buildAndDeploy(service.id, depId).catch(err => {
      console.error('[Deploy Error]', err);
    });

    const depRow = queryOne('SELECT * FROM deployments WHERE id = ?', depId);
    return res.status(202).json(mapDeployment(depRow));
  } catch (err) {
    next(err);
  }
});

// GET /services/:serviceId/networking
router.get('/services/:serviceId/networking', (req, res) => {
  const service = getService(req.params.serviceId);
  const net = queryOne('SELECT * FROM service_networking WHERE service_id = ?', service.id);
  const domainRows = queryAll('SELECT * FROM domains WHERE service_id = ?', service.id);

  return res.json({
    public: net ? Boolean(net.public) : true,
    targetPort: net?.target_port || service.port || 3000,
    domains: domainRows.map(mapDomain),
    privateHostname: `${service.name}.moorline.internal`,
    privatePort: net?.private_port || service.port || 3000
  });
});

// PATCH /services/:serviceId/networking
router.patch('/services/:serviceId/networking', (req, res) => {
  const service = getService(req.params.serviceId);
  const { targetPort, public: isPublic } = req.body || {};

  const updates = [];
  const params = [];

  if (targetPort !== undefined) {
    updates.push('target_port = ?');
    params.push(targetPort);
  }
  if (isPublic !== undefined) {
    updates.push('public = ?');
    params.push(isPublic ? 1 : 0);
  }

  if (updates.length > 0) {
    params.push(service.id);
    execute(`UPDATE service_networking SET ${updates.join(', ')} WHERE service_id = ?`, ...params);
  }

  const net = queryOne('SELECT * FROM service_networking WHERE service_id = ?', service.id);
  const domainRows = queryAll('SELECT * FROM domains WHERE service_id = ?', service.id);

  return res.json({
    public: net ? Boolean(net.public) : true,
    targetPort: net?.target_port || 3000,
    domains: domainRows.map(mapDomain),
    privateHostname: `${service.name}.moorline.internal`,
    privatePort: net?.private_port || 3000
  });
});

// POST /services/:serviceId/domains
router.post('/services/:serviceId/domains', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { kind = 'custom', host, targetPort = 3000 } = req.body || {};

    let cleanHost = '';
    let domainKind = 'custom';
    let status = 'active';

    if (kind === 'generated' || !host) {
      domainKind = 'generated';
      cleanHost = `${service.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${service.id.slice(-6)}.${BASE_DOMAIN}`;
      status = 'active';
    } else {
      domainKind = 'custom';
      cleanHost = host.toLowerCase().trim();
      status = 'pending';
    }

    const existing = queryOne('SELECT id FROM domains WHERE host = ?', cleanHost);
    if (existing) throw conflict('Domain already registered', 'domain_taken');

    const domainId = `dom_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    const dnsRecords = JSON.stringify([
      { type: 'CNAME', name: cleanHost, value: `edge.${BASE_DOMAIN}`, verified: domainKind === 'generated' }
    ]);

    transaction(() => {
      execute(`
        INSERT INTO domains (id, environment_id, service_id, service_name, host, kind, status, target_port, tls_configured, dns_records, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `, domainId, service.environment_id, service.id, service.name, cleanHost, domainKind, status, targetPort, dnsRecords, now);

      if (!service.primary_domain) {
        execute('UPDATE services SET primary_domain = ? WHERE id = ?', cleanHost, service.id);
      }
    });

    const row = queryOne('SELECT * FROM domains WHERE id = ?', domainId);
    const mapped = mapDomain(row);

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'domain.updated',
      at: now,
      actorId: req.user.id,
      canvasRevision: null,
      data: mapped
    });

    return res.status(201).json(mapped);
  } catch (err) {
    next(err);
  }
});

// GET /services/:serviceId/variables
router.get('/services/:serviceId/variables', (req, res) => {
  const service = getService(req.params.serviceId);
  const rows = queryAll('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? ORDER BY key ASC', 'service', service.id);
  return res.json({ data: rows.map(mapVariable) });
});

// PUT /services/:serviceId/variables (bulk replace)
router.put('/services/:serviceId/variables', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { variables } = req.body || {};
    if (!Array.isArray(variables)) throw validationError('variables array is required');

    const now = new Date().toISOString();
    transaction(() => {
      execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ?', 'service', service.id);
      for (const v of variables) {
        execute(`
          INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
          VALUES (?, 'service', ?, ?, ?, ?, ?, ?)
        `, `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, service.id, v.key, v.value, v.secret ? 1 : 0, now, now);
      }
    });

    const rows = queryAll('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? ORDER BY key ASC', 'service', service.id);
    return res.json({ data: rows.map(mapVariable) });
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/variables (append / upsert)
router.post('/services/:serviceId/variables', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { variables } = req.body || {};
    if (!Array.isArray(variables)) throw validationError('variables array is required');

    const now = new Date().toISOString();
    transaction(() => {
      for (const v of variables) {
        execute(`
          INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
          VALUES (?, 'service', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope_type, scope_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at
        `, `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, service.id, v.key, v.value, v.secret ? 1 : 0, now, now);
      }
    });

    const rows = queryAll('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? ORDER BY key ASC', 'service', service.id);
    return res.json({ data: rows.map(mapVariable) });
  } catch (err) {
    next(err);
  }
});

// PATCH /services/:serviceId/variables/:key
router.patch('/services/:serviceId/variables/:key', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const key = req.params.key;
    const { value, secret } = req.body || {};

    const existing = queryOne('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? AND key = ?', 'service', service.id, key);
    if (!existing) throw notFound('Variable not found');

    const newVal = value !== undefined ? value : existing.value;
    const newSec = secret !== undefined ? (secret ? 1 : 0) : existing.secret;
    const now = new Date().toISOString();

    execute('UPDATE variables SET value = ?, secret = ?, updated_at = ? WHERE id = ?', newVal, newSec, now, existing.id);

    const updated = queryOne('SELECT * FROM variables WHERE id = ?', existing.id);
    return res.json(mapVariable(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /services/:serviceId/variables/:key
router.delete('/services/:serviceId/variables/:key', (req, res) => {
  const service = getService(req.params.serviceId);
  const key = req.params.key;
  execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ? AND key = ?', 'service', service.id, key);
  return res.status(204).end();
});

// GET /services/:serviceId/variables/references
router.get('/services/:serviceId/variables/references', (req, res) => {
  const service = getService(req.params.serviceId);

  // Available service variables in this environment that can be referenced
  const otherServices = queryAll('SELECT id, name FROM services WHERE environment_id = ? AND id != ?', service.environment_id, service.id);
  const references = [];

  for (const s of otherServices) {
    references.push({
      serviceId: s.id,
      serviceName: s.name,
      variableName: `${s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`,
      previewValue: `http://${s.name}.moorline.internal:3000`
    });
  }

  return res.json({ data: references });
});

// GET /services/:serviceId/volumes
router.get('/services/:serviceId/volumes', (req, res) => {
  const service = getService(req.params.serviceId);
  const rows = queryAll('SELECT * FROM volumes WHERE service_id = ?', service.id);
  return res.json({ data: rows.map(mapVolume) });
});

// POST /services/:serviceId/volumes
router.post('/services/:serviceId/volumes', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { name, mountPath, sizeGb = 1.0 } = req.body || {};

    if (!name || !mountPath) throw validationError('name and mountPath are required');

    const volId = `vol_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO volumes (id, service_id, name, mount_path, size_gb, used_gb, created_at)
      VALUES (?, ?, ?, ?, ?, 0.0, ?)
    `, volId, service.id, name, mountPath, sizeGb, now);

    const row = queryOne('SELECT * FROM volumes WHERE id = ?', volId);
    return res.status(201).json(mapVolume(row));
  } catch (err) {
    next(err);
  }
});

// GET /services/:serviceId/metrics
router.get('/services/:serviceId/metrics', (req, res) => {
  const service = getService(req.params.serviceId);
  const range = req.query.range || '1h';
  const metricNames = req.query.names ? (Array.isArray(req.query.names) ? req.query.names : [req.query.names]) : null;

  const result = metricsCollector.getServiceMetrics(service.id, range, metricNames);
  return res.json(result);
});

// PATCH /volumes/:volumeId
router.patch('/volumes/:volumeId', (req, res, next) => {
  try {
    const volId = req.params.volumeId;
    const vol = queryOne('SELECT * FROM volumes WHERE id = ?', volId);
    if (!vol) throw notFound('Volume not found');

    const { sizeGb } = req.body || {};
    if (sizeGb !== undefined) {
      execute('UPDATE volumes SET size_gb = ? WHERE id = ?', sizeGb, volId);
    }

    const updated = queryOne('SELECT * FROM volumes WHERE id = ?', volId);
    return res.json(mapVolume(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /volumes/:volumeId
router.delete('/volumes/:volumeId', (req, res) => {
  const volId = req.params.volumeId;
  execute('DELETE FROM volumes WHERE id = ?', volId);
  return res.status(204).end();
});

export default router;
