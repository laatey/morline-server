import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapTeam, mapMember, mapProject, mapUserRef } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, forbidden, conflict, validationError } from '../middleware/error-handler.js';
import { buildManager } from '../engine/build-manager.js';
import { sendTeamInviteEmail } from '../services/email.js';

const router = Router();

function checkTeamRole(teamId, userId, allowedRoles = ['owner', 'admin']) {
  const member = queryOne('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  if (!member) {
    throw notFound('Team not found or you are not a member');
  }
  if (!allowedRoles.includes(member.role)) {
    throw forbidden(`Requires role ${allowedRoles.join(' or ')}`);
  }
  return member.role;
}

// GET /teams
router.get('/teams', requireAuth, (req, res) => {
  const rows = queryAll(`
    SELECT t.*, tm.role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at ASC
  `, req.user.id);

  const data = rows.map(r => mapTeam(r, r.role, r.member_count));
  return res.json({ data });
});

// POST /teams
router.post('/teams', requireAuth, (req, res, next) => {
  try {
    const { name, slug } = req.body || {};
    if (!name) throw validationError('Name is required');

    const cleanSlug = (slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-')).slice(0, 50);
    const existing = queryOne('SELECT id FROM teams WHERE slug = ?', cleanSlug);
    if (existing) {
      throw conflict('A team with this slug already exists', 'slug_taken');
    }

    const teamId = `tem_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    transaction(() => {
      execute(`
        INSERT INTO teams (id, name, slug, plan, created_at, updated_at)
        VALUES (?, ?, ?, 'hobby', ?, ?)
      `, teamId, name, cleanSlug, now, now);

      execute(`
        INSERT INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', ?)
      `, teamId, req.user.id, now);
    });

    const teamRow = queryOne('SELECT * FROM teams WHERE id = ?', teamId);
    return res.status(201).json(mapTeam(teamRow, 'owner', 1));
  } catch (err) {
    next(err);
  }
});

// GET /teams/:teamId
router.get('/teams/:teamId', requireAuth, (req, res) => {
  const teamId = req.params.teamId;
  const member = queryOne('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, req.user.id);
  if (!member) throw notFound('Team not found');

  const teamRow = queryOne(`
    SELECT t.*,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t WHERE t.id = ?
  `, teamId);

  return res.json(mapTeam(teamRow, member.role, teamRow.member_count));
});

// PATCH /teams/:teamId
router.patch('/teams/:teamId', requireAuth, (req, res, next) => {
  try {
    const teamId = req.params.teamId;
    checkTeamRole(teamId, req.user.id, ['owner', 'admin']);

    const { name, slug } = req.body || {};
    const updates = [];
    const params = [];

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }
    if (slug) {
      const existing = queryOne('SELECT id FROM teams WHERE slug = ? AND id != ?', slug, teamId);
      if (existing) throw conflict('Slug already in use', 'slug_taken');
      updates.push('slug = ?');
      params.push(slug);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(teamId);
      execute(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const teamRow = queryOne(`
      SELECT t.*,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
      FROM teams t WHERE t.id = ?
    `, teamId);
    const member = queryOne('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, req.user.id);

    return res.json(mapTeam(teamRow, member.role, teamRow.member_count));
  } catch (err) {
    next(err);
  }
});

// DELETE /teams/:teamId
router.delete('/teams/:teamId', requireAuth, (req, res) => {
  const teamId = req.params.teamId;
  checkTeamRole(teamId, req.user.id, ['owner']);
  execute('DELETE FROM teams WHERE id = ?', teamId);
  return res.status(204).end();
});

// GET /teams/:teamId/members
router.get('/teams/:teamId/members', requireAuth, (req, res) => {
  const teamId = req.params.teamId;
  checkTeamRole(teamId, req.user.id, ['owner', 'admin', 'member', 'viewer']);

  const rows = queryAll(`
    SELECT tm.role, tm.joined_at, u.id as user_id, u.name, u.username, u.avatar_url
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ?
    ORDER BY tm.joined_at ASC
  `, teamId);

  const data = rows.map(r => ({
    user: {
      id: r.user_id,
      name: r.name,
      username: r.username || null,
      avatarUrl: r.avatar_url || null
    },
    role: r.role,
    joinedAt: r.joined_at
  }));

  return res.json({ data });
});

// POST /teams/:teamId/invites
router.post('/teams/:teamId/invites', requireAuth, (req, res, next) => {
  try {
    const teamId = req.params.teamId;
    checkTeamRole(teamId, req.user.id, ['owner', 'admin']);

    const { email, role = 'member' } = req.body || {};
    if (!email) throw validationError('Email is required');

    const inviteId = `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const token = `tok_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 86400000).toISOString();

    execute(`
      INSERT INTO team_invites (id, team_id, email, role, token, invited_by, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, inviteId, teamId, email.toLowerCase(), role, token, req.user.id, expiresAt, now.toISOString());

    const team = queryOne('SELECT name FROM teams WHERE id = ?', teamId);

    // Send invite email (non-blocking)
    sendTeamInviteEmail({
      to: email.toLowerCase(),
      inviterName: req.user.name || 'Someone',
      teamName: team?.name || 'Morline Team',
      role,
      token
    }).catch(() => {});

    return res.status(201).json({
      id: inviteId,
      email: email.toLowerCase(),
      role,
      invitedBy: mapUserRef(req.user),
      token,
      expiresAt,
      createdAt: now.toISOString()
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /teams/:teamId/invites/:inviteId
router.delete('/teams/:teamId/invites/:inviteId', requireAuth, (req, res) => {
  const { teamId, inviteId } = req.params;
  checkTeamRole(teamId, req.user.id, ['owner', 'admin']);
  execute('DELETE FROM team_invites WHERE id = ? AND team_id = ?', inviteId, teamId);
  return res.status(204).end();
});

// POST /invites/:token/accept
router.post('/invites/:token/accept', requireAuth, (req, res, next) => {
  try {
    const token = req.params.token;
    const invite = queryOne('SELECT * FROM team_invites WHERE token = ?', token);
    if (!invite || new Date(invite.expires_at) < new Date()) {
      throw notFound('Invite not found or expired', 'invite_invalid');
    }

    const now = new Date().toISOString();
    transaction(() => {
      execute(`
        INSERT INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role
      `, invite.team_id, req.user.id, invite.role, now);

      execute('DELETE FROM team_invites WHERE id = ?', invite.id);
    });

    const teamRow = queryOne(`
      SELECT t.*,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
      FROM teams t WHERE t.id = ?
    `, invite.team_id);

    return res.json(mapTeam(teamRow, invite.role, teamRow.member_count));
  } catch (err) {
    next(err);
  }
});

// PATCH /teams/:teamId/members/:userId
router.patch('/teams/:teamId/members/:userId', requireAuth, (req, res, next) => {
  try {
    const { teamId, userId } = req.params;
    checkTeamRole(teamId, req.user.id, ['owner', 'admin']);

    const { role } = req.body || {};
    if (!role) throw validationError('Role is required');

    execute('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId);

    const targetUser = queryOne('SELECT * FROM users WHERE id = ?', userId);
    return res.json({
      user: mapUserRef(targetUser),
      role,
      joinedAt: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /teams/:teamId/members/:userId
router.delete('/teams/:teamId/members/:userId', requireAuth, (req, res) => {
  const { teamId, userId } = req.params;
  checkTeamRole(teamId, req.user.id, ['owner', 'admin']);
  execute('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  return res.status(204).end();
});

// GET /teams/:teamId/projects
router.get('/teams/:teamId/projects', requireAuth, (req, res) => {
  const teamId = req.params.teamId;
  checkTeamRole(teamId, req.user.id, ['owner', 'admin', 'member', 'viewer']);

  const projects = queryAll('SELECT * FROM projects WHERE team_id = ? ORDER BY updated_at DESC', teamId);
  const data = projects.map(p => {
    const env = queryOne('SELECT * FROM environments WHERE id = ?', p.default_environment_id) || {};
    const serviceRows = queryAll('SELECT * FROM services WHERE environment_id = ?', env.id || '');
    const onlineServices = serviceRows.filter(s => s.status === 'online');

    let health = 'empty';
    if (serviceRows.length > 0) {
      if (onlineServices.length === serviceRows.length) health = 'healthy';
      else if (serviceRows.some(s => s.status === 'crashed')) health = 'degraded';
      else if (serviceRows.some(s => s.status === 'deploying')) health = 'deploying';
      else health = 'sleeping';
    }

    const lastDeploy = queryOne('SELECT created_at FROM deployments WHERE environment_id = ? ORDER BY created_at DESC LIMIT 1', env.id || '');
    const isFav = queryOne('SELECT 1 FROM user_favorites WHERE user_id = ? AND project_id = ?', req.user.id, p.id);

    return {
      ...mapProject(p, Boolean(isFav)),
      health,
      region: {
        id: p.settings_default_region || 'us-east-1',
        name: 'US East (N. Virginia)',
        countryCode: 'US',
        available: true
      },
      environmentName: env.name || 'production',
      serviceCount: serviceRows.length,
      onlineServiceCount: onlineServices.length,
      latencyMs: onlineServices.length > 0 ? 42 : null,
      lastDeployAt: lastDeploy ? lastDeploy.created_at : null,
      preview: {
        nodes: serviceRows.map(s => ({
          serviceId: s.id,
          name: s.name,
          logo: s.logo,
          status: s.status,
          x: s.position_x,
          y: s.position_y
        })),
        edges: []
      }
    };
  });

  return res.json({ data });
});

// POST /teams/:teamId/projects
router.post('/teams/:teamId/projects', requireAuth, async (req, res, next) => {
  try {
    const teamId = req.params.teamId;
    checkTeamRole(teamId, req.user.id, ['owner', 'admin', 'member']);

    const { name, description, region = 'us-east-1', source = 'empty', github, templateId, image } = req.body || {};
    if (!name) throw validationError('Name is required');

    const projectId = `prj_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const envId = `env_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    transaction(() => {
      execute(`
        INSERT INTO projects (id, team_id, name, description, default_environment_id, settings_default_region, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, projectId, teamId, name, description || null, envId, region, now, now);

      execute(`
        INSERT INTO environments (id, project_id, name, type, protected, canvas_revision, created_at, updated_at)
        VALUES (?, ?, 'production', 'production', 1, 1, ?, ?)
      `, envId, projectId, now, now);

      execute(`
        INSERT INTO activity (id, project_id, environment_id, type, actor_id, actor_type, actor_name, actor_avatar_url, summary, target_url, created_at)
        VALUES (?, ?, ?, 'project.create', ?, 'user', ?, ?, ?, ?, ?)
      `, `act_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
        projectId, envId, req.user.id, req.user.name, req.user.avatar_url,
        `Created project ${name}`, `/projects/${projectId}`, now);
    });

    // If template specified, create starter service!
    if (templateId) {
      const template = queryOne('SELECT * FROM templates WHERE id = ?', templateId);
      const serviceId = `srv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const srvName = template ? template.id : 'web-app';

      transaction(() => {
        execute(`
          INSERT INTO services (id, environment_id, name, kind, logo, status, position_x, position_y, source_type, source_template_id, region, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'queued', 100, 100, 'template', ?, ?, ?, ?)
        `, serviceId, envId, srvName, template?.kind || 'app', template?.logo || 'js', templateId, region, now, now);

        execute(`
          INSERT INTO service_settings (service_id, start_command, auto_deploy)
          VALUES (?, 'node server.js', 1)
        `, serviceId);

        execute(`
          INSERT INTO service_networking (service_id, public, target_port)
          VALUES (?, 1, 3000)
        `, serviceId);
      });

      // Launch deployment
      const depId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      execute(`
        INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, created_by, created_at)
        VALUES (?, ?, ?, ?, 'queued', 'template', ?, ?)
      `, depId, serviceId, srvName, envId, req.user.id, now);

      buildManager.buildAndDeploy(serviceId, depId).catch(err => {
        console.error('[BuildManager] Deploy error:', err);
      });
    }

    // If a public GitHub URL is provided, create a service with anonymous clone
    const sourceUrlRaw = req.body?.source?.url || null;
    if (sourceUrlRaw) {
      const serviceId = `srv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const sourceRepo = sourceUrlRaw.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      const srvName = sourceRepo.split('/').pop() || name;
      const sourceBranch = req.body?.source?.branch || 'main';

      transaction(() => {
        execute(`
          INSERT INTO services (id, environment_id, name, kind, logo, status, position_x, position_y, source_type, source_repo, source_branch, source_url, region, created_at, updated_at)
          VALUES (?, ?, ?, 'app', 'js', 'queued', 100, 100, 'github', ?, ?, ?, ?, ?, ?)
        `, serviceId, envId, srvName, sourceRepo, sourceBranch, sourceUrlRaw, region, now, now);

        execute(`
          INSERT INTO service_settings (service_id, branch, auto_deploy)
          VALUES (?, ?, 1)
        `, serviceId, sourceBranch);

        execute(`
          INSERT INTO service_networking (service_id, public, target_port)
          VALUES (?, 1, 3000)
        `, serviceId);
      });

      const depId = `dep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      execute(`
        INSERT INTO deployments (id, service_id, service_name, environment_id, state, trigger, created_by, created_at)
        VALUES (?, ?, ?, ?, 'queued', 'manual', ?, ?)
      `, depId, serviceId, srvName, envId, req.user.id, now);

      buildManager.buildAndDeploy(serviceId, depId).catch(err => {
        console.error('[BuildManager] Deploy error:', err);
      });
    }

    const proj = queryOne('SELECT * FROM projects WHERE id = ?', projectId);
    return res.status(201).json(mapProject(proj, false));
  } catch (err) {
    next(err);
  }
});

export default router;
