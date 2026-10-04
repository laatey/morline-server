import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapService, mapServiceDetail, mapDeployment, mapDomain, mapVariable, mapVolume } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, conflict, validationError } from '../middleware/error-handler.js';
import { containerSupervisor } from '../engine/container-supervisor.js';
import { buildManager } from '../engine/build-manager.js';
import { metricsCollector } from '../engine/metrics-collector.js';
import { eventBus } from '../engine/event-bus.js';
import { reviveFromStop } from '../engine/service-lifecycle.js';
import { BASE_DOMAIN } from '../config.js';
import { clearStagedChanges, createStagedChange, syncConnectionsWithVariables } from '../services/staged-changes-helper.js';

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
    privateEndpoint: `${service.name}.morline.internal:${networking?.target_port || service.port || 3000}`,
    publicEndpoints: domains.map(d => `https://${d.host}`),
    dependencies: deps.map(d => ({ id: d.id, name: d.name, logo: d.logo, status: d.status, via: d.via })),
    consumers: consumers.map(c => ({ id: c.id, name: c.name, logo: c.logo, status: c.status, via: c.via }))
  };

  const mappedSettings = settings ? {
    branch: settings.branch || 'main',
    rootDirectory: settings.root_directory || null,
    basePath: settings.base_path || null,
    autoDeploy: Boolean(settings.auto_deploy),
    buildCommand: settings.build_command || null,
    startCommand: settings.start_command || 'node server.js',
    runtimeVersion: settings.runtime_version || null,
    dockerfilePath: settings.dockerfile_path || null,
    healthcheckPath: settings.healthcheck_path || '/',
    healthcheckTimeoutSec: Number(settings.healthcheck_timeout_sec || 30),
    restartPolicy: settings.restart_policy || 'on-failure',
    replicas: Number(settings.replicas ?? 1),
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
      if (settings.basePath !== undefined) { sUpdates.push('base_path = ?'); sParams.push(settings.basePath); }
      if (settings.autoDeploy !== undefined) { sUpdates.push('auto_deploy = ?'); sParams.push(settings.autoDeploy ? 1 : 0); }
      if (settings.buildCommand !== undefined) { sUpdates.push('build_command = ?'); sParams.push(settings.buildCommand); }
      if (settings.startCommand !== undefined) { sUpdates.push('start_command = ?'); sParams.push(settings.startCommand); }
      if (settings.runtimeVersion !== undefined) { sUpdates.push('runtime_version = ?'); sParams.push(settings.runtimeVersion); }
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

    if (updates.length > 0 || settings) {
      createStagedChange({
        environmentId: service.environment_id,
        serviceId: service.id,
        serviceName: service.name,
        type: 'settings',
        summary: `Updated service settings/configuration`,
        payload: { action: 'update' }
      });
    }

    return res.json(detail);
  } catch (err) {
    next(err);
  }
});

