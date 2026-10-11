import crypto from 'node:crypto';
import { JWT_SECRET } from '../config.js';

// Signed, short-lived `state` for GitHub install/OAuth redirects. The callbacks are public, so a
// bare team id in `state` would let anyone attach their GitHub installation to any team.
const TTL_MS = 15 * 60 * 1000;
const mac = (payload, secret) => crypto.createHmac('sha256', secret).update(`gh-state:${payload}`).digest('base64url');

export function signOAuthState(teamId, { secret = JWT_SECRET, now = Date.now() } = {}) {
  const payload = `${teamId}.${now + TTL_MS}`;
  return `${payload}.${mac(payload, secret)}`;
}

/** Returns the team id when the state is authentic and unexpired, otherwise null. */
export function verifyOAuthState(state, { secret = JWT_SECRET, now = Date.now() } = {}) {
  if (typeof state !== 'string' || !secret) return null;
  const parts = state.split('.');
  if (parts.length < 3) return null;
  const sig = parts.pop();
  const payload = parts.join('.');
  const exp = Number(parts[parts.length - 1]);
  const teamId = parts.slice(0, -1).join('.');
  const expected = mac(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!Number.isFinite(exp) || exp < now) return null;
  return teamId || null;
}
