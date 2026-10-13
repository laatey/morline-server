import { destroyTeam } from '../services/service-cleanup.js';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapUser, mapTeam, mapUserSettings, mapOnboardingState } from '../db/mappers.js';
import { requireAuth } from '../middleware/auth.js';
import { conflict, unauthorized, validationError } from '../middleware/error-handler.js';
import { DATA_DIR, PUBLIC_URL } from '../config.js';

const router = Router();
router.use(requireAuth);

const avatarsDir = path.join(DATA_DIR, 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const upload = multer({
  dest: avatarsDir,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// GET /me
router.get('/', (req, res) => {
  const user = req.user;
  const userRow = queryOne('SELECT * FROM users WHERE id = ?', user.id);
  const settingsRow = queryOne('SELECT * FROM user_settings WHERE user_id = ?', user.id);
  const onboardingRow = queryOne('SELECT * FROM onboarding_state WHERE user_id = ?', user.id);

  // Teams user is a member of
  const teamRows = queryAll(`
    SELECT t.*, tm.role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at ASC
  `, user.id);

  const teams = teamRows.map(t => mapTeam(t, t.role, t.member_count));
  const githubRow = queryOne('SELECT * FROM github_integration WHERE team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)', user.id);

  const me = {
    ...mapUser(userRow),
    teams,
    defaultTeamId: settingsRow?.default_team_id || (teams[0] ? teams[0].id : null),
    onboarding: mapOnboardingState(onboardingRow),
    githubConnected: Boolean(githubRow && githubRow.connected)
  };

  return res.json(me);
});

// PATCH /me
router.patch('/', (req, res, next) => {
  try {
    const { name, username, avatarUrl } = req.body || {};
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (username !== undefined) {
      if (username) {
        const existing = queryOne('SELECT id FROM users WHERE username = ? AND id != ?', username, req.user.id);
        if (existing) {
          throw conflict('Username is already taken', 'username_taken');
        }
      }
      updates.push('username = ?');
      params.push(username || null);
    }
    if (avatarUrl !== undefined) {
      updates.push('avatar_url = ?');
      params.push(avatarUrl);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(req.user.id);
      execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...params);
    }

    const updated = queryOne('SELECT * FROM users WHERE id = ?', req.user.id);
    return res.json(mapUser(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /me
router.delete('/', async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== req.user.email) {
      throw validationError('Confirmation email does not match user email', { confirm: 'Does not match' });
    }

    // Check if user is sole owner of any team with other members
    const ownedTeams = queryAll(`
      SELECT t.id, t.name,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as total_members,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id AND role = 'owner') as owner_count
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ? AND tm.role = 'owner'
    `, req.user.id);

    for (const team of ownedTeams) {
      if (team.total_members > 1 && team.owner_count === 1) {
        return res.status(409).json({
          code: 'sole_owner',
          message: `You are the sole owner of team "${team.name}". Transfer ownership or remove other members before deleting your account.`
        });
      }
    }

    for (const team of ownedTeams) {
      if (team.total_members <= 1) await destroyTeam(team.id);
    }
    transaction(() => {
      // Delete user's own teams where they are the only member
      for (const team of ownedTeams) {
        if (team.total_members <= 1) {
          execute('DELETE FROM teams WHERE id = ?', team.id);
        }
      }
      execute('DELETE FROM users WHERE id = ?', req.user.id);
    });

    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /me/avatar
router.post('/avatar', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) {
      throw validationError('No file uploaded');
    }
    const avatarUrl = `${PUBLIC_URL}/avatars/${req.file.filename}`;
    execute('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?', avatarUrl, new Date().toISOString(), req.user.id);
    return res.status(200).json({ avatarUrl });
  } catch (err) {
    next(err);
  }
});

// PUT /me/password
router.put('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      throw validationError('New password must be at least 8 characters');
    }

    const user = queryOne('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      throw unauthorized('Current password incorrect', 'invalid_password');
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', newHash, new Date().toISOString(), req.user.id);
    // Changing the password signs out every other device, keeping this one.
    execute('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session?.id || '');
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /me/settings
router.get('/settings', (req, res) => {
  const row = queryOne('SELECT * FROM user_settings WHERE user_id = ?', req.user.id);
  return res.json(mapUserSettings(row));
});

// PATCH /me/settings
router.patch('/settings', (req, res) => {
  const { theme, defaultTeamId, canvasSnapToGrid, timezone, emailNotifications } = req.body || {};
  const current = queryOne('SELECT * FROM user_settings WHERE user_id = ?', req.user.id);

  const updatedTheme = theme !== undefined ? theme : (current?.theme || 'system');
  const updatedTeam = defaultTeamId !== undefined ? defaultTeamId : (current?.default_team_id || null);
  const updatedGrid = canvasSnapToGrid !== undefined ? (canvasSnapToGrid ? 1 : 0) : (current?.canvas_snap_to_grid ?? 1);
  const updatedTz = timezone !== undefined ? timezone : (current?.timezone || 'UTC');
  const updatedEmail = emailNotifications !== undefined ? (emailNotifications ? 1 : 0) : (current?.email_notifications ?? 1);

  execute(`
    INSERT INTO user_settings (user_id, theme, default_team_id, canvas_snap_to_grid, timezone, email_notifications)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme,
      default_team_id = excluded.default_team_id,
      canvas_snap_to_grid = excluded.canvas_snap_to_grid,
      timezone = excluded.timezone,
      email_notifications = excluded.email_notifications
  `, req.user.id, updatedTheme, updatedTeam, updatedGrid, updatedTz, updatedEmail);

  const row = queryOne('SELECT * FROM user_settings WHERE user_id = ?', req.user.id);
  return res.json(mapUserSettings(row));
});

// GET /me/onboarding
router.get('/onboarding', (req, res) => {
  const row = queryOne('SELECT * FROM onboarding_state WHERE user_id = ?', req.user.id);
  return res.json(mapOnboardingState(row));
});

function handleOnboardingUpdate(req, res) {
  const current = queryOne('SELECT * FROM onboarding_state WHERE user_id = ?', req.user.id) || {};
  const b = req.body || {};

  const step = b.step !== undefined ? parseInt(b.step, 10) : (b.currentStep !== undefined ? parseInt(b.currentStep, 10) : (current.step ?? 0));
  const completed = b.completed !== undefined ? (b.completed ? 1 : 0) : (current.completed ?? 0);
  const workspaceName = b.workspaceName !== undefined ? b.workspaceName : (b.workspace !== undefined ? b.workspace : (current.workspace_name || null));
  const selectedTemplate = b.selectedTemplate !== undefined ? b.selectedTemplate : (b.template !== undefined ? b.template : (current.selected_template || null));
  const invitedEmails = b.invitedEmails !== undefined 
    ? (Array.isArray(b.invitedEmails) ? b.invitedEmails.join(', ') : b.invitedEmails)
    : (b.invites !== undefined ? (Array.isArray(b.invites) ? b.invites.join(', ') : b.invites) : (current.invited_emails || null));

  let currentData = {};
  try {
    currentData = typeof current.data === 'string' ? JSON.parse(current.data) : (current.data || {});
  } catch {
    currentData = {};
  }
  const mergedData = b.data ? { ...currentData, ...b.data } : currentData;

  const teamCreated = b.teamCreated !== undefined ? (b.teamCreated ? 1 : 0) : (current.team_created || 0);
  const githubConnected = b.githubConnected !== undefined ? (b.githubConnected ? 1 : 0) : (current.github_connected || 0);
  const firstProjectCreated = b.firstProjectCreated !== undefined ? (b.firstProjectCreated ? 1 : 0) : (current.first_project_created || 0);
  const firstDeploySucceeded = b.firstDeploySucceeded !== undefined ? (b.firstDeploySucceeded ? 1 : 0) : (current.first_deploy_succeeded || 0);
  const dismissed = b.dismissed !== undefined ? (b.dismissed ? 1 : 0) : (current.dismissed || 0);
  const now = new Date().toISOString();

  execute(`
    INSERT INTO onboarding_state (
      user_id, step, completed, workspace_name, selected_template, invited_emails, data,
      team_created, github_connected, first_project_created, first_deploy_succeeded, dismissed, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      step = excluded.step,
      completed = excluded.completed,
      workspace_name = excluded.workspace_name,
      selected_template = excluded.selected_template,
      invited_emails = excluded.invited_emails,
      data = excluded.data,
      team_created = excluded.team_created,
      github_connected = excluded.github_connected,
      first_project_created = excluded.first_project_created,
      first_deploy_succeeded = excluded.first_deploy_succeeded,
      dismissed = excluded.dismissed,
      updated_at = excluded.updated_at
  `, req.user.id, step, completed, workspaceName, selectedTemplate, invitedEmails, JSON.stringify(mergedData),
     teamCreated, githubConnected, firstProjectCreated, firstDeploySucceeded, dismissed, now);

  const row = queryOne('SELECT * FROM onboarding_state WHERE user_id = ?', req.user.id);
  return res.json(mapOnboardingState(row));
}

// PATCH /me/onboarding, PUT /me/onboarding, POST /me/onboarding
router.patch('/onboarding', handleOnboardingUpdate);
router.put('/onboarding', handleOnboardingUpdate);
router.post('/onboarding', handleOnboardingUpdate);

export default router;
