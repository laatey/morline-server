import { Router } from 'express';
import crypto from 'node:crypto';
import { mayIssueCertificate } from '../engine/domain-manager.js';

// Called by the edge proxy (Caddy) before it requests a certificate for a hostname. Without this check
// anyone could point a domain at the server and make it request certificates for it.
const router = Router();

const isPrivate = (ip) => ip === '127.0.0.1' || ip === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const same = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// GET /internal/tls-allow?domain=app.example.com[&secret=...]  ->  200 allowed, 404 not allowed
router.get('/internal/tls-allow', (req, res) => {
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  const secret = process.env.EDGE_SECRET;
  const trusted = secret ? same(req.query.secret || '', secret) : isPrivate(ip);
  if (!trusted) return res.status(403).end();
  return res.status(mayIssueCertificate(req.query.domain) ? 200 : 404).end();
});

export default router;
