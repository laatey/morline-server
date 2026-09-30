import { Router } from 'express';
import { execute, queryOne, transaction } from '../db/index.js';
import { mapConnection } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/error-handler.js';
import { eventBus } from '../engine/event-bus.js';

const router = Router();
router.use(requireAuth);

// PATCH /connections/:connectionId
router.patch('/:connectionId', (req, res, next) => {
  try {
    const connId = req.params.connectionId;
    const conn = queryOne('SELECT * FROM connections WHERE id = ?', connId);
    if (!conn) throw notFound('Connection not found');

    const { protocol, port } = req.body || {};
    const updates = [];
    const params = [];

    if (protocol) {
      updates.push('protocol = ?');
      params.push(protocol);
    }
    if (port !== undefined) {
      updates.push('port = ?');
      params.push(port);
    }

    if (updates.length > 0) {
      const newProtocol = protocol || conn.protocol;
      const newPort = port !== undefined ? port : conn.port;
      updates.push('label = ?');
      params.push(`${newProtocol} :${newPort || 80}`);

      params.push(connId);
      execute(`UPDATE connections SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const updated = queryOne('SELECT * FROM connections WHERE id = ?', connId);
    return res.json(mapConnection(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /connections/:connectionId
router.delete('/:connectionId', (req, res) => {
  const connId = req.params.connectionId;
  const conn = queryOne('SELECT * FROM connections WHERE id = ?', connId);
  if (!conn) throw notFound('Connection not found');

  const removeVars = req.query.removeVariables === 'true';

  transaction(() => {
    if (removeVars) {
      const toSrv = queryOne('SELECT name FROM services WHERE id = ?', conn.to_service_id);
      if (toSrv) {
        const key = `${toSrv.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;
        execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ? AND key = ?', 'service', conn.from_service_id, key);
      }
    }
    execute('DELETE FROM connections WHERE id = ?', connId);
  });

  eventBus.emitEnvironmentEvent(conn.environment_id, {
    type: 'connection.deleted',
    at: new Date().toISOString(),
    actorId: req.user.id,
    canvasRevision: null,
    data: { id: connId }
  });

  return res.status(204).end();
});

export default router;
