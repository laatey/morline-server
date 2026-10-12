import crypto from 'node:crypto';
import { execute, queryOne, transaction } from '../db/index.js';
import { mapService } from '../db/mappers.js';
import { eventBus } from '../engine/event-bus.js';
import { buildManager } from '../engine/build-manager.js';

const rid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Create a service that builds from a GitHub repo. Returns the service row. */
export function createRepoService({ environmentId, name, repo, branch, port = 3000, variables = [] }) {
  const env = queryOne('SELECT * FROM environments WHERE id = ?', environmentId);
  if (!env) throw new Error('The environment for this app no longer exists');

  let serviceName = name;
  for (let i = 2; queryOne('SELECT 1 AS x FROM services WHERE environment_id = ? AND name = ?', environmentId, serviceName); i++) {
    serviceName = `${name}-${i}`;
  }
  const count = queryOne('SELECT COUNT(*) AS c FROM services WHERE environment_id = ?', environmentId)?.c || 0;
  const serviceId = rid('srv');
  const now = new Date().toISOString();

  transaction(() => {
    execute(`
      INSERT INTO services (id, environment_id, name, kind, logo, status, position_x, position_y, source_type, source_repo, source_branch, source_display, region, replicas, created_at, updated_at)
      VALUES (?, ?, ?, 'app', 'js', 'created', ?, ?, 'github', ?, ?, ?, 'us-east-1', 1, ?, ?)
    `, serviceId, environmentId, serviceName, 100 + (count % 4) * 280, 100 + Math.floor(count / 4) * 200, repo, branch, repo, now, now);
    execute(`
      INSERT INTO service_settings (service_id, branch, auto_deploy, healthcheck_path, healthcheck_timeout_sec, restart_policy, replicas)
      VALUES (?, ?, 1, '/health', 30, 'on-failure', 1)
    `, serviceId, branch);
    execute('INSERT INTO service_networking (service_id, public, target_port) VALUES (?, 1, ?)', serviceId, port);
    for (const v of variables) {
      execute(`
        INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
        VALUES (?, 'service', ?, ?, ?, ?, ?, ?)
      `, rid('var'), serviceId, v.key, v.value, v.secret ? 1 : 0, now, now);
    }
  });

  const row = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  eventBus.emitEnvironmentEvent(environmentId, {
    type: 'service.created', at: now, actorId: null, canvasRevision: env.canvas_revision, data: mapService(row)
  });
  return row;
}

/** Queue and start a deployment. Returns the deployment id. */
export function startDeployment({ serviceId, userId = null, commitSha = null, message = null, branch = null }) {
  const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service) throw new Error('Service not found');
  const id = rid('dep');
  execute(`
    INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, commit_sha, commit_message, commit_branch, created_by, created_at)
    VALUES (?, ?, ?, ?, 'queued', 'assistant', ?, ?, ?, ?, ?)
  `, id, serviceId, service.name, service.environment_id, commitSha, message, branch, userId, new Date().toISOString());
  buildManager.buildAndDeploy(serviceId, id).catch((err) => console.error('[Assistant deploy]', err.message));
  return id;
}
