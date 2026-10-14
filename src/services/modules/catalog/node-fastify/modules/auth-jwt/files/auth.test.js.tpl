import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import auth from '../src/plugins/auth.js';
import { errorHandler } from '../src/lib/errors.js';

test('routes need a token unless they are public', async (t) => {
  process.env.JWT_SECRET = 'a'.repeat(40);
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler(errorHandler);
  await app.register(auth);
  app.get('/private', async (req) => ({ sub: req.user.sub }));
  app.get('/open', { config: { public: true } }, async () => ({ ok: true }));

  assert.equal((await app.inject('/open')).statusCode, 200);
  assert.equal((await app.inject('/private')).statusCode, 401);

  const token = app.jwt.sign({ sub: 'user-1', role: 'user' });
  const res = await app.inject({ url: '/private', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sub, 'user-1');
});
