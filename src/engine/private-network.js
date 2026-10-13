import { spawn } from 'node:child_process';
import { execute, queryOne, queryAll } from '../db/index.js';

/**
 * Private networking: "<service>.morline.internal" resolves to that service's container.
 *
 * Docker's built-in DNS answers network aliases, but only for containers on a shared network. Putting every
 * service on one network would make "postgres.morline.internal" ambiguous between customers, so each
 * environment gets its own network and the aliases exist only there. Containers keep the shared
 * ingress network as well so Morline's reverse proxy can still reach them.
 */

export const PRIVATE_DOMAIN = 'morline.internal';
const POOL = process.env.PRIVATE_NET_POOL || '10.200.0.0/16'; // carved into /26 networks (61 containers each)
const PREFIX = 26;

// ---------------------------------------------------------------- names

export function dnsLabel(name) {
  const label = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '');
  return label || 'service';
}

/** The service's DNS label, unique within its environment (the oldest service keeps the plain name). */
export function privateLabel(service) {
  const base = dnsLabel(service.name);
  const rivals = queryAll('SELECT id, name, created_at FROM services WHERE environment_id = ? AND id != ?', service.environment_id, service.id)
    .filter((s) => dnsLabel(s.name) === base)
    .filter((s) => (s.created_at || '') < (service.created_at || '') || ((s.created_at || '') === (service.created_at || '') && s.id < service.id));
  return rivals.length ? `${base}-${String(service.id).replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase()}` : base;
}

export const privateHostname = (service) => `${privateLabel(service)}.${PRIVATE_DOMAIN}`;

// ---------------------------------------------------------------- docker

function docker(args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ---------------------------------------------------------------- subnets

function parsePool(pool) {
  const [base, bits] = pool.split('/');
  const baseInt = base.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
  const poolBits = Number(bits);
  if (!Number.isInteger(poolBits) || poolBits > PREFIX || baseInt % (2 ** (32 - poolBits)) !== 0) {
    throw new Error(`PRIVATE_NET_POOL must be a network of /${PREFIX} or larger, for example 10.200.0.0/16`);
  }
  return { baseInt, count: 2 ** (PREFIX - poolBits) };
}

export function subnetFor(index, pool = POOL) {
  const { baseInt, count } = parsePool(pool);
  if (index < 0 || index >= count) throw new Error('The private network address pool is exhausted. Increase PRIVATE_NET_POOL.');
  const n = baseInt + index * (2 ** (32 - PREFIX));
  return `${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}/${PREFIX}`;
}

const networkName = (environmentId) => `morline-env-${String(environmentId).replace(/[^a-zA-Z0-9_.-]/g, '')}`;

function saveNetwork(environmentId, name, idx, subnet) {
  execute('DELETE FROM private_networks WHERE environment_id = ?', environmentId);
  execute('INSERT INTO private_networks (environment_id, name, idx, subnet, created_at) VALUES (?, ?, ?, ?, ?)',
    environmentId, name, idx, subnet, new Date().toISOString());
}

/** Makes sure the environment's private network exists, and returns its name. */
export async function ensureEnvNetwork(environmentId) {
  const name = networkName(environmentId);
  if ((await docker(['network', 'inspect', name])).code === 0) return name;

  // A range already recorded for this environment is reused (the network may just have been pruned).
  const mine = queryOne('SELECT idx FROM private_networks WHERE environment_id = ?', environmentId);
  const taken = new Set(queryAll('SELECT idx FROM private_networks WHERE environment_id != ?', environmentId).map((r) => r.idx));
  let idx = mine ? mine.idx : 0;
  for (let attempt = 0; attempt < 64; attempt++, idx++) {
    while (taken.has(idx)) idx++;
    const subnet = subnetFor(idx);
    const created = await docker(['network', 'create', '--driver', 'bridge', '--subnet', subnet,
      '--label', `morline.environment_id=${environmentId}`, name]);
    if (created.code === 0 || /already exists/i.test(created.stderr)) {
      saveNetwork(environmentId, name, idx, subnet);
      return name;
    }
    // Anything but an address clash is a real failure. A clash means something else on the host uses the range.
    if (!/overlap|pool|subnet/i.test(created.stderr)) throw new Error(`Could not create the private network: ${created.stderr.trim()}`);
  }
  throw new Error('Could not find a free address range for the private network');
}

/** Remove an environment's Docker network and release its address range. Best effort. */
export async function removeEnvNetwork(environmentId) {
  await docker(['network', 'rm', networkName(environmentId)]);
  execute('DELETE FROM private_networks WHERE environment_id = ?', environmentId);
}

// ---------------------------------------------------------------- attaching

/** Gives a running container its "<service>.morline.internal" name on the environment's private network. */
export async function attachToPrivateNetwork(service, container) {
  const network = await ensureEnvNetwork(service.environment_id);
  const alias = privateHostname(service);
  const connect = () => docker(['network', 'connect', '--alias', alias, network, container]);
  let result = await connect();
  if (result.code !== 0 && /already exists|already connected/i.test(result.stderr)) {
    // Already attached, possibly under an old name (the service was renamed): reconnect with the current alias.
    await docker(['network', 'disconnect', network, container]);
    result = await connect();
  }
  if (result.code !== 0) throw new Error(`Could not join the private network: ${result.stderr.trim()}`);
  return { network, alias };
}

/** Attaches every container Docker reports for a service (compose stacks can have several). */
export async function attachByLabel(service, composeService = null) {
  const filters = ['--filter', `label=morline.service_id=${service.id}`];
  if (composeService) filters.push('--filter', `label=com.docker.compose.service=${composeService}`);
  const listed = await docker(['ps', '-q', ...filters]);
  const ids = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error('No running container was found to attach');
  return attachToPrivateNetwork(service, ids[0]);
}
