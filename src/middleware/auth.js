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
  if (req.query && req.query.token) {
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
    if (session) {
      execute('UPDATE sessions SET last_active_at = ? WHERE id = ?', new Date().toISOString(), session.id);
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
