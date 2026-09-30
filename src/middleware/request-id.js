import crypto from 'node:crypto';

export function requestIdMiddleware(req, res, next) {
  const reqId = req.headers['x-request-id'] || `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);
  next();
}
