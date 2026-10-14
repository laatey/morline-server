import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from '../lib/env.js';

const exposeInProduction = {{exposeInProduction}};

export default fp(async function docs(app) {
  if (env.isProduction && !exposeInProduction) return;

  await app.register(swagger, {
    openapi: { info: { title: {{name|json}}, version: '0.1.0' } }
  });

  // The docs pages are public and exempt from rate limits, whatever the rest of the app does.
  await app.register(async (scope) => {
    scope.addHook('onRoute', (route) => {
      route.config = { ...route.config, public: true, rateLimit: false };
    });
    await scope.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  });
}, { name: 'docs' });
