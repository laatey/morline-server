import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

process.env.JWT_SECRET ??= 'test-secret-not-for-production';
const { initDb } = await import('../src/db/index.js');
const { authenticate, extractToken } = await import('../src/middleware/auth.js');
const { errorHandler } = await import('../src/middleware/error-handler.js');
const { default: authRouter } = await import('../src/routes/auth.js');

initDb();
const app = express();
app.use(express.json());
const v1 = express.Router();
v1.use(authenticate);
v1.use('/auth', authRouter);
app.use('/v1', v1);
app.use(errorHandler);

const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}/v1`;
test.after(() => server.close());

const email = `auth_test_${Date.now()}@example.com`;
const password = 'correct horse battery';
const post = (path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body ?? {})
});
let session;

test('signup rejects short passwords', async () => {
  assert.equal((await post('/auth/signup', { email, password: 'short', name: 'T' })).status, 400);
});

test('signup creates an account and returns a session', async () => {
  const res = await post('/auth/signup', { email, password, name: 'Auth Test' });
  assert.equal(res.status, 201);
  session = (await res.json()).session;
  assert.ok(session.accessToken && session.refreshToken);
});

test('duplicate signup is a 409', async () => {
  assert.equal((await post('/auth/signup', { email, password, name: 'Again' })).status, 409);
});

test('login rejects a wrong password and accepts the right one', async () => {
  assert.equal((await post('/auth/login', { email, password: 'wrong password' })).status, 401);
  const ok = await post('/auth/login', { email, password });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).session.accessToken);
});

test('protected routes need a bearer token', async () => {
  assert.equal((await fetch(`${base}/auth/sessions`)).status, 401);
  const res = await fetch(`${base}/auth/sessions`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
  assert.equal(res.status, 200);
});

test('?token= is ignored outside streaming endpoints', async () => {
  assert.equal((await fetch(`${base}/auth/sessions?token=${session.accessToken}`)).status, 401);
  const stream = { method: 'GET', query: { token: 'abc' }, headers: {}, path: '/notifications/stream' };
  assert.equal(extractToken(stream), 'abc');
  assert.equal(extractToken({ ...stream, path: '/projects' }), null);
  assert.equal(extractToken({ ...stream, method: 'POST' }), null);
});

test('refresh issues a new access token', async () => {
  const res = await post('/auth/refresh', { refreshToken: session.refreshToken });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).accessToken);
  assert.equal((await post('/auth/refresh', { refreshToken: 'nope' })).status, 401);
});

test('logging out revokes the access token', async () => {
  const res = await post('/auth/logout', {}, session.accessToken);
  assert.ok(res.status < 300);
  assert.equal((await fetch(`${base}/auth/sessions`, { headers: { Authorization: `Bearer ${session.accessToken}` } })).status, 401);
});
