import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';

export default fp(async function securityHeaders(app) {
  await app.register(helmet);
}, { name: 'security-headers' });
