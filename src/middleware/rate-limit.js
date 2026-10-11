import { AppError } from './error-handler.js';

/**
 * Small in-memory fixed-window limiter. Good enough for a single API process;
 * move to a shared store (Redis) if Morline ever runs more than one node.
 */
export function rateLimit({ windowMs = 60_000, max = 60, key = (req) => req.ip, message = 'Too many requests, slow down' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return function limiter(req, res, next) {
    const now = Date.now();
    const k = key(req) || 'unknown';
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(new AppError(message, 429, 'rate_limited'));
    }
    next();
  };
}
