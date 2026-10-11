import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { rateLimit } from '../src/middleware/rate-limit.js';
import { errorHandler } from '../src/middleware/error-handler.js';

async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('allows up to max requests then returns 429 with Retry-After', async () => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, max: 3 }));
  app.get('/', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const { base, close } = await serve(app);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(base)).status, 200);
    const blocked = await fetch(base);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal((await blocked.json()).code, 'rate_limited');
  } finally { close(); }
});

test('buckets are per key', async () => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, max: 1, key: (req) => req.get('x-k') }));
  app.get('/', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const { base, close } = await serve(app);
  try {
    assert.equal((await fetch(base, { headers: { 'x-k': 'a' } })).status, 200);
    assert.equal((await fetch(base, { headers: { 'x-k': 'b' } })).status, 200);
    assert.equal((await fetch(base, { headers: { 'x-k': 'a' } })).status, 429);
  } finally { close(); }
});
