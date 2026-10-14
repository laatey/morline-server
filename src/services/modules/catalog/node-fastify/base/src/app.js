import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './lib/env.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import health from './plugins/health.js';
import routes from './routes/index.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.optional('LOG_LEVEL', 'info') },
    // Morline's proxy sits in front of the app, so trust its forwarded headers.
    trustProxy: true,
    bodyLimit: 1_048_576,
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && /^[\w.-]{1,128}$/.test(given) ? given : randomUUID();
    }
  });

  app.decorate('readinessChecks', []);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // -- core --
  await app.register(health);
  await app.register(routes);

  return app;
}
