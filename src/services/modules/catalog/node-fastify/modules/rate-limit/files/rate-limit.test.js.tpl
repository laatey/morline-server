import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimiting from '../src/plugins/rate-limit.js';

test('requests over the limit get 429', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(rateLimiting);
  app.get('/ping', async () => ({ ok: true }));

  for (let i = 0; i < {{max}}; i++) {
    assert.equal((await app.inject('/ping')).statusCode, 200);
  }
  const limited = await app.inject('/ping');
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
});
