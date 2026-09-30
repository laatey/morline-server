import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { execute, queryOne, queryAll, transaction } from '../db/index.js';
import { mapUser, mapSessionInfo } from '../db/mappers.js';
import { signAccessToken, requireAuth } from '../middleware/auth.js';
import { conflict, unauthorized, notFound } from '../middleware/error-handler.js';
import { REFRESH_EXPIRES_DAYS, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, PUBLIC_URL, FRONTEND_URL } from '../config.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../services/email.js';

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(80)
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

function createSessionRecord(userId, req) {
  const sessionId = `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const refreshToken = `rsh_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_EXPIRES_DAYS * 86400000).toISOString();
  const userAgent = req.headers['user-agent'] || 'Unknown Client';
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

  execute(`
    INSERT INTO sessions (id, user_id, refresh_token, user_agent, ip, expires_at, created_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, sessionId, userId, refreshToken, userAgent, ip, expiresAt, now.toISOString(), now.toISOString());

  const accessToken = signAccessToken({ userId, sessionId });

  return {
    accessToken,
    refreshToken,
    expiresAt,
    sessionId
  };
}

// POST /auth/signup
router.post('/signup', async (req, res, next) => {
  try {
    const body = signupSchema.parse(req.body);
    const existing = queryOne('SELECT id FROM users WHERE email = ?', body.email.toLowerCase());
    if (existing) {
      throw conflict('An account with this email already exists', 'user_already_exists');
    }

    const userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const passwordHash = await bcrypt.hash(body.password, 10);
    const now = new Date().toISOString();
    const username = body.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(1000 + Math.random() * 9000);

    const teamId = `tem_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const teamSlug = username + '-team';

    transaction(() => {
      execute(`
        INSERT INTO users (id, email, email_verified, name, username, password_hash, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `, userId, body.email.toLowerCase(), body.name, username, passwordHash, now, now);

      execute(`
        INSERT INTO user_settings (user_id, theme, default_team_id, canvas_snap_to_grid, timezone, email_notifications)
        VALUES (?, 'system', ?, 1, 'UTC', 1)
      `, userId, teamId);

      execute(`
        INSERT INTO onboarding_state (user_id, team_created, github_connected, first_project_created, first_deploy_succeeded, dismissed)
        VALUES (?, 1, 0, 0, 0, 0)
      `, userId);

      execute(`
        INSERT INTO teams (id, name, slug, plan, created_at, updated_at)
        VALUES (?, ?, ?, 'hobby', ?, ?)
      `, teamId, `${body.name}'s Team`, teamSlug, now, now);

      execute(`
        INSERT INTO team_members (team_id, user_id, role, joined_at)
        VALUES (?, ?, 'owner', ?)
      `, teamId, userId, now);
    });

    const userRow = queryOne('SELECT * FROM users WHERE id = ?', userId);
    const session = createSessionRecord(userId, req);

    // Fire welcome email (non-blocking)
    sendWelcomeEmail({ to: body.email.toLowerCase(), name: body.name }).catch(() => {});

    return res.status(201).json({
      user: mapUser(userRow),
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt
      },
      requiresEmailVerification: false
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = queryOne('SELECT * FROM users WHERE email = ?', body.email.toLowerCase());
    if (!user) {
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }

    const match = await bcrypt.compare(body.password, user.password_hash);
    if (!match) {
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }

    const session = createSessionRecord(user.id, req);

    return res.status(200).json({
      user: mapUser(user),
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/oauth/:provider/start
router.get('/oauth/:provider/start', (req, res) => {
  const provider = req.params.provider;
  if (provider !== 'github') {
    return res.status(400).json({ error: `Provider ${provider} not supported` });
  }

  const redirectTo = req.query.redirectTo || `${FRONTEND_URL}/projects`;
  const callbackUrl = `${PUBLIC_URL}/v1/auth/oauth/github/callback`;
  const stateObj = { redirectTo, nonce: crypto.randomUUID() };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=read:user,user:email&state=${encodeURIComponent(state)}`;

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ url: authUrl });
  }
  return res.redirect(authUrl);
});

// GET /auth/oauth/:provider/callback
router.get('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const { code, state, error, error_description } = req.query;

    let redirectTo = `${FRONTEND_URL}/projects`;
    if (state) {
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
        if (decoded.redirectTo) redirectTo = decoded.redirectTo;
      } catch (e) {
        if (typeof state === 'string' && state.startsWith('http')) redirectTo = state;
      }
    }

    if (error) {
      const errParam = encodeURIComponent(error_description || error);
      return res.redirect(`${redirectTo}${redirectTo.includes('?') ? '&' : '?'}error=${errParam}`);
    }

    if (!code) {
      return res.redirect(`${redirectTo}${redirectTo.includes('?') ? '&' : '?'}error=missing_code`);
    }

    // Exchange code for access_token with GitHub
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Morline-App'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      const errParam = encodeURIComponent(tokenData.error_description || tokenData.error || 'token_exchange_failed');
      return res.redirect(`${redirectTo}${redirectTo.includes('?') ? '&' : '?'}error=${errParam}`);
    }

    const accessToken = tokenData.access_token;

    // Fetch GitHub User Profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Morline-App'
      }
    });

    if (!userRes.ok) {
      return res.redirect(`${redirectTo}${redirectTo.includes('?') ? '&' : '?'}error=failed_fetching_github_profile`);
    }

    const ghUser = await userRes.json();

    // Fetch Emails to find verified primary email
    let email = ghUser.email;
    if (!email) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'Morline-App'
          }
        });
        if (emailsRes.ok) {
          const emails = await emailsRes.json();
          const primary = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) || emails[0];
          if (primary) email = primary.email;
        }
      } catch (e) {}
    }

    if (!email) {
      email = `${ghUser.login.toLowerCase()}@github.morline.space`;
    } else {
      email = email.toLowerCase().trim();
    }

    // Find or create user
    let user = queryOne('SELECT * FROM users WHERE email = ?', email);
    const now = new Date().toISOString();

    if (!user) {
      const userId = `usr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const name = ghUser.name || ghUser.login;
      const username = ghUser.login.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(1000 + Math.random() * 9000);
      const teamId = `tem_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const teamSlug = username + '-team';
      const dummyPasswordHash = await bcrypt.hash(crypto.randomUUID(), 10);

      transaction(() => {
        execute(`
          INSERT INTO users (id, email, email_verified, name, username, avatar_url, password_hash, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
        `, userId, email, name, username, ghUser.avatar_url || null, dummyPasswordHash, now, now);

        execute(`
          INSERT INTO user_settings (user_id, theme, default_team_id, canvas_snap_to_grid, timezone, email_notifications)
          VALUES (?, 'system', ?, 1, 'UTC', 1)
        `, userId, teamId);

        execute(`
          INSERT INTO onboarding_state (user_id, team_created, github_connected, first_project_created, first_deploy_succeeded, dismissed)
          VALUES (?, 1, 1, 0, 0, 0)
        `, userId);

        execute(`
          INSERT INTO teams (id, name, slug, plan, created_at, updated_at)
          VALUES (?, ?, ?, 'hobby', ?, ?)
        `, teamId, `${name}'s Team`, teamSlug, now, now);

        execute(`
          INSERT INTO team_members (team_id, user_id, role, joined_at)
          VALUES (?, ?, 'owner', ?)
        `, teamId, userId, now);
      });

      user = queryOne('SELECT * FROM users WHERE id = ?', userId);
    } else {
      // Update avatar if not present
      if (ghUser.avatar_url && !user.avatar_url) {
        execute('UPDATE users SET avatar_url = ? WHERE id = ?', ghUser.avatar_url, user.id);
      }
    }

    const session = createSessionRecord(user.id, req);

    // Redirect to frontend with auth_session payload
    const sessionObj = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt
    };

    let finalRedirect = redirectTo;
    try {
      const u = new URL(redirectTo);
      u.searchParams.set('auth_session', JSON.stringify(sessionObj));
      finalRedirect = u.toString();
    } catch (e) {
      finalRedirect = `${redirectTo}${redirectTo.includes('?') ? '&' : '?'}auth_session=${encodeURIComponent(JSON.stringify(sessionObj))}`;
    }

    return res.redirect(finalRedirect);
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      throw unauthorized('Missing refresh token', 'missing_token');
    }

    const session = queryOne('SELECT * FROM sessions WHERE refresh_token = ?', refreshToken);
    if (!session || new Date(session.expires_at) < new Date()) {
      throw unauthorized('Invalid or expired refresh token', 'invalid_token');
    }

    const newAccessToken = signAccessToken({ userId: session.user_id, sessionId: session.id });
    return res.json({
      accessToken: newAccessToken,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  if (req.session) {
    execute('DELETE FROM sessions WHERE id = ?', req.session.id);
  }
  return res.status(204).end();
});

// POST /auth/verify-email
router.post('/verify-email', (req, res) => {
  if (req.user) {
    execute('UPDATE users SET email_verified = 1 WHERE id = ?', req.user.id);
  }
  return res.status(200).json({ verified: true });
});

// POST /auth/verify-email/resend
router.post('/verify-email/resend', (req, res) => {
  return res.status(200).json({ sent: true });
});

// POST /auth/password/forgot
router.post('/password/forgot', async (req, res) => {
  const { email } = req.body || {};
  // Always respond 200 to avoid email enumeration
  if (!email) return res.status(200).json({ sent: true });

  const user = queryOne('SELECT * FROM users WHERE email = ?', email.toLowerCase());
  if (!user) return res.status(200).json({ sent: true });

  const resetToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour
  const now = new Date().toISOString();

  execute(`
    INSERT INTO password_resets (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, created_at = excluded.created_at
  `, resetToken, user.id, expiresAt, now);

  sendPasswordResetEmail({ to: user.email, name: user.name, resetToken }).catch(() => {});

  return res.status(200).json({ sent: true });
});

// POST /auth/password/reset
router.post('/password/reset', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ code: 'validation_failed', message: 'Password must be at least 8 characters' });
    }
    if (!token) {
      return res.status(400).json({ code: 'validation_failed', message: 'Reset token is required' });
    }

    const record = queryOne('SELECT * FROM password_resets WHERE token = ?', token);
    if (!record || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ code: 'invalid_token', message: 'Reset link is invalid or has expired' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, new Date().toISOString(), record.user_id);
    execute('DELETE FROM password_resets WHERE user_id = ?', record.user_id);

    return res.status(200).json({ reset: true });
  } catch (err) {
    next(err);
  }
});

// GET /auth/sessions
router.get('/sessions', requireAuth, (req, res) => {
  const rows = queryAll('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC', req.user.id);
  const data = rows.map((r) => mapSessionInfo(r, req.session?.id));
  return res.json({ data });
});

// DELETE /auth/sessions/:sessionId
router.delete('/sessions/:sessionId', requireAuth, (req, res, next) => {
  const sessionId = req.params.sessionId;
  const session = queryOne('SELECT * FROM sessions WHERE id = ? AND user_id = ?', sessionId, req.user.id);
  if (!session) {
    throw notFound('Session not found');
  }

  execute('DELETE FROM sessions WHERE id = ?', sessionId);
  return res.status(204).end();
});

export default router;
