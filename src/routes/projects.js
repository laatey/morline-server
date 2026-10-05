import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapProject, mapEnvironment } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, forbidden, validationError } from '../middleware/error-handler.js';
import { projectUsage, RATES } from '../engine/usage-meter.js';

const router = Router();
router.use(requireAuth);

function checkProjectAccess(projectId, userId) {
  const project = queryOne('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) throw notFound('Project not found');

  const member = queryOne('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', project.team_id, userId);
  if (!member) throw forbidden('You do not have access to this project');

  return { project, role: member.role };
}

// GET /projects/:projectId
router.get('/:projectId', (req, res) => {
  const { project } = checkProjectAccess(req.params.projectId, req.user.id);
  const isFav = queryOne('SELECT 1 FROM user_favorites WHERE user_id = ? AND project_id = ?', req.user.id, project.id);
  return res.json(mapProject(project, Boolean(isFav)));
});

// PATCH /projects/:projectId
router.patch('/:projectId', (req, res, next) => {
  try {
    const { project } = checkProjectAccess(req.params.projectId, req.user.id);
    const { name, description, settings } = req.body || {};

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }
    if (settings) {
      if (settings.prEnvironments !== undefined) {
        updates.push('settings_pr_environments = ?');
        params.push(settings.prEnvironments ? 1 : 0);
      }
      if (settings.spendLimitUsd !== undefined) {
        updates.push('settings_spend_limit_usd = ?');
        params.push(settings.spendLimitUsd);
      }
      if (settings.defaultRegion !== undefined) {
        updates.push('settings_default_region = ?');
        params.push(settings.defaultRegion);
      }
      if (settings.baseEnvironmentId !== undefined) {
        updates.push('settings_base_environment_id = ?');
        params.push(settings.baseEnvironmentId);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(project.id);
      execute(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const updated = queryOne('SELECT * FROM projects WHERE id = ?', project.id);
    const isFav = queryOne('SELECT 1 FROM user_favorites WHERE user_id = ? AND project_id = ?', req.user.id, project.id);
    return res.json(mapProject(updated, Boolean(isFav)));
  } catch (err) {
    next(err);
  }
});

// DELETE /projects/:projectId
router.delete('/:projectId', (req, res) => {
  const { project } = checkProjectAccess(req.params.projectId, req.user.id);
  execute('DELETE FROM projects WHERE id = ?', project.id);
  return res.status(204).end();
});

// POST /projects/:projectId/duplicate
router.post('/:projectId/duplicate', (req, res, next) => {
  try {
    const { project } = checkProjectAccess(req.params.projectId, req.user.id);
    const { name, teamId = project.team_id, includeVariables = false } = req.body || {};

    if (!name) throw validationError('Name is required');

    const newProjectId = `prj_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const newEnvId = `env_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    transaction(() => {
      execute(`
        INSERT INTO projects (id, team_id, name, description, default_environment_id, settings_default_region, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, newProjectId, teamId, name, project.description, newEnvId, project.settings_default_region, now, now);

      execute(`
        INSERT INTO environments (id, project_id, name, type, protected, canvas_revision, created_at, updated_at)
        VALUES (?, ?, 'production', 'production', 1, 1, ?, ?)
      `, newEnvId, newProjectId, now, now);
    });

    const newProj = queryOne('SELECT * FROM projects WHERE id = ?', newProjectId);
    return res.status(202).json(mapProject(newProj, false));
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/transfer
router.post('/:projectId/transfer', (req, res, next) => {
  try {
    const { project } = checkProjectAccess(req.params.projectId, req.user.id);
    const { teamId } = req.body || {};
    if (!teamId) throw validationError('Target teamId is required');

    const targetMember = queryOne('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, req.user.id);
    if (!targetMember || !['owner', 'admin'].includes(targetMember.role)) {
      throw forbidden('You must be an owner or admin of the destination team');
    }

    execute('UPDATE projects SET team_id = ?, updated_at = ? WHERE id = ?', teamId, new Date().toISOString(), project.id);
    const updated = queryOne('SELECT * FROM projects WHERE id = ?', project.id);
    return res.json(mapProject(updated, false));
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/favorite
router.put('/:projectId/favorite', (req, res) => {
  const { project } = checkProjectAccess(req.params.projectId, req.user.id);
  execute(`
    INSERT INTO user_favorites (user_id, project_id)
    VALUES (?, ?)
    ON CONFLICT DO NOTHING
  `, req.user.id, project.id);
  return res.status(204).end();
});

// DELETE /projects/:projectId/favorite
router.delete('/:projectId/favorite', (req, res) => {
  const { project } = checkProjectAccess(req.params.projectId, req.user.id);
  execute('DELETE FROM user_favorites WHERE user_id = ? AND project_id = ?', req.user.id, project.id);
  return res.status(204).end();
});

// GET /projects/:projectId/usage
router.get('/:projectId/usage', (req, res) => {
  const { project } = checkProjectAccess(req.params.projectId, req.user.id);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  // Measured, usage-based cost for the calendar month (see engine/usage-meter.js).
  const { spentUsd, estimatedUsd, breakdown, services } = projectUsage(project.id, now);
  const limitUsd = project.settings_spend_limit_usd || null;
  const limitReached = limitUsd !== null ? spentUsd >= limitUsd : false;

  return res.json({
    periodStart: startOfMonth,
    periodEnd: endOfMonth,
    spentUsd,
    estimatedUsd,
    limitUsd,
    limitReached,
    breakdown,
    services,
    rates: RATES
  });
});

// GET /projects/:projectId/environments
router.get('/:projectId/environments', (req, res) => {
  const { project } = checkProjectAccess(req.params.projectId, req.user.id);
  const rows = queryAll(`
    SELECT e.*,
      (SELECT COUNT(*) FROM services WHERE environment_id = e.id) as service_count
    FROM environments e
    WHERE e.project_id = ?
    ORDER BY e.created_at ASC
  `, project.id);

  const data = rows.map(r => mapEnvironment(r, r.service_count));
  return res.json({ data });
});

// POST /projects/:projectId/environments
router.post('/:projectId/environments', (req, res, next) => {
  try {
    const { project } = checkProjectAccess(req.params.projectId, req.user.id);
    const { name, type = 'preview', protected: isProtected = false, forkFromEnvironmentId = null } = req.body || {};

    if (!name) throw validationError('Environment name is required');

    const envId = `env_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    execute(`
      INSERT INTO environments (id, project_id, name, type, protected, forked_from_environment_id, canvas_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `, envId, project.id, name, type, isProtected ? 1 : 0, forkFromEnvironmentId, now, now);

    const created = queryOne('SELECT * FROM environments WHERE id = ?', envId);
    return res.status(201).json(mapEnvironment(created, 0));
  } catch (err) {
    next(err);
  }
});

export default router;
