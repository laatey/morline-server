import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import health from '../src/plugins/health.js';
import { errorHandler, notFoundHandler } from '../src/lib/errors.js';

async function build(checks = []) {
  const app = Fastify();
  app.decorate('readinessChecks', checks);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(health);
  return app;
}

test('GET /health reports ok', async (t) => {
  const app = await build();
  t.after(() => app.close());
  const res = await app.inject('/health');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
});

test('GET /ready is 503 while a dependency check fails', async (t) => {
  const app = await build([async () => { throw new Error('db down'); }]);
  t.after(() => app.close());
  const res = await app.inject('/ready');
  assert.equal(res.statusCode, 503);
});

test('unknown routes use the standard error shape', async (t) => {
  const app = await build();
  t.after(() => app.close());
  const res = await app.inject('/nope');
  assert.equal(res.statusCode, 404);
  const body = res.json();
  assert.equal(body.code, 'not_found');
  assert.ok(body.requestId);
});
