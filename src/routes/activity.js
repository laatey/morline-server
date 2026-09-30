import { Router } from 'express';
import { queryAll } from '../db/index.js';
import { mapActivity } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use('/projects/:projectId/activity', requireAuth);

// GET /projects/:projectId/activity
router.get('/projects/:projectId/activity', (req, res) => {
  const projectId = req.params.projectId;
  const limit = parseInt(req.query.limit || '20', 10);
  const cursor = req.query.cursor;
  const environmentId = req.query.environmentId;
  const serviceId = req.query.serviceId;
  const types = req.query.type ? (Array.isArray(req.query.type) ? req.query.type : [req.query.type]) : null;

  let sql = 'SELECT * FROM activity WHERE project_id = ?';
  const params = [projectId];

  if (environmentId) {
    sql += ' AND environment_id = ?';
    params.push(environmentId);
  }
  if (serviceId) {
    sql += ' AND service_id = ?';
    params.push(serviceId);
  }
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',');
    sql += ` AND type IN (${placeholders})`;
    params.push(...types);
  }
  if (cursor) {
    sql += ' AND created_at < ?';
    params.push(cursor);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);

  const rows = queryAll(sql, ...params);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1].created_at : null;

  return res.json({
    data: items.map(mapActivity),
    nextCursor
  });
});

export default router;
