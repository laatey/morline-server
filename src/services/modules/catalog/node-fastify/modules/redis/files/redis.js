import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '../lib/env.js';

export default fp(async function redis(app) {
  const client = new Redis(env.required('REDIS_URL'), { maxRetriesPerRequest: 3 });
  client.on('error', (err) => app.log.error({ err }, 'redis error'));

  app.decorate('redis', client);
  app.readinessChecks.push(async () => { await client.ping(); });
  app.addHook('onClose', async () => { await client.quit(); });
}, { name: 'redis' });
