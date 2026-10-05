import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { BASE_DOMAIN } from '../config.js';
import { AppError, conflict } from '../middleware/error-handler.js';

/**
 * Public TCP access for services that are not HTTP (databases, Redis, SSH-style tools).
 * Each service that turns it on gets its own port on the server's public address, published straight
 * from its container by Docker. Open the same range in the instance's security group (see README).
 */

const [LOW, HIGH] = (process.env.TCP_PROXY_PORTS || '30000-30999').split('-').map(Number);
export const TCP_HOST = process.env.PUBLIC_TCP_HOST || `edge.${BASE_DOMAIN}`;

export function tcpProxyInfo(net) {
  const port = net?.tcp_proxy_port || null;
  return port ? { enabled: true, host: TCP_HOST, port, address: `${TCP_HOST}:${port}` } : { enabled: false, host: TCP_HOST, port: null, address: null };
}

/** Turns public TCP on for a service, choosing a free port. Returns the port (the existing one if already on). */
export function enableTcpProxy(serviceId) {
  return transaction(() => {
    const current = queryOne('SELECT tcp_proxy_port FROM service_networking WHERE service_id = ?', serviceId);
    if (!current) throw new AppError('Service networking is not configured', 404, 'not_found');
    if (current.tcp_proxy_port) return current.tcp_proxy_port;
    const used = new Set(queryAll('SELECT tcp_proxy_port FROM service_networking WHERE tcp_proxy_port IS NOT NULL').map((r) => r.tcp_proxy_port));
    for (let port = LOW; port <= HIGH; port++) {
      if (used.has(port)) continue;
      execute('UPDATE service_networking SET tcp_proxy_port = ? WHERE service_id = ?', port, serviceId);
      return port;
    }
    throw conflict(`All public TCP ports (${LOW}-${HIGH}) are in use`, 'no_tcp_ports_left');
  });
}

export function disableTcpProxy(serviceId) {
  execute('UPDATE service_networking SET tcp_proxy_port = NULL WHERE service_id = ?', serviceId);
}
