import { execute, queryOne } from '../db/index.js';

/**
 * A stopped service has replicas set to 0 (settings are otherwise untouched). Anything that
 * starts it again calls this first to put the replica count back to what it was before.
 * With reviveDeployment, the deployment that stop retired is re-opened so a plain restart
 * of the existing image can mark it healthy again.
 */
export function reviveFromStop(serviceId, { reviveDeployment = false } = {}) {
  const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service || service.status !== 'stopped') return false;
  const replicas = Math.max(1, Number(service.replicas_before_stop) || 1);
  execute('UPDATE services SET replicas = ? WHERE id = ?', replicas, serviceId);
  execute('UPDATE service_settings SET replicas = ? WHERE service_id = ?', replicas, serviceId);
  if (reviveDeployment && service.active_deployment_id) {
    execute("UPDATE deployments SET state = 'deploying' WHERE id = ? AND state = 'removed'", service.active_deployment_id);
  }
  return true;
}
