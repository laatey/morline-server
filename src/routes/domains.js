import { Router } from 'express';
import { execute, queryOne } from '../db/index.js';
import { mapDomain } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/error-handler.js';
import { eventBus } from '../engine/event-bus.js';

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

  eventBus.emitEnvironmentEvent(domain.environment_id, {
    type: 'domain.deleted',
    at: new Date().toISOString(),
    actorId: req.user.id,
    canvasRevision: null,
    data: { id: domain.id }
  });

  return res.status(204).end();
});

// POST /domains/:domainId/verify
router.post('/:domainId/verify', (req, res) => {
  const domain = getDomain(req.params.domainId);
  const now = new Date().toISOString();

  execute(`
    UPDATE domains SET status = 'active', tls_configured = 1, last_checked_at = ?, error = NULL
    WHERE id = ?
  `, now, domain.id);

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
});

export default router;
