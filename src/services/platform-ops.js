import crypto from 'node:crypto';
import { execute, queryOne, transaction } from '../db/index.js';
import { BASE_DOMAIN } from '../config.js';
import { mapDomain } from '../db/mappers.js';
import { eventBus } from '../engine/event-bus.js';
import { containerSupervisor } from '../engine/container-supervisor.js';
import { startDeployment } from './service-factory.js';
import { provisionAddon, removeAddon, ADDON_KINDS } from './addons.js';

/** What the assistant can do to a service besides change its code. Each is one reviewable action. */
export const PLATFORM_OPS = ['expose', 'redeploy', 'restart', 'add_database'];

const DEFAULT_ENV = { postgres: 'DATABASE_URL', mongodb: 'MONGODB_URL', redis: 'REDIS_URL' };
const KIND_NAME = { postgres: 'PostgreSQL', mongodb: 'MongoDB', redis: 'Redis' };

export function describeOp({ op, kind, env }, serviceName) {
  switch (op) {
    case 'expose': return { title: `Make ${serviceName} public`, description: 'Gives it a public https URL', reversible: true };
    case 'redeploy': return { title: `Redeploy ${serviceName}`, description: 'Builds and deploys the latest code again', reversible: false };
    case 'restart': return { title: `Restart ${serviceName}`, description: 'Restarts the running container', reversible: false };
    case 'add_database': return {
      title: `Add ${KIND_NAME[kind] || kind} to ${serviceName}`,
      description: `Creates the database and connects it as ${env || DEFAULT_ENV[kind]}, then redeploys`,
      reversible: true
    };
    default: throw new Error(`Unknown operation: ${op}`);
  }
}

export const normalizeOp = (op) => ({
  ...op,
  ...(op.op === 'add_database' ? { kind: ADDON_KINDS.includes(op.kind) ? op.kind : 'postgres', env: op.env || DEFAULT_ENV[ADDON_KINDS.includes(op.kind) ? op.kind : 'postgres'] } : {})
});

/** Give a service a public https URL (a generated host on the platform domain). */
function expose(serviceId, userId) {
  const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  const net = queryOne('SELECT public, target_port FROM service_networking WHERE service_id = ?', serviceId) || {};
  const result = { wasPublic: Boolean(net.public) };
  const now = new Date().toISOString();
  let host = queryOne("SELECT host FROM domains WHERE service_id = ? AND kind = 'generated'", serviceId)?.host;
  transaction(() => {
    execute('UPDATE service_networking SET public = 1 WHERE service_id = ?', serviceId);
    if (!host) {
      host = `${service.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${service.id.slice(-6)}.${BASE_DOMAIN}`;
      const id = `dom_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      execute(`
        INSERT INTO domains (id, environment_id, service_id, service_name, host, kind, status, target_port, tls_configured, dns_records, verified_at, created_at)
        VALUES (?, ?, ?, ?, ?, 'generated', 'active', ?, 1, ?, ?, ?)
      `, id, service.environment_id, service.id, service.name, host, net.target_port || 3000,
        JSON.stringify([{ type: 'CNAME', name: host, value: `edge.${BASE_DOMAIN}`, verified: true }]), now, now);
      result.domainId = id;
      if (!service.primary_domain) execute('UPDATE services SET primary_domain = ? WHERE id = ?', host, service.id);
    }
  });
  if (result.domainId) {
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'domain.updated', at: now, actorId: userId, canvasRevision: null, data: mapDomain(queryOne('SELECT * FROM domains WHERE id = ?', result.domainId)) });
  }
  return { ...result, host, url: `https://${host}` };
}

export async function runOp({ op, kind, env }, serviceId, userId) {
  const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service) throw new Error('That service no longer exists');
  switch (op) {
    case 'expose': return expose(serviceId, userId);
    case 'redeploy': return { deploymentId: startDeployment({ serviceId, userId, message: 'Redeploy from the assistant' }) };
    case 'restart': await containerSupervisor.restartService(serviceId); return { restarted: true };
    case 'add_database': {
      const addon = provisionAddon({ environmentId: service.environment_id, appServiceId: serviceId, appName: service.name, kind, env, userId });
      // The app reads the new variable at start, so it needs a fresh deploy.
      return { addon, deploymentId: startDeployment({ serviceId, userId, message: `Connect ${KIND_NAME[kind] || kind}` }) };
    }
    default: throw new Error(`Unknown operation: ${op}`);
  }
}

export async function revertOp({ op }, serviceId, result) {
  if (op === 'expose') {
    execute('UPDATE service_networking SET public = ? WHERE service_id = ?', result.wasPublic ? 1 : 0, serviceId);
    if (result.domainId) {
      execute('DELETE FROM domains WHERE id = ?', result.domainId);
      execute('UPDATE services SET primary_domain = NULL WHERE id = ? AND primary_domain = ?', serviceId, result.host);
    }
  } else if (op === 'add_database' && result.addon) {
    if (result.addon.variableId) execute('DELETE FROM variables WHERE id = ?', result.addon.variableId);
    await removeAddon(result.addon);
    startDeployment({ serviceId, userId: null, message: 'Revert: remove database' });
  }
}
