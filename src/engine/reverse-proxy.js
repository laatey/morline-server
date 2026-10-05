import http from 'node:http';
import { queryOne, queryAll } from '../db/index.js';
import { containerSupervisor } from './container-supervisor.js';
import { BASE_DOMAIN } from '../config.js';
import { recordTraffic } from './usage-meter.js';
import { FRONTEND_URL } from '../config.js';

// Hostnames under the base domain that belong to Morline itself, never to a user's service.
const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'edge', 'admin', 'dashboard', 'docs', 'status', 'mail']);
const frontendHost = (() => { try { return new URL(FRONTEND_URL).hostname.toLowerCase(); } catch { return ''; } })();

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

// A short, plain page for visitors, and the same information as JSON for API clients.
function sendNotice(req, res, status, code, title, message) {
  if (!wantsHtml(req)) return res.status(status).json({ code, message });
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#fafafa;color:#1c1c1c}
@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;opacity:.7}
small{display:block;margin-top:2rem;opacity:.45;font-size:.8rem}</style></head><body><main>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><small>${escapeHtml(String(status))} &middot; Morline</small></main></body></html>`);
}

export function reverseProxyMiddleware(req, res, next) {
  // Never proxy API routes
  if (req.path.startsWith('/v1') || req.path === '/health') {
    return next();
  }

  // Check path-based proxying: /proxy/:serviceId/*
  const proxyMatch = req.path.match(/^\/proxy\/([^/]+)(\/.*)?$/);
  let targetServiceId = null;
  let targetPath = req.url;

  if (proxyMatch) {
    targetServiceId = proxyMatch[1];
    targetPath = proxyMatch[2] || '/';
  } else {
    // Check host-based proxying: e.g. <serviceName>.localhost or custom domain
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (host === `api.${BASE_DOMAIN}` || host === BASE_DOMAIN) {
      return next();
    }
    if (host && host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('192.168.') && !host.startsWith('10.')) {
      const domainRow = queryOne('SELECT service_id, status, kind FROM domains WHERE host = ?', host);
      if (domainRow) {
        // A custom domain only serves traffic once ownership is proven and DNS points here.
        if (domainRow.status === 'active' && domainRow.service_id) targetServiceId = domainRow.service_id;
        else if (domainRow.kind === 'custom') {
          return sendNotice(req, res, 404, 'domain_not_active', 'This domain is not active yet',
            'It has been added to Morline but its DNS setup is not finished. The owner can complete it in the domain settings.');
        }
      }
      if (!targetServiceId && host.endsWith(`.${BASE_DOMAIN}`)) {
        const sub = host.slice(0, -(BASE_DOMAIN.length + 1));
        const reserved = RESERVED_SUBDOMAINS.has(sub) || host === frontendHost;
        if (reserved) return next();
        // Older services without a generated-domain row are reached by name, but only when the name is unambiguous.
        const named = queryAll('SELECT id FROM services WHERE name = ? LIMIT 2', sub);
        if (named.length === 1) targetServiceId = named[0].id;
        else {
          // Nothing is deployed at this address. Say so instead of falling through to the API.
          return sendNotice(req, res, 404, 'no_service_here', 'Nothing is deployed here',
            `No service is using ${host}. If you own this address, check the service name and that it has a domain.`);
        }
      }
    }
  }

  if (!targetServiceId) {
    return next();
  }

  const endpoint = containerSupervisor.endpointForService(targetServiceId);
  if (!endpoint) {
    return sendNotice(req, res, 503, 'service_offline', 'This service is not running',
      'It is stopped, still deploying, or has not been deployed yet.');
  }

  const proxyReq = http.request({
    hostname: endpoint.host,
    port: endpoint.port,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: req.headers.host,
      'x-forwarded-for': req.ip,
      'x-forwarded-proto': req.protocol
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    // Bytes sent to the visitor are billed as egress.
    let sent = 0;
    proxyRes.on('data', (chunk) => { sent += chunk.length; });
    proxyRes.on('end', () => recordTraffic(targetServiceId, sent));
  });

  proxyReq.on('error', (err) => {
    console.error(`[ReverseProxy] Error forwarding to service ${targetServiceId} at ${endpoint.host}:${endpoint.port}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({
        code: 'bad_gateway',
        message: 'Could not connect to the service container'
      });
    }
  });

  req.pipe(proxyReq);
}
