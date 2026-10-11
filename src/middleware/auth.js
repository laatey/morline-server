import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';
import { queryOne, execute } from '../db/index.js';
import { unauthorized } from './error-handler.js';

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  // EventSource cannot set headers, so streaming GET endpoints may take ?token=. Nowhere else:
  // URLs end up in access logs and browser history.
  if (req.method === 'GET' && req.query && typeof req.query.token === 'string' && /\/(stream|events)$/.test(req.path)) {
    return req.query.token;
  }
  return null;
}

export function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    req.session = null;
    return next();
  }

  const decoded = verifyToken(token);
  if (!decoded || !decoded.userId) {
    req.user = null;
    req.session = null;
    return next();
  }

  const user = queryOne('SELECT * FROM users WHERE id = ?', decoded.userId);
  if (!user) {
    req.user = null;
    req.session = null;
    return next();
  }

  let session = null;
  if (decoded.sessionId) {
    session = queryOne('SELECT * FROM sessions WHERE id = ? AND user_id = ?', decoded.sessionId, user.id);
    // A token is only as good as its session: once the device is signed out or revoked, or the
    // session has expired, the still-unexpired access token must stop working.
    if (!session || new Date(session.expires_at) < new Date()) {
      req.user = null;
      req.session = null;
      return next();
    }
    const now = Date.now();
    if (now - Date.parse(session.last_active_at) > 60_000) { // no need to write on every request
      execute('UPDATE sessions SET last_active_at = ? WHERE id = ?', new Date(now).toISOString(), session.id);
    }
  }

  req.user = user;
  req.session = session;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return next(unauthorized('Authentication required', 'unauthorized'));
  }
  next();
}

export function optionalAuth(req, res, next) {
  next();
}
