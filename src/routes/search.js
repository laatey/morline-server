import { Router } from 'express';
import { queryAll } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validationError } from '../middleware/error-handler.js';

const router = Router();
router.use(requireAuth);

// GET /search
router.get('/', (req, res, next) => {
  try {
    const { q, teamId, projectId } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      throw validationError('Search query q is required');
    }
    if (!teamId) {
      throw validationError('teamId is required');
    }

    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const types = req.query.types ? (Array.isArray(req.query.types) ? req.query.types : [req.query.types]) : ['project', 'service', 'deployment', 'domain', 'variable'];

    const pattern = `%${q.trim()}%`;
    const results = [];

    // Projects
    if (types.includes('project')) {
      const projRows = queryAll(`
        SELECT id, name, description FROM projects
        WHERE team_id = ? AND name LIKE ?
        LIMIT ?
      `, teamId, pattern, limit);

      for (const p of projRows) {
        results.push({
          type: 'project',
          id: p.id,
          title: p.name,
          subtitle: p.description || 'Project',
          logo: null,
          projectId: p.id,
          environmentId: null,
          targetUrl: `/projects/${p.id}`
        });
      }
    }

    // Services
    if (types.includes('service')) {
      let sql = `
        SELECT s.id, s.name, s.logo, s.environment_id, e.project_id
        FROM services s
        JOIN environments e ON e.id = s.environment_id
        JOIN projects p ON p.id = e.project_id
        WHERE p.team_id = ? AND s.name LIKE ?
      `;
      const params = [teamId, pattern];
      if (projectId) {
        sql += ' AND p.id = ?';
        params.push(projectId);
      }
      sql += ' LIMIT ?';
      params.push(limit);

      const srvRows = queryAll(sql, ...params);
      for (const s of srvRows) {
        results.push({
          type: 'service',
          id: s.id,
          title: s.name,
          subtitle: `Service in project`,
          logo: s.logo,
          projectId: s.project_id,
          environmentId: s.environment_id,
          targetUrl: `/projects/${s.project_id}/services/${s.id}`
        });
      }
    }

    // Deployments
    if (types.includes('deployment')) {
      let sql = `
        SELECT d.id, d.service_name, d.commit_message, d.environment_id, e.project_id
        FROM deployments d
        JOIN environments e ON e.id = d.environment_id
        JOIN projects p ON p.id = e.project_id
        WHERE p.team_id = ? AND (d.service_name LIKE ? OR d.commit_message LIKE ?)
      `;
      const params = [teamId, pattern, pattern];
      if (projectId) {
        sql += ' AND p.id = ?';
        params.push(projectId);
      }
      sql += ' LIMIT ?';
      params.push(limit);

      const depRows = queryAll(sql, ...params);
      for (const d of depRows) {
        results.push({
          type: 'deployment',
          id: d.id,
          title: `${d.service_name} deploy`,
          subtitle: d.commit_message || 'Deployment',
          logo: null,
          projectId: d.project_id,
          environmentId: d.environment_id,
          targetUrl: `/projects/${d.project_id}/deployments/${d.id}`
        });
      }
    }

    // Domains
    if (types.includes('domain')) {
      const domRows = queryAll(`
        SELECT dm.id, dm.host, dm.environment_id, e.project_id
        FROM domains dm
        JOIN environments e ON e.id = dm.environment_id
        JOIN projects p ON p.id = e.project_id
        WHERE p.team_id = ? AND dm.host LIKE ?
        LIMIT ?
      `, teamId, pattern, limit);

      for (const dm of domRows) {
        results.push({
          type: 'domain',
          id: dm.id,
          title: dm.host,
          subtitle: 'Domain',
          logo: null,
          projectId: dm.project_id,
          environmentId: dm.environment_id,
          targetUrl: `/projects/${dm.project_id}/settings/domains`
        });
      }
    }

    // Variables
    if (types.includes('variable')) {
      const varRows = queryAll(`
        SELECT v.id, v.key, v.scope_id, v.scope_type, e.project_id, e.id as env_id
        FROM variables v
        LEFT JOIN environments e ON (v.scope_type = 'environment' AND e.id = v.scope_id)
        LEFT JOIN services s ON (v.scope_type = 'service' AND s.id = v.scope_id)
        LEFT JOIN projects p ON (e.project_id = p.id OR s.environment_id = e.id)
        WHERE v.key LIKE ?
        LIMIT ?
      `, pattern, limit);

      for (const v of varRows) {
        results.push({
          type: 'variable',
          id: v.id,
          title: v.key,
          subtitle: `Variable (${v.scope_type})`,
          logo: null,
          projectId: v.project_id || null,
          environmentId: v.env_id || null,
          targetUrl: v.project_id ? `/projects/${v.project_id}/variables` : '/variables'
        });
      }
    }

    return res.json({ data: results.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

export default router;
