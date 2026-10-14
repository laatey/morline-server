import fp from 'fastify-plugin';
import { MongoClient } from 'mongodb';
import { env } from '../lib/env.js';

export default fp(async function mongodb(app) {
  const client = new MongoClient(env.required('MONGODB_URL'), { maxPoolSize: env.int('MONGODB_POOL_MAX', 10) });
  await client.connect();
  const db = client.db(env.optional('MONGODB_DB', undefined));

  app.decorate('mongo', client);
  app.readinessChecks.push(async () => { await db.command({ ping: 1 }); });
  app.addHook('onClose', async () => { await client.close(); });
}, { name: 'mongodb' });
