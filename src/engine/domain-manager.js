import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { BASE_DOMAIN } from '../config.js';
import { eventBus } from './event-bus.js';
import { notify, adminsOfProject, projectOfEnvironment } from '../services/notifications.js';

function announce(updated, previousStatus) {
  if (updated.status === previousStatus) return;
  const projectId = projectOfEnvironment(updated.environment_id);
  if (!projectId || !['active', 'failed'].includes(updated.status)) return;
  notify(adminsOfProject(projectId), updated.status === 'active'
    ? { type: 'domain_active', title: `${updated.host} is live`, body: `${updated.host} now points to ${updated.service_name || 'your service'}.`, projectId, targetUrl: `/projects/${projectId}` }
    : { type: 'domain_failed', title: `${updated.host} could not be verified`, body: updated.error || 'The DNS records were not found.', item: updated.host, projectId, targetUrl: `/projects/${projectId}` });
}

/**
 * Custom domains. A domain only serves traffic once its owner has proven control of it
 * (a TXT record) AND pointed it at Morline's edge. Without the ownership step, anyone could
 * register someone else's hostname and receive its traffic as soon as the real owner pointed DNS here.
 */

export const EDGE_HOST = `edge.${BASE_DOMAIN}`;
const CHALLENGE_PREFIX = '_morline-challenge';
const GIVE_UP_AFTER_MS = 7 * 24 * 3600 * 1000;
const CHECK_EVERY_MS = 60_000;

// ---------------------------------------------------------------- hostnames

