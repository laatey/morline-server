import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { buildManager } from '../engine/build-manager.js';
import { privateHostname } from '../engine/private-network.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

function mapChange(row) {
  return {
    id: row.id,
    serviceId: row.service_id || null,
    serviceName: row.service_name || null,
    type: row.type,
    summary: row.summary,
    payload: row.payload ? JSON.parse(row.payload) : {},
    createdAt: row.created_at
  };
}

// GET /environments/:envId/staged-changes
router.get('/', (req, res) => {
  const { envId } = req.params;
  const rows = queryAll('SELECT * FROM staged_changes WHERE environment_id = ? ORDER BY created_at DESC', envId);
  return res.json({ data: rows.map(mapChange) });
});

// POST /environments/:envId/staged-changes/deploy
router.post('/deploy', async (req, res, next) => {
  try {
    const { envId } = req.params;
    const changes = queryAll('SELECT DISTINCT service_id FROM staged_changes WHERE environment_id = ? AND service_id IS NOT NULL', envId);

    const deployments = [];
    for (const { service_id } of changes) {
      const service = queryOne('SELECT * FROM services WHERE id = ?', service_id);
      if (!service) continue;

      const depId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const now = new Date().toISOString();

      execute(`
        INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, created_by, created_at)
        VALUES (?, ?, ?, ?, 'queued', 'staged_deploy', ?, ?)
      `, depId, service_id, service.name, envId, req.user.id, now);

      buildManager.buildAndDeploy(service_id, depId).catch(err => {
        console.error('[StagedDeploy Error]', err);
      });

      deployments.push({ serviceId: service_id, serviceName: service.name, deploymentId: depId });
    }

    // Clear all staged changes for this environment
    execute('DELETE FROM staged_changes WHERE environment_id = ?', envId);

    return res.json({ deployed: deployments.length, deployments });
  } catch (err) {
    next(err);
  }
});

// DELETE /environments/:envId/staged-changes  (undo & clear)
router.delete('/', (req, res, next) => {
  try {
    const { envId } = req.params;
    const changes = queryAll('SELECT * FROM staged_changes WHERE environment_id = ? ORDER BY created_at ASC', envId);

    // Revert each change using its stored payload
    for (const change of changes) {
      try {
        const payload = JSON.parse(change.payload || '{}');
        if (change.type === 'variable' && change.service_id) {
          // Revert variable changes: restore previous state
          if (payload.action === 'upsert' && payload.previous !== undefined) {
            if (payload.previous === null) {
              execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ? AND key = ?', 'service', change.service_id, payload.key);
            } else {
              execute('UPDATE variables SET value = ?, secret = ?, updated_at = ? WHERE scope_type = ? AND scope_id = ? AND key = ?',
                payload.previous.value, payload.previous.secret ? 1 : 0, new Date().toISOString(), 'service', change.service_id, payload.key);
            }
          } else if (payload.action === 'delete' && payload.previous) {
            const now = new Date().toISOString();
            execute(`INSERT OR IGNORE INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at) VALUES (?, 'service', ?, ?, ?, ?, ?, ?)`,
              `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, change.service_id, payload.key, payload.previous.value, payload.previous.secret ? 1 : 0, now, now);
          } else if (payload.action === 'bulk_replace' && Array.isArray(payload.previous)) {
            const now = new Date().toISOString();
            execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ?', 'service', change.service_id);
            for (const v of payload.previous) {
              execute(`INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at) VALUES (?, 'service', ?, ?, ?, ?, ?, ?)`,
                `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, change.service_id, v.key, v.value, v.secret ? 1 : 0, now, now);
            }
          }
        } else if (change.type === 'settings' && change.service_id && payload.previous) {
          const prev = payload.previous;
          const updates = [];
          const params = [];
          Object.entries(prev).forEach(([k, v]) => { updates.push(`${k} = ?`); params.push(v); });
          if (updates.length) {
            params.push(change.service_id);
            execute(`UPDATE service_settings SET ${updates.join(', ')} WHERE service_id = ?`, ...params);
          }
        } else if (change.type === 'source' && change.service_id && payload.previous) {
          const prev = payload.previous;
          execute('UPDATE services SET source_repo = ?, source_branch = ?, updated_at = ? WHERE id = ?',
            prev.repo || null, prev.branch || null, new Date().toISOString(), change.service_id);
        } else if (change.type === 'connection.created') {
          // Revert created connection: remove connection and injected variable
          const conn = payload.connectionId ? queryOne('SELECT * FROM connections WHERE id = ?', payload.connectionId)
            : (payload.fromServiceId && payload.toServiceId) ? queryOne('SELECT * FROM connections WHERE from_service_id = ? AND to_service_id = ?', payload.fromServiceId, payload.toServiceId) : null;
          if (conn) {
            const toSrv = queryOne('SELECT name FROM services WHERE id = ?', conn.to_service_id);
            if (toSrv) {
              const key = `${toSrv.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;
              execute('DELETE FROM variables WHERE scope_type = ? AND scope_id = ? AND key = ?', 'service', conn.from_service_id, key);
            }
            execute('DELETE FROM connections WHERE id = ?', conn.id);
          }
        } else if (change.type === 'connection.deleted' && payload.fromServiceId && payload.toServiceId) {
          // Revert deleted connection: restore connection row and variable
          const existing = queryOne('SELECT id FROM connections WHERE from_service_id = ? AND to_service_id = ?', payload.fromServiceId, payload.toServiceId);
          if (!existing) {
            const now = new Date().toISOString();
            const connId = payload.connectionId || `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
            execute(`
              INSERT INTO connections (id, environment_id, from_service_id, to_service_id, protocol, port, label, created_at)
              VALUES (?, ?, ?, ?, 'http', 3000, 'http :3000', ?)
            `, connId, envId, payload.fromServiceId, payload.toServiceId, now);

            const toSrv = queryOne('SELECT * FROM services WHERE id = ?', payload.toServiceId);
            if (toSrv) {
              const key = `${toSrv.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL`;
              const val = `http://${privateHostname(toSrv)}:3000`;
              execute(`
                INSERT INTO variables (id, scope_type, scope_id, key, value, secret, is_reference, source, created_at, updated_at)
                VALUES (?, 'service', ?, ?, ?, 0, 1, ?, ?, ?)
                ON CONFLICT(scope_type, scope_id, key) DO UPDATE SET value = excluded.value
              `, `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, payload.fromServiceId, key, val, toSrv.name, now, now);
            }
          }
        }
      } catch (e) {
        console.error('[StagedUndo] Failed to revert change', change.id, e.message);
      }
    }

    execute('DELETE FROM staged_changes WHERE environment_id = ?', envId);
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
