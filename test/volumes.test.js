import assert from 'node:assert/strict';
import test from 'node:test';
import { execute, queryOne, queryAll, initDb } from '../src/db/index.js';
import express from 'express';
import { errorHandler } from '../src/middleware/error-handler.js';
import servicesRouter from '../src/routes/services.js';

// Setup database
initDb();

// Create test user, team, project, environment and service
const testUserId = `usr_test_${Date.now()}`;
const testTeamId = `team_test_${Date.now()}`;
const testProjectId = `prj_test_${Date.now()}`;
const testEnvId = `env_test_${Date.now()}`;
const testServiceId = `svc_test_${Date.now()}`;

const now = new Date().toISOString();

execute(`
  INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at)
  VALUES (?, 'vol_test@example.com', 'Vol Test', ?, ?)
`, testUserId, now, now);

execute(`
  INSERT OR IGNORE INTO teams (id, name, slug, created_at, updated_at)
  VALUES (?, 'Vol Team', ?, ?, ?)
`, testTeamId, `slug_${Date.now()}`, now, now);

execute(`
  INSERT OR IGNORE INTO projects (id, team_id, name, description, created_at, updated_at)
  VALUES (?, ?, 'Vol Project', 'Test project', ?, ?)
`, testProjectId, testTeamId, now, now);

execute(`
  INSERT OR IGNORE INTO environments (id, project_id, name, type, created_at, updated_at)
  VALUES (?, ?, 'production', 'production', ?, ?)
`, testEnvId, testProjectId, now, now);

execute(`
  INSERT OR IGNORE INTO services (id, environment_id, name, kind, status, source_type, created_at, updated_at)
  VALUES (?, ?, 'vol-service', 'app', 'idle', 'image', ?, ?)
`, testServiceId, testEnvId, now, now);

// Set up minimal test app
const app = express();
app.use(express.json());

// Auth mock middleware for testing
app.use((req, res, next) => {
  req.user = { id: testUserId, email: 'vol_test@example.com' };
  next();
});

app.use('/v1', servicesRouter);
app.use(errorHandler);

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /services/:id/volumes returns empty array initially', async () => {
  const res = await fetch(`${baseUrl}/services/${testServiceId}/volumes`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data));
  assert.equal(body.data.length, 0);
});

test('POST /services/:id/volumes creates volume without explicit name', async () => {
  const res = await fetch(`${baseUrl}/services/${testServiceId}/volumes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mountPath: '/data', sizeGb: 5 })
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.equal(body.mountPath, '/data');
  assert.equal(body.sizeGb, 5);
  assert.equal(body.name, 'data');

  // Verify it appears in GET
  const listRes = await fetch(`${baseUrl}/services/${testServiceId}/volumes`);
  const list = await listRes.json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, body.id);
  assert.equal(list.data[0].mountPath, '/data');
  assert.equal(list.data[0].sizeGb, 5);

  // Verify staged change was recorded
  const staged = queryAll('SELECT * FROM staged_changes WHERE service_id = ? AND type = ?', testServiceId, 'volume');
  assert.ok(staged.length >= 1);
  assert.ok(staged.some(s => s.summary.includes('Attached volume /data')));
});

test('POST /services/:id/volumes rejects invalid mountPath or duplicate mountPath', async () => {
  // Missing leading slash
  const invalidRes = await fetch(`${baseUrl}/services/${testServiceId}/volumes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mountPath: 'relative/path', sizeGb: 2 })
  });
  assert.equal(invalidRes.status, 400);

  // Duplicate mount path
  const dupRes = await fetch(`${baseUrl}/services/${testServiceId}/volumes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mountPath: '/data', sizeGb: 10 })
  });
  assert.equal(dupRes.status, 409);
});

test('PATCH /volumes/:volumeId resizes volume', async () => {
  const listRes = await fetch(`${baseUrl}/services/${testServiceId}/volumes`);
  const list = await listRes.json();
  const vol = list.data[0];

  const patchRes = await fetch(`${baseUrl}/volumes/${vol.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sizeGb: 20 })
  });

  assert.equal(patchRes.status, 200);
  const body = await patchRes.json();
  assert.equal(body.id, vol.id);
  assert.equal(body.sizeGb, 20);

  // Verify persisted
  const getVol = await fetch(`${baseUrl}/volumes/${vol.id}`);
  assert.equal(getVol.status, 200);
  const getBody = await getVol.json();
  assert.equal(getBody.sizeGb, 20);
});

test('PATCH /volumes/:volumeId rejects invalid size', async () => {
  const listRes = await fetch(`${baseUrl}/services/${testServiceId}/volumes`);
  const list = await listRes.json();
  const vol = list.data[0];

  const patchRes = await fetch(`${baseUrl}/volumes/${vol.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sizeGb: -5 })
  });

  assert.equal(patchRes.status, 400);
});

test('DELETE /volumes/:volumeId removes volume and records staged change', async () => {
  const listRes = await fetch(`${baseUrl}/services/${testServiceId}/volumes`);
  const list = await listRes.json();
  const vol = list.data[0];

  const delRes = await fetch(`${baseUrl}/volumes/${vol.id}`, {
    method: 'DELETE'
  });
  assert.equal(delRes.status, 204);

  // Verify list is empty
  const afterList = await fetch(`${baseUrl}/services/${testServiceId}/volumes`);
  const afterBody = await afterList.json();
  assert.equal(afterBody.data.length, 0);

  // Verify 404 on subsequent DELETE or GET
  const notFoundGet = await fetch(`${baseUrl}/volumes/${vol.id}`);
  assert.equal(notFoundGet.status, 404);

  const notFoundDel = await fetch(`${baseUrl}/volumes/${vol.id}`, {
    method: 'DELETE'
  });
  assert.equal(notFoundDel.status, 404);
});
