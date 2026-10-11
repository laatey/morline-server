import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { initDb, execute } from '../src/db/index.js';
import { enforceTenancy } from '../src/middleware/tenancy.js';
import { errorHandler } from '../src/middleware/error-handler.js';

initDb();
const t = Date.now();
const now = new Date().toISOString();
const ids = {
  alice: `usr_ten_a_${t}`, bob: `usr_ten_b_${t}`,
  teamA: `team_ten_a_${t}`, teamB: `team_ten_b_${t}`,
  project: `prj_ten_${t}`, env: `env_ten_${t}`, service: `svc_ten_${t}`, volume: `vol_ten_${t}`,
  deployment: `dep_ten_${t}`
};
for (const [id, email] of [[ids.alice, `a_${t}@ten.test`], [ids.bob, `b_${t}@ten.test`]]) {
  execute(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, 'T', 'x', ?, ?)`, id, email, now, now);
}
for (const [id, slug] of [[ids.teamA, `ten-a-${t}`], [ids.teamB, `ten-b-${t}`]]) {
  execute(`INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'T', ?, ?, ?)`, id, slug, now, now);
}
execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, ids.teamA, ids.alice, now);
execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, ids.teamB, ids.bob, now);
execute(`INSERT INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'P', '', ?, ?)`, ids.project, ids.teamA, now, now);
execute(`INSERT INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, ids.env, ids.project, now, now);
execute(`INSERT INTO services (id, environment_id, name, kind, status, source_type, created_at, updated_at) VALUES (?, ?, 's', 'app', 'idle', 'image', ?, ?)`, ids.service, ids.env, now, now);
execute(`INSERT INTO volumes (id, service_id, name, mount_path, size_gb, created_at) VALUES (?, ?, 'v', '/data', 1, ?)`, ids.volume, ids.service, now);
execute(`INSERT INTO deployments (id, service_id, service_name, environment_id, state, created_at) VALUES (?, ?, 's', ?, 'active', ?)`, ids.deployment, ids.service, ids.env, now);

const app = express();
app.use(express.json());
app.use((req, res, next) => { const u = req.get('x-user'); req.user = u ? { id: u } : null; next(); });
app.use(enforceTenancy);
app.all('*', (req, res) => res.json({ ok: true }));
app.use(errorHandler);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
const call = (user, path, init = {}) => fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) } }).then((r) => r.status);

const paths = () => [
  `/services/${ids.service}`, `/services/${ids.service}/variables`, `/environments/${ids.env}/services`,
  `/projects/${ids.project}`, `/volumes/${ids.volume}`, `/deployments/${ids.deployment}/logs`
];

test('team members can reach their own resources', async () => {
  for (const p of paths()) assert.equal(await call(ids.alice, p), 200, p);
});

test('other teams get 403 on every resource kind', async () => {
  for (const p of paths()) assert.equal(await call(ids.bob, p), 403, p);
});

test('query and body references are checked too', async () => {
  assert.equal(await call(ids.bob, `/search?teamId=${ids.teamA}`), 403);
  assert.equal(await call(ids.alice, `/search?teamId=${ids.teamA}`), 200);
  assert.equal(await call(ids.bob, '/connections', { method: 'POST', body: JSON.stringify({ fromServiceId: ids.service }) }), 403);
});

test('unknown ids fall through to the route (404 handling) and anonymous is left to requireAuth', async () => {
  assert.equal(await call(ids.bob, '/services/svc_does_not_exist'), 200);
  assert.equal(await call(null, `/services/${ids.service}`), 200);
});
