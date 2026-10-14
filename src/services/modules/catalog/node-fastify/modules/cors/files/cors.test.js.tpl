import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cors from '../src/plugins/cors.js';

test('only listed origins get CORS headers', async (t) => {
  process.env.CORS_ORIGINS = 'https://app.example.com';
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cors);
  app.get('/ping', async () => ({ ok: true }));

  const allowed = await app.inject({ url: '/ping', headers: { origin: 'https://app.example.com' } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.example.com');

  const denied = await app.inject({ url: '/ping', headers: { origin: 'https://evil.example.net' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});
