import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import securityHeaders from '../src/plugins/security-headers.js';

test('responses carry security headers', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(securityHeaders);
  app.get('/ping', async () => ({ ok: true }));

  const res = await app.inject('/ping');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['strict-transport-security']);
});