// DELETE /services/:serviceId
router.delete('/services/:serviceId', async (req, res) => {
  const service = getService(req.params.serviceId);
  await containerSupervisor.stopService(service.id, true);
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
    reviveFromStop(service.id, { reviveDeployment: true });
    execute('UPDATE services SET status = ? WHERE id = ?', 'deploying', service.id);

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'service.status',
      at: new Date().toISOString(),
      actorId: req.user.id,
      canvasRevision: null,
      data: { id: service.id, status: 'deploying' }
    });

    containerSupervisor.restartService(service.id).catch(err => {
      console.error('[Restart Error]', err);
    });

    const updated = queryOne('SELECT * FROM services WHERE id = ?', service.id);
    return res.status(202).json(mapService(updated));
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/stop
// Stops the running deployment and sets replicas to 0. Every setting, variable, domain and
// volume is kept, and restart / wake / a new deployment bring the service back.
router.post('/services/:serviceId/stop', async (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    if (service.status === 'stopped') return res.json(mapService(service)); // already stopped

    const everDeployed = queryOne('SELECT 1 AS found FROM deployments WHERE service_id = ? LIMIT 1', service.id);
    if (!everDeployed) throw conflict('This service has not been deployed yet, so there is nothing to stop', 'not_deployed');

    // End an in-flight build first and wait for it, so it cannot overwrite the status below.
    const run = buildManager.active.get(service.id);
    if (buildManager.cancel(service.id) && run?.done) {
      await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 15000))]);
    }
    await containerSupervisor.stopService(service.id, false);

    const at = new Date().toISOString();
    const current = queryOne('SELECT * FROM services WHERE id = ?', service.id);
    const retired = current.active_deployment_id
      ? queryOne("SELECT id FROM deployments WHERE id = ? AND state = 'active'", current.active_deployment_id) : null;

    transaction(() => {
      execute(`UPDATE services SET status = 'stopped', replicas = 0, building_deployment_id = NULL,
        replicas_before_stop = CASE WHEN replicas > 0 THEN replicas ELSE replicas_before_stop END WHERE id = ?`, service.id);
      execute('UPDATE service_settings SET replicas = 0 WHERE service_id = ?', service.id);
      if (retired) execute("UPDATE deployments SET state = 'removed' WHERE id = ?", retired.id);
    });

    const emit = (type, data) => eventBus.emitEnvironmentEvent(service.environment_id, {
      type, at, actorId: req.user.id, canvasRevision: null, data
    });
    if (retired) emit('deployment.updated', { id: retired.id, state: 'removed' });
    emit('service.status', { id: service.id, status: 'stopped' });

    return res.json(mapService(queryOne('SELECT * FROM services WHERE id = ?', service.id)));
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/sleep
router.post('/services/:serviceId/sleep', async (req, res) => {
  const service = getService(req.params.serviceId);
  await containerSupervisor.stopService(service.id, true);
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
    reviveFromStop(service.id);
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
        VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, newId, service.environment_id, newName, service.kind, service.logo, posX, posY,
        service.source_type, service.source_repo, service.source_branch, service.source_root_dir,
        service.source_image, service.source_template_id, service.source_display, service.region, Math.max(1, Number(service.replicas) || 1), now, now);

      const origSettings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', service.id);
      if (origSettings) {
        execute(`
          INSERT INTO service_settings (service_id, branch, root_directory, auto_deploy, build_command, start_command, healthcheck_path, healthcheck_timeout_sec, restart_policy, replicas)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, newId, origSettings.branch, origSettings.root_directory, origSettings.auto_deploy,
          origSettings.build_command, origSettings.start_command, origSettings.healthcheck_path,
          origSettings.healthcheck_timeout_sec, origSettings.restart_policy, Math.max(1, Number(origSettings.replicas) || 1));
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

    // A manual redeploy applies the current service configuration, so its pending
    // changes should no longer appear as unapplied in the environment.
    clearStagedChanges(service.environment_id, service.id);

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
    privateHostname: `${service.name}.morline.internal`,
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
    privateHostname: `${service.name}.morline.internal`,
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
    createStagedChange({
      environmentId: service.environment_id,
      serviceId: service.id,
      serviceName: service.name,
      type: 'variable',
      summary: `Updated ${variables.length} variable${variables.length !== 1 ? 's' : ''} (bulk replace)`,
      payload: { action: 'bulk_replace' }
    });
    syncConnectionsWithVariables(service.environment_id, service.id);
    return res.json({ data: rows.map(mapVariable) });
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/variables (append / upsert)
router.post('/services/:serviceId/variables', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    let { variables } = req.body || {};
    if (!variables && req.body?.key) {
      variables = [{ key: req.body.key, value: req.body.value, secret: req.body.secret }];
    }
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

    syncConnectionsWithVariables(service.environment_id, service.id);
    const rows = queryAll('SELECT * FROM variables WHERE scope_type = ? AND scope_id = ? ORDER BY key ASC', 'service', service.id);
    createStagedChange({
      environmentId: service.environment_id,
      serviceId: service.id,
      serviceName: service.name,
      type: 'variable',
      summary: `Added/updated ${variables.length} variable${variables.length !== 1 ? 's' : ''}`,
      payload: { action: 'upsert', keys: variables.map(v => v.key) }
    });
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

    syncConnectionsWithVariables(service.environment_id, service.id);
    const updated = queryOne('SELECT * FROM variables WHERE id = ?', existing.id);
    createStagedChange({
      environmentId: service.environment_id,
      serviceId: service.id,
      serviceName: service.name,
      type: 'variable',
      summary: `Updated variable ${key}`,
      payload: { action: 'upsert', key }
    });
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
  syncConnectionsWithVariables(service.environment_id, service.id);
  createStagedChange({
    environmentId: service.environment_id,
    serviceId: service.id,
    serviceName: service.name,
    type: 'variable',
    summary: `Deleted variable ${key}`,
    payload: { action: 'delete', key }
  });
  return res.status(204).end();
});

// GET /services/:serviceId/variables/suggestions
router.get('/services/:serviceId/variables/suggestions', async (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);

    // Need source repo to fetch .env.example
    if (!service.source_repo) {
      return res.json({ data: [] });
    }

    const cleanRepo = service.source_repo.replace(/\.git$/, '');
    const branch = service.source_branch || 'main';

    // Try to get a token for this repo
    const { getRepoInstallationToken } = await import('../services/github-app.js');
    const { GITHUB_TOKEN } = await import('../config.js');
    const [owner, repoName] = cleanRepo.includes('/') ? cleanRepo.split('/') : [null, cleanRepo];
    let token = GITHUB_TOKEN;
    if (owner && repoName) {
      const instToken = await getRepoInstallationToken(owner, repoName);
      if (instToken) token = instToken;
    }

    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Morline-App',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    // Try candidate filenames
    const candidates = ['.env.example', '.env.sample', '.env.template', 'example.env', '.env.defaults'];
    let envContent = null;
    let foundSource = '.env.example';

    for (const filename of candidates) {
      const url = `https://api.github.com/repos/${cleanRepo}/contents/${filename}?ref=${branch}`;
      try {
        const r = await fetch(url, { headers });
        if (r.ok) {
          const data = await r.json();
          if (data.content) {
            envContent = Buffer.from(data.content, 'base64').toString('utf-8');
            foundSource = filename;
            break;
          }
        }
      } catch (e) {}
    }

    // Also check local repo clone workspace if exists
    if (!envContent) {
      const { APPS_DIR } = await import('../config.js');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const localAppDir = path.join(APPS_DIR, service.id);
      for (const filename of candidates) {
        const localPath = path.join(localAppDir, filename);
        if (fs.existsSync(localPath)) {
          try {
            envContent = fs.readFileSync(localPath, 'utf-8');
            foundSource = filename;
            break;
          } catch (e) {}
        }
      }
    }

    if (!envContent) {
      return res.json({ data: [] });
    }

    // Parse .env format
    const suggestions = [];
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!key) continue;
      suggestions.push({
        key,
        value: value || null,
        secret: /password|secret|key|token|api_key|private|auth/i.test(key),
        source: foundSource
      });
    }

    // Filter out keys already set
    const existingKeys = new Set(
      queryAll('SELECT key FROM variables WHERE scope_type = ? AND scope_id = ?', 'service', service.id).map(v => v.key)
    );

    // Filter out dismissed keys
    const dismissedKeys = new Set(
      queryAll('SELECT key FROM variable_suggestion_dismissals WHERE service_id = ?', service.id).map(d => d.key)
    );

    const filtered = suggestions.filter(s => !existingKeys.has(s.key) && !dismissedKeys.has(s.key));

    return res.json({ data: filtered });
  } catch (err) {
    next(err);
  }
});

