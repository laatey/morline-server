import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, APPS_DIR } from '../config.js';
import { execute, queryAll, queryOne, transaction } from '../db/index.js';
import { buildManager } from '../engine/build-manager.js';
import { containerSupervisor } from '../engine/container-supervisor.js';
import { eventBus } from '../engine/event-bus.js';
import { removeEnvNetwork } from '../engine/private-network.js';

const VOLUMES_DIR = path.join(DATA_DIR, 'service-volumes');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

/** Remove <root>/<id> if it is a plain id inside root. Returns true when something was removed. */
function removeDir(root, id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
  const dir = path.join(root, id);
  if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep) || !fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`[Cleanup] Could not remove ${dir}: ${err.message}`);
    return false;
  }
}

/**
 * Delete a service and everything that belongs to it: the running container and its images,
 * its domains, variables and port allocations, its source checkout and env file (which holds
 * secrets), its volume data and database backups. Activity history and billing usage stay.
 */
export async function destroyService(serviceId, { actorId = null } = {}) {
  const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service) return null;

  // End an in-flight build first so it can't recreate files or containers behind us.
  const running = buildManager.active.get(serviceId);
  if (buildManager.cancel(serviceId) && running?.done) {
    await Promise.race([running.done, new Promise((resolve) => setTimeout(resolve, 15000))]);
  }
  await containerSupervisor.stopService(serviceId, true);
  await containerSupervisor.purgeArtifacts(serviceId).catch(() => {});

  const domains = queryAll('SELECT id FROM domains WHERE service_id = ?', serviceId);
  transaction(() => {
    execute('DELETE FROM domains WHERE service_id = ?', serviceId);
    execute("DELETE FROM variables WHERE scope_type = 'service' AND scope_id = ?", serviceId);
    execute('DELETE FROM variable_suggestion_dismissals WHERE service_id = ?', serviceId);
    execute('DELETE FROM staged_changes WHERE service_id = ?', serviceId);
    execute('DELETE FROM services WHERE id = ?', serviceId); // cascades deployments, logs, volumes, connections, ports, backups rows
  });

  const files = {
    source: removeDir(APPS_DIR, serviceId),
    volumes: removeDir(VOLUMES_DIR, serviceId),
    backups: removeDir(BACKUPS_DIR, serviceId)
  };

  const at = new Date().toISOString();
  for (const d of domains) {
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'domain.deleted', at, actorId, canvasRevision: null, data: { id: d.id, serviceId } });
  }
  eventBus.emitEnvironmentEvent(service.environment_id, { type: 'service.deleted', at, actorId, canvasRevision: null, data: { id: serviceId } });
  return { serviceId, domains: domains.length, files };
}

async function destroyAll(ids) {
  for (const id of ids) {
    try { await destroyService(id); } catch (err) { console.error(`[Cleanup] ${id}: ${err.message}`); }
  }
}

const idsOf = (sql, ...params) => queryAll(sql, ...params).map((r) => r.id);

/** Tear down every service, environment variable and private network under these environments. */
async function destroyEnvironments(envIds) {
  for (const envId of envIds) {
    await destroyAll(idsOf('SELECT id FROM services WHERE environment_id = ?', envId));
    execute("DELETE FROM variables WHERE scope_type = 'environment' AND scope_id = ?", envId);
    await removeEnvNetwork(envId).catch(() => {});
  }
}

export const destroyEnvironment = (envId) => destroyEnvironments([envId]);
export const destroyProject = (projectId) => destroyEnvironments(idsOf('SELECT id FROM environments WHERE project_id = ?', projectId));
export const destroyTeam = (teamId) => destroyEnvironments(idsOf(
  'SELECT e.id FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.team_id = ?', teamId
));

/**
 * Housekeeping at startup for things earlier versions left behind. Database rows that point at
 * nothing are removed. Orphaned folders are only reported (they may hold someone's data); set
 * MORLINE_SWEEP_ORPHAN_FILES=1 to delete them.
 */
export function sweepOrphans(env = process.env) {
  const report = { domains: 0, variables: 0, stagedChanges: 0, folders: [] };
  report.domains = execute('DELETE FROM domains WHERE service_id IS NULL AND service_name IS NOT NULL').changes;
  report.variables = execute("DELETE FROM variables WHERE scope_type = 'service' AND scope_id NOT IN (SELECT id FROM services)").changes
    + execute("DELETE FROM variables WHERE scope_type = 'environment' AND scope_id NOT IN (SELECT id FROM environments)").changes;
  report.stagedChanges = execute('DELETE FROM staged_changes WHERE service_id IS NOT NULL AND service_id NOT IN (SELECT id FROM services)').changes;

  const live = new Set(idsOf('SELECT id FROM services'));
  for (const [label, root] of [['apps', APPS_DIR], ['service-volumes', VOLUMES_DIR], ['backups', BACKUPS_DIR]]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^srv_[A-Za-z0-9_-]+$/.test(entry.name) || live.has(entry.name)) continue;
      report.folders.push(`${label}/${entry.name}`);
      if (env.MORLINE_SWEEP_ORPHAN_FILES === '1') removeDir(root, entry.name);
    }
  }
  return report;
}