export function normalizeHost(input) {
  return String(input || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Returns an error message, or null when the host may be added as a custom domain. */
export function hostProblem(host) {
  if (!host) return 'Enter a domain name';
  if (/[/:?#@\s]/.test(host)) return 'Enter only the domain, for example app.example.com (no https:// or path)';
  if (host.includes('*')) return 'Wildcard domains are not supported';
  if (net.isIP(host)) return 'An IP address cannot be used as a domain';
  if (host.length > 253) return 'That domain is too long';
  const labels = host.split('.');
  if (labels.length < 2) return 'Enter a full domain, for example app.example.com';
  if (!labels.every((l) => /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(l))) return 'That is not a valid domain name';
  if (host === BASE_DOMAIN || host.endsWith(`.${BASE_DOMAIN}`)) return `Domains under ${BASE_DOMAIN} are provided by Morline and cannot be added as custom domains`;
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/.test(host)) return 'That domain cannot be used';
  return null;
}

export const newToken = () => crypto.randomBytes(16).toString('hex');

export async function detectCloudflare(host) {
  try {
    const labels = String(host || '').toLowerCase().trim().split('.');
    if (labels.length < 2) return null;
    const multiPartTlds = ['co.uk', 'com.br', 'co.nz', 'com.au', 'org.uk', 'gov.uk'];
    const lastTwo = labels.slice(-2).join('.');
    const apex = labels.length > 2 && multiPartTlds.includes(lastTwo)
      ? labels.slice(-3).join('.')
      : labels.slice(-2).join('.');
    const subdomain = host === apex ? '@' : host.slice(0, -(apex.length + 1));

    const [nsList, domainConnectTxt] = await Promise.all([
      dns.resolveNs(apex).catch(() => []),
      dns.resolveTxt(`_domainconnect.${apex}`).catch(() => [])
    ]);

    const isNsCloudflare = nsList.some((ns) => ns.toLowerCase().includes('cloudflare.com'));
    const isDcCloudflare = domainConnectTxt.some((chunks) => chunks.join('').toLowerCase().includes('cloudflare'));

    if (isNsCloudflare || isDcCloudflare) {
      return {
        id: 'cloudflare',
        name: 'Cloudflare',
        apex,
        subdomain,
        autoConfigUrl: 'https://dash.cloudflare.com/'
      };
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------- DNS instructions and checks

async function edgeAddresses() {
  const fixed = (process.env.EDGE_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fixed.length) return fixed;
  return dns.resolve4(EDGE_HOST).catch(() => []);
}

export async function dnsRecordsFor(row, results = {}) {
  const ips = await edgeAddresses();
  const records = [
    { type: 'TXT', name: `${CHALLENGE_PREFIX}.${row.host}`, value: `morline-verify=${row.verification_token}`, verified: Boolean(results.ownership ?? row.verified_at), purpose: 'Proves you own this domain' },
    { type: 'CNAME', name: row.host, value: EDGE_HOST, verified: Boolean(results.routing), purpose: 'Sends traffic to Morline' }
  ];
  if (ips.length) {
    records.push({ type: 'A', name: row.host, value: ips.join(', '), verified: Boolean(results.routing), optional: true,
      purpose: 'Use this instead of the CNAME for a root domain such as example.com' });
  }
  return records;
}

async function resolveOwnership(row) {
  const txt = await dns.resolveTxt(`${CHALLENGE_PREFIX}.${row.host}`).catch(() => []);
  return txt.map((chunks) => chunks.join('')).some((v) => v.trim() === `morline-verify=${row.verification_token}`);
}

async function resolveRouting(host) {
  const cnames = await dns.resolveCname(host).catch(() => []);
  if (cnames.some((c) => c.toLowerCase().replace(/\.$/, '') === EDGE_HOST)) return true;
  const [mine, edge] = await Promise.all([dns.resolve4(host).catch(() => []), edgeAddresses()]);
  return mine.length > 0 && mine.some((ip) => edge.includes(ip));
}

/** What certificate does the edge actually serve for this host? Null if none is being served yet. */
export function probeCertificate(host, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const ok = socket.authorized && cert?.valid_to;
      const result = ok ? { validUntil: new Date(cert.valid_to).toISOString() } : null;
      socket.destroy();
      resolve(result);
    });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
    socket.on('error', () => resolve(null));
  });
}

/** Re-checks one custom domain and records the outcome. */
export async function checkDomain(row, actorId = null) {
  const [ownership, routing] = await Promise.all([
    row.verified_at ? true : resolveOwnership(row),
    resolveRouting(row.host)
  ]);
  const now = new Date().toISOString();
  let status = 'pending';
  let error = `Add the TXT record ${CHALLENGE_PREFIX}.${row.host} to prove you own this domain`;
  if (ownership && !routing) {
    status = 'verifying';
    error = `Ownership confirmed. Point ${row.host} to ${EDGE_HOST} (CNAME), or use the A record for a root domain`;
  } else if (ownership && routing) {
    status = 'active';
    error = null;
  }

  let certificate = null;
  if (status === 'active') certificate = await probeCertificate(row.host);
  const error2 = status === 'active' && !certificate ? 'Domain is live. Waiting for its HTTPS certificate to be issued' : error;

  execute(`UPDATE domains SET status = ?, error = ?, last_checked_at = ?, tls_configured = ?, tls_expires_at = ?,
    verified_at = CASE WHEN ? THEN COALESCE(verified_at, ?) ELSE verified_at END,
    dns_records = ? WHERE id = ?`,
  status, error2, now, certificate ? 1 : 0, certificate?.validUntil ?? null,
  ownership ? 1 : 0, now, JSON.stringify(await dnsRecordsFor(row, { ownership, routing })), row.id);

  if (status === 'active' && row.service_id && !queryOne('SELECT primary_domain FROM services WHERE id = ?', row.service_id)?.primary_domain) {
    execute('UPDATE services SET primary_domain = ? WHERE id = ?', row.host, row.service_id);
  }
  const updated = queryOne('SELECT * FROM domains WHERE id = ?', row.id);
  announce(updated, row.status);
  return { row: updated, changed: updated.status !== row.status || Boolean(updated.tls_configured) !== Boolean(row.tls_configured), actorId };
}

// ---------------------------------------------------------------- background re-checks

let timer = null;
export function startDomainChecks(onChange = () => {}) {
  if (timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const waiting = queryAll(`SELECT * FROM domains WHERE kind = 'custom' AND (
        status IN ('pending', 'verifying') OR (status = 'active' AND tls_configured = 0))
        ORDER BY COALESCE(last_checked_at, created_at) ASC LIMIT 20`);
      for (const row of waiting) {
        if (Date.now() - Date.parse(row.created_at) > GIVE_UP_AFTER_MS && row.status !== 'active') {
          execute("UPDATE domains SET status = 'failed', error = 'The DNS records were not found within 7 days. Remove this domain and add it again to retry.', last_checked_at = ? WHERE id = ?", new Date().toISOString(), row.id);
          const failed = queryOne('SELECT * FROM domains WHERE id = ?', row.id);
          announce(failed, row.status);
          onChange(failed, row);
          continue;
        }
        const { row: updated, changed } = await checkDomain(row);
        if (changed) onChange(updated, row);
      }
    } catch (err) {
      console.warn('[Domains] Re-check failed:', err.message);
    } finally {
      running = false;
    }
  }, CHECK_EVERY_MS);
  timer.unref();
}

export function emitDomainUpdate(row, mapper, actorId = null) {
  eventBus.emitEnvironmentEvent(row.environment_id, { type: 'domain.updated', at: new Date().toISOString(), actorId, canvasRevision: null, data: mapper(row) });
}

// ---------------------------------------------------------------- certificate permission (used by the edge)

/** Should the edge be allowed to obtain a certificate for this host? */
export function mayIssueCertificate(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if ([BASE_DOMAIN, `api.${BASE_DOMAIN}`, EDGE_HOST].includes(h)) return true;
  const row = queryOne('SELECT status, kind, service_id FROM domains WHERE host = ?', h);
  if (row) return row.status === 'active' && Boolean(row.service_id);
  return false;
}