// POST /services/:serviceId/variables/suggestions/dismiss
router.post('/services/:serviceId/variables/suggestions/dismiss', (req, res, next) => {
  try {
    const service = getService(req.params.serviceId);
    const { keys } = req.body || {};
    if (!Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ code: 'validation_failed', message: 'keys array is required' });
    }

    const now = new Date().toISOString();
    for (const key of keys) {
      execute(`
        INSERT INTO variable_suggestion_dismissals (service_id, key, dismissed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(service_id, key) DO UPDATE SET dismissed_at = excluded.dismissed_at
      `, service.id, key, now);
    }

    return res.json({ dismissed: keys.length });
  } catch (err) {
    next(err);
  }
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
      previewValue: `http://${s.name}.morline.internal:3000`
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

// ---------------------------------------------------------------------------
// Database stubs (not implemented — return zero values)
// ---------------------------------------------------------------------------

// GET /services/:serviceId/database/collections
router.get('/services/:serviceId/database/collections', (req, res) => {
  getService(req.params.serviceId); // 404 if not found
  return res.json({ data: [] });
});

// GET /services/:serviceId/database/collections/:name
router.get('/services/:serviceId/database/collections/:name', (req, res) => {
  getService(req.params.serviceId);
  return res.json({ data: [] });
});

// GET /services/:serviceId/database/connection
router.get('/services/:serviceId/database/connection', (req, res) => {
  getService(req.params.serviceId);
  return res.json({
    host: null,
    port: null,
    user: null,
    password: null,
    database: null,
    url: null,
    publicUrl: null
  });
});

// ---------------------------------------------------------------------------
// Backup stubs (not implemented — return zero values)
// ---------------------------------------------------------------------------

// GET /services/:serviceId/backups
router.get('/services/:serviceId/backups', (req, res) => {
  getService(req.params.serviceId);
  return res.json({ data: [] });
});

// POST /services/:serviceId/backups
router.post('/services/:serviceId/backups', (req, res) => {
  getService(req.params.serviceId);
  const id = `bkp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return res.status(202).json({
    id,
    createdAt: new Date().toISOString(),
    size: null,
    status: 'pending',
    kind: 'manual'
  });
});

// POST /services/:serviceId/backups/:backupId/restore
router.post('/services/:serviceId/backups/:backupId/restore', (req, res) => {
  getService(req.params.serviceId);
  return res.status(202).json({ status: 'pending', backupId: req.params.backupId });
});

export default router;
