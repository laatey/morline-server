import http from 'node:http';
import { queryOne } from '../db/index.js';
import { containerSupervisor } from './container-supervisor.js';
import { BASE_DOMAIN } from '../config.js';

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
      const domainRow = queryOne('SELECT service_id FROM domains WHERE host = ?', host);
      if (domainRow && domainRow.service_id) {
        targetServiceId = domainRow.service_id;
      } else if (host.endsWith(`.${BASE_DOMAIN}`)) {
        const sub = host.slice(0, -(BASE_DOMAIN.length + 1));
        const serviceRow = queryOne('SELECT id FROM services WHERE name = ?', sub);
        if (serviceRow) {
          targetServiceId = serviceRow.id;
        }
      }
    }
  }

  if (!targetServiceId) {
    return next();
  }

  const endpoint = containerSupervisor.endpointForService(targetServiceId);
  if (!endpoint) {
    return res.status(503).json({
      code: 'service_offline',
      message: 'The requested service is not currently running or deployed'
    });
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
