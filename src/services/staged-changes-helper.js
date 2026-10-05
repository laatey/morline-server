import { privateHostname } from '../engine/private-network.js';
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

function isServiceReferencedInVariable(v, other) {
  if (!v) return false;
  const keyUpper = (v.key || '').toUpperCase();
  const cleanName = other.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (keyUpper === `${cleanName}_URL` || keyUpper === `${other.name.toUpperCase()}_URL`) return true;

  const val = (v.value || '').toLowerCase();
  if (!val) return false;
  const srvName = other.name.toLowerCase();
  const srvId = (other.id || '').toLowerCase();

  // 1. Reference expression like ${{ postgres.DATABASE_URL }} or ${{ srvId... }}
  if (val.includes(`\${{ ${srvName}`) || (srvId && val.includes(`\${{ ${srvId}`))) return true;
  if (val.includes(`\${${srvName}`) || (srvId && val.includes(`\${${srvId}`))) return true;

  // 2. Internal domain: postgres.morline.internal
  if (val.includes(`${srvName}.morline.internal`) || val.includes(privateHostname(other))) return true;

  // 3. Host / protocol reference: http://postgres, postgres:5432, @postgres:
  if (val.includes(`://${srvName}`) || val.includes(`@${srvName}:`)) return true;
  if (other.port && val.includes(`${srvName}:${other.port}`)) return true;

  return false;
}

/**
 * Keep canvas connection lines in sync with service variables.
 * Inspects variable content structure (values & references) to determine connections.
 */
export function syncConnectionsWithVariables(environmentId, serviceId) {
  if (!environmentId || !serviceId) return;

  const currentVars = queryAll('SELECT key, value FROM variables WHERE scope_type = ? AND scope_id = ?', 'service', serviceId);
  const otherServices = queryAll('SELECT id, name, port FROM services WHERE environment_id = ? AND id != ?', environmentId, serviceId);
  const existingConns = queryAll('SELECT * FROM connections WHERE from_service_id = ?', serviceId);

  for (const other of otherServices) {
    const hasRef = currentVars.some(v => isServiceReferencedInVariable(v, other));
    const existingConn = existingConns.find(c => c.to_service_id === other.id);

    if (existingConn && !hasRef) {
      // Variable content no longer references other service -> remove connection!
      execute('DELETE FROM connections WHERE id = ?', existingConn.id);
    } else if (!existingConn && hasRef) {
      // Variable content references other service -> auto-create connection!
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

