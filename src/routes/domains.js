import { Router } from 'express';
import dns from 'node:dns/promises';
import { execute, queryOne } from '../db/index.js';
import { mapDomain } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/error-handler.js';
import { eventBus } from '../engine/event-bus.js';
import { BASE_DOMAIN } from '../config.js';

const router = Router();
router.use(requireAuth);

function getDomain(domainId) {
  const domain = queryOne('SELECT * FROM domains WHERE id = ?', domainId);
  if (!domain) throw notFound('Domain not found');
  return domain;
}

// GET /domains/:domainId
router.get('/:domainId', (req, res) => {
  const domain = getDomain(req.params.domainId);
  return res.json(mapDomain(domain));
});

// PATCH /domains/:domainId
router.patch('/:domainId', (req, res, next) => {
  try {
    const domain = getDomain(req.params.domainId);
    const { serviceId, targetPort } = req.body || {};

    const updates = [];
    const params = [];

    if (serviceId !== undefined) {
      const srv = serviceId ? queryOne('SELECT name FROM services WHERE id = ?', serviceId) : null;
      updates.push('service_id = ?');
      params.push(serviceId || null);
      updates.push('service_name = ?');
      params.push(srv ? srv.name : null);
    }
    if (targetPort !== undefined) {
      updates.push('target_port = ?');
      params.push(targetPort);
    }

    if (updates.length > 0) {
      params.push(domain.id);
      execute(`UPDATE domains SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const updated = queryOne('SELECT * FROM domains WHERE id = ?', domain.id);
    const mapped = mapDomain(updated);

    eventBus.emitEnvironmentEvent(domain.environment_id, {
      type: 'domain.updated',
      at: new Date().toISOString(),
      actorId: req.user.id,
      canvasRevision: null,
      data: mapped
    });

    return res.json(mapped);
  } catch (err) {
    next(err);
  }
});

// DELETE /domains/:domainId
router.delete('/:domainId', (req, res) => {
  const domain = getDomain(req.params.domainId);
  execute('DELETE FROM domains WHERE id = ?', domain.id);

  if (domain.service_id) {
    const remaining = queryOne('SELECT host FROM domains WHERE service_id = ? ORDER BY created_at ASC LIMIT 1', domain.service_id);
    execute('UPDATE services SET primary_domain = ? WHERE id = ?', remaining ? remaining.host : null, domain.service_id);
  }

  eventBus.emitEnvironmentEvent(domain.environment_id, {
    type: 'domain.deleted',
    at: new Date().toISOString(),
    actorId: req.user.id,
    canvasRevision: null,
    data: { id: domain.id, serviceId: domain.service_id }
  });

  return res.status(204).end();
});

// POST /domains/:domainId/verify
router.post('/:domainId/verify', async (req, res, next) => {
  try {
    const domain = getDomain(req.params.domainId);
    const now = new Date().toISOString();

    // Generated domains under BASE_DOMAIN are always verified
    if (domain.kind === 'generated' || domain.host.endsWith(`.${BASE_DOMAIN}`)) {
      execute(`
        UPDATE domains SET status = 'active', tls_configured = 1, last_checked_at = ?, error = NULL
        WHERE id = ?
      `, now, domain.id);
      if (domain.service_id) {
        execute('UPDATE services SET primary_domain = ? WHERE id = ?', domain.host, domain.service_id);
      }
      const updated = queryOne('SELECT * FROM domains WHERE id = ?', domain.id);
      return res.json(mapDomain(updated));
    }

    let verified = false;
    let checkError = null;

    try {
      // 1. Check CNAME record
      const cnames = await dns.resolveCname(domain.host).catch(() => []);
      const targetEdge = `edge.${BASE_DOMAIN}`.toLowerCase();
      if (cnames.some(c => c.toLowerCase() === targetEdge || c.toLowerCase().includes(BASE_DOMAIN))) {
        verified = true;
      }
    } catch (e) {}

    // 2. Check if IP points to edge
    if (!verified) {
      try {
        const aRecords = await dns.resolve4(domain.host).catch(() => []);
        if (aRecords.length > 0) {
          const edgeAddresses = await dns.resolve4(`edge.${BASE_DOMAIN}`).catch(() => []);
          if (edgeAddresses.length > 0 && aRecords.some(ip => edgeAddresses.includes(ip))) {
            verified = true;
          } else {
            const edgeLookup = await dns.lookup(`edge.${BASE_DOMAIN}`).catch(() => null);
            if (edgeLookup && aRecords.includes(edgeLookup.address)) {
              verified = true;
            }
          }
        }
      } catch (e) {}
    }

    // 3. Fallback: check dns.lookup
    if (!verified) {
      try {
        const lookup = await dns.lookup(domain.host).catch(() => null);
        const edgeLookup = await dns.lookup(`edge.${BASE_DOMAIN}`).catch(() => null);
        if (lookup && edgeLookup && lookup.address === edgeLookup.address) {
          verified = true;
        }
      } catch (e) {}
    }

    if (verified) {
      execute(`
        UPDATE domains SET status = 'active', tls_configured = 1, last_checked_at = ?, error = NULL
        WHERE id = ?
      `, now, domain.id);
      if (domain.service_id) {
        execute('UPDATE services SET primary_domain = ? WHERE id = ?', domain.host, domain.service_id);
      }
    } else {
      checkError = `DNS not pointed to edge.${BASE_DOMAIN}`;
      execute(`
        UPDATE domains SET status = 'pending', tls_configured = 0, last_checked_at = ?, error = ?
        WHERE id = ?
      `, now, checkError, domain.id);
    }

    const updated = queryOne('SELECT * FROM domains WHERE id = ?', domain.id);
    const mapped = mapDomain(updated);

    eventBus.emitEnvironmentEvent(domain.environment_id, {
      type: 'domain.updated',
      at: now,
      actorId: req.user.id,
      canvasRevision: null,
      data: mapped
    });

    return res.json(mapped);
  } catch (err) {
    next(err);
  }
});

export default router;
