import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';

/**
 * Record a staged change. Call this whenever a variable/setting/source changes
 * but no immediate redeploy is triggered.
 */
export function createStagedChange({ environmentId, serviceId, serviceName, type, summary, payload = {} }) {
  const id = `chg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  execute(`
    INSERT INTO staged_changes (id, environment_id, service_id, service_name, type, summary, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, id, environmentId, serviceId || null, serviceName || null, type, summary, JSON.stringify(payload), now);
  return id;
}

/**
 * Clear staged changes for a specific service (call after a successful deploy).
 */
export function clearStagedChanges(environmentId, serviceId) {
  if (serviceId) {
    execute('DELETE FROM staged_changes WHERE environment_id = ? AND service_id = ?', environmentId, serviceId);
  } else {
    execute('DELETE FROM staged_changes WHERE environment_id = ?', environmentId);
  }
}

/**
 * Keep canvas connection lines in sync with service variables.
 * If a variable representing a connection is deleted, remove the connection line.
 * If a variable matching a service in the environment is added, create the connection line.
 */
export function syncConnectionsWithVariables(environmentId, serviceId) {
  if (!environmentId || !serviceId) return;

  const currentVars = queryAll('SELECT key FROM variables WHERE scope_type = ? AND scope_id = ?', 'service', serviceId);
  const varKeys = new Set(currentVars.map(v => v.key.toUpperCase()));

  const otherServices = queryAll('SELECT id, name, port FROM services WHERE environment_id = ? AND id != ?', environmentId, serviceId);
  const existingConns = queryAll('SELECT * FROM connections WHERE from_service_id = ?', serviceId);

  for (const other of otherServices) {
    const cleanName = other.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const expectedKey = `${cleanName}_URL`;
    const altKey = `${other.name.toUpperCase()}_URL`;

    const hasVar = varKeys.has(expectedKey) || varKeys.has(altKey);
    const existingConn = existingConns.find(c => c.to_service_id === other.id);

    if (existingConn && !hasVar) {
      // Variable was deleted -> remove the connection line!
      execute('DELETE FROM connections WHERE id = ?', existingConn.id);
    } else if (!existingConn && hasVar) {
      // Variable was added -> auto-create connection line!
      const connId = `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const now = new Date().toISOString();
      const port = other.port || 3000;
      execute(`
        INSERT INTO connections (id, environment_id, from_service_id, to_service_id, protocol, port, label, created_at)
        VALUES (?, ?, ?, ?, 'http', ?, ?, ?)
      `, connId, environmentId, serviceId, other.id, port, `http :${port}`, now);
    }
  }
}

