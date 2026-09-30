import crypto from 'node:crypto';
import { execute } from '../db/index.js';

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
