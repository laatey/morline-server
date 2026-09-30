import { Router } from 'express';
import { queryOne, queryAll } from '../db/index.js';
import { mapTemplate, mapRegion } from '../db/mappers.js';
import { notFound } from '../middleware/error-handler.js';

const router = Router();

// GET /templates
router.get('/templates', (req, res) => {
  const { q, group } = req.query;
  let sql = 'SELECT * FROM templates WHERE 1=1';
  const params = [];

  if (group) {
    sql += ' AND "group" = ?';
    params.push(group);
  }
  if (q) {
    sql += ' AND (name LIKE ? OR hint LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  sql += ' ORDER BY id ASC';
  const rows = queryAll(sql, ...params);
  return res.json({ data: rows.map(mapTemplate) });
});

// GET /templates/:templateId
router.get('/templates/:templateId', (req, res) => {
  const row = queryOne('SELECT * FROM templates WHERE id = ?', req.params.templateId);
  if (!row) throw notFound('Template not found');
  return res.json(mapTemplate(row));
});

// GET /regions
router.get('/regions', (req, res) => {
  const rows = queryAll('SELECT * FROM regions ORDER BY id ASC');
  return res.json({ data: rows.map(mapRegion) });
});

export default router;
