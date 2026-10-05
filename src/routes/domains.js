import { Router } from 'express';
import dns from 'node:dns/promises';
import { execute, queryOne } from '../db/index.js';
import { mapDomain } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, validationError } from '../middleware/error-handler.js';
import { eventBus } from '../engine/event-bus.js';
import { checkDomain, emitDomainUpdate } from '../engine/domain-manager.js';

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
      const srv = serviceId ? queryOne('SELECT name, environment_id FROM services WHERE id = ?', serviceId) : null;
      if (serviceId && (!srv || srv.environment_id !== domain.environment_id)) {
        throw validationError('That service is not in the same environment as this domain', { serviceId: 'Not found in this environment' });
      }
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
// Checks the TXT ownership record and that the domain points at the edge, then records the result.
router.post('/:domainId/verify', async (req, res, next) => {
  try {
    const domain = getDomain(req.params.domainId);
    if (domain.kind !== 'custom') {
      // Hosts under the base domain are ours and always live.
      execute("UPDATE domains SET status = 'active', tls_configured = 1, last_checked_at = ?, error = NULL WHERE id = ?", new Date().toISOString(), domain.id);
      return res.json(mapDomain(getDomain(domain.id)));
    }
    const { row } = await checkDomain(domain, req.user.id);
    const mapped = mapDomain(row);
    emitDomainUpdate(row, mapDomain, req.user.id);
    return res.json(mapped);
  } catch (err) {
    next(err);
  }
});

export default router;
