import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { env } from '../lib/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';

// 'protected': every route needs a valid token unless it sets config: { public: true }.
// 'open': routes are public unless they opt in with { onRequest: [app.authenticate] }.
const defaultAccess = {{defaultAccess|json}};

export default fp(async function auth(app) {
  const secret = env.required('JWT_SECRET');
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

  await app.register(jwt, { secret, sign: { expiresIn: {{accessTtl|json}} } });

  app.decorate('authenticate', async (req) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid token');
    }
  });

  app.decorate('requireRole', (...roles) => async (req) => {
    await app.authenticate(req);
    if (!roles.includes(req.user.role)) throw forbidden();
  });

  if (defaultAccess === 'protected') {
    app.addHook('onRequest', async (req) => {
      if (req.routeOptions.config?.public) return;
      await app.authenticate(req);
    });
  }
}, { name: 'auth' });
