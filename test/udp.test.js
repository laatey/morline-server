import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { execute, initDb } from '../src/db/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import servicesRouter from '../src/routes/services.js';
import { udpEnv, udpMappings, udpPublishSpecs, setUdpPorts } from '../src/engine/public-udp.js';

initDb();
const stamp = Date.now();
const ids = { user: `usr_udp_${stamp}`, team: `team_udp_${stamp}`, project: `prj_udp_${stamp}`, env: `env_udp_${stamp}`, a: `svc_udp_a_${stamp}`, b: `svc_udp_b_${stamp}` };
const now = new Date().toISOString();
execute(`INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, 'udp_test@example.com', 'Udp', 'x', ?, ?)`, ids.user, now, now);
execute(`INSERT OR IGNORE INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'Udp Team', ?, ?, ?)`, ids.team, `udp_${stamp}`, now, now);
execute(`INSERT OR IGNORE INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'Udp', 't', ?, ?)`, ids.project, ids.team, now, now);
execute(`INSERT OR IGNORE INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, ids.env, ids.project, now, now);
for (const [id, name] of [[ids.a, 'radius-a'], [ids.b, 'radius-b']]) {
  execute(`INSERT OR IGNORE INTO services (id, environment_id, name, kind, status, source_type, created_at, updated_at) VALUES (?, ?, ?, 'app', 'idle', 'image', ?, ?)`, id, ids.env, name, now, now);
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: ids.user, email: 'udp_test@example.com' }; next(); });
app.use('/v1', servicesRouter);
app.use(errorHandler);
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/v1`; r(); }); }); });
test.after(async () => { await new Promise((r) => server.close(r)); });
const patch = (id, body) => fetch(`${base}/services/${id}/networking`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('exposes UDP ports with unique public ports and publish specs', async () => {
  const res = await patch(ids.a, { udpPorts: [1813, 1812] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.udpProxy.enabled, true);
  assert.deepEqual(body.udpProxy.ports.map((p) => p.containerPort), [1812, 1813]);
  const [p1, p2] = body.udpProxy.ports.map((p) => p.port);
  assert.ok(p1 >= 31000 && p2 > p1 || p1 >= 31000);
  assert.notEqual(p1, p2);
  assert.deepEqual(udpPublishSpecs(ids.a), [`${p1}:1812/udp`, `${p2}:1813/udp`]);
  const env = udpEnv(ids.a);
  assert.equal(env.MORLINE_PUBLIC_UDP_PORT_1812, String(p1));
  assert.equal(env.MORLINE_PUBLIC_UDP_PORT_1813, String(p2));
  assert.ok(env.MORLINE_PUBLIC_UDP_HOST);
  // GET shows the same
  const got = await (await fetch(`${base}/services/${ids.a}/networking`)).json();
  assert.equal(got.udpProxy.ports.length, 2);
});

test('keeps existing public ports when the list changes; frees removed ones; never shares ports', async () => {
  const before = Object.fromEntries(udpMappings(ids.a).map((m) => [m.container_port, m.public_port]));
  await patch(ids.a, { udpPorts: [1812, 51820] });
  const after = Object.fromEntries(udpMappings(ids.a).map((m) => [m.container_port, m.public_port]));
  assert.equal(after[1812], before[1812]);
  assert.equal(after[1813], undefined);
  const other = await (await patch(ids.b, { udpPorts: [1812] })).json();
  const all = [...Object.values(after), other.udpProxy.ports[0].port];
  assert.equal(new Set(all).size, all.length);
  assert.equal(setUdpPorts(ids.a, [1812, 51820]), false); // no change
});

test('rejects bad input and can clear everything', async () => {
  for (const bad of [[0], [70000], [1.5], ['x'], [53, 53], Array.from({ length: 9 }, (_, i) => 2000 + i), 'nope']) {
    const res = await patch(ids.a, { udpPorts: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.ok(udpMappings(ids.a).length > 0); // failed requests changed nothing
  const cleared = await (await patch(ids.a, { udpPorts: [] })).json();
  assert.equal(cleared.udpProxy.enabled, false);
  assert.deepEqual(udpEnv(ids.a), {});
});
