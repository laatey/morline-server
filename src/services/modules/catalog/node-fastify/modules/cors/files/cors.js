import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { env } from '../lib/env.js';

export default fp(async function corsPlugin(app) {
  const origins = env.optional('CORS_ORIGINS', '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (env.isProduction && origins.includes('*')) {
    throw new Error('CORS_ORIGINS must list explicit origins in production, not *');
  }

  await app.register(cors, {
    origin: origins.includes('*') ? '*' : origins.length ? origins : false,
    credentials: {{credentials}},
    maxAge: 86400
  });
}, { name: 'cors' });
