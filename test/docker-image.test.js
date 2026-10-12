import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

process.env.JWT_SECRET ??= 'test-secret-not-for-production';
const { initDb, execute, queryOne } = await import('../src/db/index.js');
const { isValidImageRef, defaultNameFromImage } = await import('../src/engine/image-ref.js');
const { errorHandler } = await import('../src/middleware/error-handler.js');
const { default: environmentsRouter } = await import('../src/routes/environments.js');

test('image references are validated strictly', () => {
  for (const ok of ['nginx', 'nginx:latest', 'redis:7-alpine', 'ghcr.io/acme/app:1.2.3', 'localhost:5000/team/app:dev', 'org/app@sha256:' + 'a'.repeat(64)]) {
    assert.equal(isValidImageRef(ok), true, ok);
  }
  for (const bad of ['', ' nginx', '-v /:/host alpine', 'nginx;rm -rf /', 'NGINX', 'a b', 'nginx:', 'img:$(id)', 'x'.repeat(300), null]) {
    assert.equal(isValidImageRef(bad), false, String(bad));
  }
});

test('service names come from the image', () => {
  assert.equal(defaultNameFromImage('ghcr.io/acme/billing-api:1.2'), 'billing-api');
  assert.equal(defaultNameFromImage('redis'), 'redis');
  assert.equal(defaultNameFromImage('org/app@sha256:' + 'a'.repeat(64)), 'app');
});

initDb();
const t = Date.now();
const now = new Date().toISOString();
const ids = { user: `usr_img_${t}`, team: `team_img_${t}`, project: `prj_img_${t}`, env: `env_img_${t}` };
execute(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, 'U', 'x', ?, ?)`, ids.user, `i_${t}@img.test`, now, now);
execute(`INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'T', ?, ?, ?)`, ids.team, `img-${t}`, now, now);
execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, ids.team, ids.user, now);
execute(`INSERT INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'P', '', ?, ?)`, ids.project, ids.team, now, now);
execute(`INSERT INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, ids.env, ids.project, now, now);

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: ids.user, email: 'x', name: 'U' }; next(); });
app.use('/environments', environmentsRouter);
app.use(errorHandler);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
test.after(() => server.close());
const post = (source, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/environments/${ids.env}/services`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, deploy: false, ...extra })
});

test('adding a Docker image creates an image service', async () => {
  const res = await post({ type: 'image', image: 'redis:7-alpine', port: 6379 });
  assert.equal(res.status, 201);
  const body = await res.json();
  const row = queryOne('SELECT * FROM services WHERE id = ?', (body.service ?? body.data ?? body).id);
  assert.equal(row.source_type, 'image');
  assert.equal(row.source_image, 'redis:7-alpine');
  assert.equal(row.name, 'redis');
  assert.equal(queryOne('SELECT target_port FROM service_networking WHERE service_id = ?', row.id).target_port, 6379);
});

test('without a port the target port is left to be detected from the image', async () => {
  const res = await post({ type: 'image', image: 'nginx:latest' });
  assert.equal(res.status, 201);
  const body = await res.json();
  const id = (body.service ?? body.data ?? body).id;
  assert.equal(queryOne('SELECT target_port FROM service_networking WHERE service_id = ?', id).target_port, null);
});

test('missing or malformed images are rejected with field errors', async () => {
  for (const source of [{ type: 'image' }, { type: 'image', image: 'bad image' }, { type: 'image', image: '-v /:/h alpine' }, { type: 'image', image: 'nginx', port: 99999 }]) {
    const res = await post(source);
    assert.equal(res.status, 400, JSON.stringify(source));
    assert.ok((await res.json()).fields);
  }
});
