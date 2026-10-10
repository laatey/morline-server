import { execute, queryAll, transaction } from '../db/index.js';
import { BASE_DOMAIN } from '../config.js';
import { AppError, conflict, validationError } from '../middleware/error-handler.js';

/**
 * Public UDP access for services that speak UDP (RADIUS, WireGuard, DNS, game servers...).
 * A service lists the UDP ports it listens on inside its container; each gets its own port on the server's
 * public address, published straight from the container by Docker (`--publish public:container/udp`).
 * Open the same range in the instance's security group (see README).
 */

const [LOW, HIGH] = (process.env.UDP_PROXY_PORTS || '31000-31999').split('-').map(Number);
export const UDP_HOST = process.env.PUBLIC_UDP_HOST || process.env.PUBLIC_TCP_HOST || `edge.${BASE_DOMAIN}`;
export const MAX_UDP_PORTS_PER_SERVICE = 8;

export function udpMappings(serviceId) {
  return queryAll('SELECT container_port, public_port FROM service_udp_ports WHERE service_id = ? ORDER BY container_port', serviceId);
}

export function udpProxyInfo(serviceId) {
  const ports = udpMappings(serviceId).map((m) => ({
    containerPort: m.container_port,
    port: m.public_port,
    address: `${UDP_HOST}:${m.public_port}`
  }));
  return { enabled: ports.length > 0, host: UDP_HOST, range: { from: LOW, to: HIGH }, ports };
}

/** Validates the requested container ports (array of integers 1-65535, no duplicates). */
export function parseUdpPorts(input) {
  if (!Array.isArray(input)) throw validationError('udpPorts must be a list of ports', { udpPorts: 'Expected a list' });
  if (input.length > MAX_UDP_PORTS_PER_SERVICE) throw validationError(`A service can expose at most ${MAX_UDP_PORTS_PER_SERVICE} UDP ports`, { udpPorts: 'Too many ports' });
  const ports = input.map((p) => (typeof p === 'object' && p !== null ? p.containerPort : p)).map(Number);
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw validationError('Each UDP port must be between 1 and 65535', { udpPorts: 'Invalid port' });
  }
  if (new Set(ports).size !== ports.length) throw validationError('UDP ports must be unique', { udpPorts: 'Duplicate port' });
  return ports.sort((a, b) => a - b);
}

/**
 * Makes the service's public UDP mappings match `containerPorts`. Existing mappings keep their public port;
 * new ones get the lowest free port in the range. Returns true when something changed.
 */
export function setUdpPorts(serviceId, containerPorts) {
  return transaction(() => {
    const current = udpMappings(serviceId);
    const keep = new Set(containerPorts);
    let changed = false;
    for (const m of current) {
      if (!keep.has(m.container_port)) {
        execute('DELETE FROM service_udp_ports WHERE service_id = ? AND container_port = ?', serviceId, m.container_port);
        changed = true;
      }
    }
    const have = new Set(current.map((m) => m.container_port));
    const used = new Set(queryAll('SELECT public_port FROM service_udp_ports').map((r) => r.public_port));
    for (const port of containerPorts) {
      if (have.has(port)) continue;
      let pick = null;
      for (let p = LOW; p <= HIGH; p++) if (!used.has(p)) { pick = p; break; }
      if (pick === null) throw conflict(`All public UDP ports (${LOW}-${HIGH}) are in use`, 'no_udp_ports_left');
      execute('INSERT INTO service_udp_ports (service_id, container_port, public_port) VALUES (?, ?, ?)', serviceId, port, pick);
      used.add(pick);
      changed = true;
    }
    return changed;
  });
}

/** `public:container/udp` strings for Docker's `--publish` / Compose `ports`. */
export function udpPublishSpecs(serviceId) {
  return udpMappings(serviceId).map((m) => `${m.public_port}:${m.container_port}/udp`);
}

/**
 * Variables handed to the app so it can tell clients where it is reachable, e.g. a RADIUS server that must put its
 * public port into router configs: MORLINE_PUBLIC_UDP_HOST and MORLINE_PUBLIC_UDP_PORT_<container port>.
 */
export function udpEnv(serviceId) {
  const maps = udpMappings(serviceId);
  if (!maps.length) return {};
  const env = { MORLINE_PUBLIC_UDP_HOST: UDP_HOST };
  for (const m of maps) env[`MORLINE_PUBLIC_UDP_PORT_${m.container_port}`] = String(m.public_port);
  return env;
}

export function clearUdpPorts(serviceId) {
  execute('DELETE FROM service_udp_ports WHERE service_id = ?', serviceId);
}
