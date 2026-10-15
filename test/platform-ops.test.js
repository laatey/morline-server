import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET ??= 'test-secret-not-for-production';
process.env.AI_GATEWAY_KEY = 'k';
process.env.AI_GATEWAY_URL = 'https://gateway.test';
process.env.AI_GATEWAY_MODEL = 'google/gemini-3.5-flash';
const seen = [];
globalThis.fetch = async (url, opts) => {
  seen.push(JSON.parse(opts.body));
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { initDb, execute, queryOne, queryAll } = await import('../src/db/index.js');
const { complete } = await import('../src/services/llm.js');
const { buildManager } = await import('../src/engine/build-manager.js');
const { createAction, applyAction, revertAction, publicAction } = await import('../src/services/assistant-actions.js');
const { projectLink } = await import('../src/services/notifications.js');
buildManager.buildAndDeploy = async () => {};

initDb();
const tag = `po_${Date.now()}`;
const now = new Date().toISOString();
execute(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, 'U', 'x', ?, ?)`, `usr_${tag}`, `${tag}@c.test`, now, now);
execute(`INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'T', ?, ?, ?)`, `team_${tag}`, tag, now, now);
execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, `team_${tag}`, `usr_${tag}`, now);
execute(`INSERT INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'P', '', ?, ?)`, `prj_${tag}`, `team_${tag}`, now, now);
execute(`INSERT INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, `env_${tag}`, `prj_${tag}`, now, now);
execute(`INSERT INTO assistant_threads (id, project_id, environment_id, title, created_by, created_at, last_activity_at) VALUES (?, ?, ?, 't', ?, ?, ?)`, `thd_${tag}`, `prj_${tag}`, `env_${tag}`, `usr_${tag}`, now, now);
execute(`INSERT INTO assistant_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', 'x', ?)`, `msg_${tag}`, `thd_${tag}`, now);
execute(`INSERT INTO services (id, environment_id, name, kind, status, source_type, created_at, updated_at) VALUES (?, ?, 'api', 'app', 'running', 'local', ?, ?)`, `srv_${tag}`, `env_${tag}`, now, now);
execute(`INSERT INTO service_networking (service_id, public, target_port) VALUES (?, 0, 3000)`, `srv_${tag}`);
const user = { id: `usr_${tag}`, name: 'U', email: `${tag}@c.test` };

const act = (payload) => createAction({ messageId: `msg_${tag}`, threadId: `thd_${tag}`, type: 'platform_op', title: 't', reversible: true, payload, diff: [] });
const row = (id) => queryOne('SELECT * FROM assistant_actions WHERE id = ?', id);

test('"make it public" gives the service a generated https URL, and revert takes it back', async () => {
  const id = act({ op: 'expose', serviceId: `srv_${tag}` });
  const applied = await applyAction(row(id), user);
  const result = JSON.parse(applied.result);
  assert.match(result.url, /^https:\/\/api-.+\./);
  assert.equal(queryOne('SELECT public FROM service_networking WHERE service_id = ?', `srv_${tag}`).public, 1);
  assert.equal(queryAll("SELECT id FROM domains WHERE service_id = ? AND kind = 'generated'", `srv_${tag}`).length, 1);
  assert.equal(publicAction(row(id)).payload.op, 'expose');
  await revertAction(row(id), user);
  assert.equal(queryOne('SELECT public FROM service_networking WHERE service_id = ?', `srv_${tag}`).public, 0);
  assert.equal(queryAll('SELECT id FROM domains WHERE service_id = ?', `srv_${tag}`).length, 0);
});

test('adding a database creates it, connects it, redeploys the app, and revert removes it', async () => {
  const id = act({ op: 'add_database', kind: 'postgres', env: 'DATABASE_URL', serviceId: `srv_${tag}` });
  const result = JSON.parse((await applyAction(row(id), user)).result);
  assert.ok(result.deploymentId);
  const url = queryOne("SELECT value FROM variables WHERE scope_type = 'service' AND scope_id = ? AND key = 'DATABASE_URL'", `srv_${tag}`);
  assert.match(url.value, /^postgresql:\/\//);
  assert.ok(queryOne('SELECT 1 AS x FROM connections WHERE from_service_id = ?', `srv_${tag}`));
  await revertAction(row(id), user);
  assert.equal(queryOne("SELECT 1 AS x FROM variables WHERE scope_type = 'service' AND scope_id = ? AND key = 'DATABASE_URL'", `srv_${tag}`), undefined);
  assert.equal(queryAll("SELECT id FROM services WHERE environment_id = ? AND source_template_id = 'postgres'", `env_${tag}`).length, 0);
});

test('redeploy starts a deployment', async () => {
  const id = act({ op: 'redeploy', serviceId: `srv_${tag}` });
  const result = JSON.parse((await applyAction(row(id), user)).result);
  assert.ok(queryOne('SELECT 1 AS x FROM deployments WHERE id = ?', result.deploymentId));
});

test('images reach the model as image parts', async () => {
  seen.length = 0;
  await complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'what is this' }] }] });
  const content = seen[0].messages[1].content;
  assert.equal(content[0].type, 'image_url');
  assert.equal(content[0].image_url.url, 'data:image/png;base64,AAAA');
});

test('notification links point at /project/<id>', () => {
  assert.equal(projectLink('prj_1'), '/project/prj_1');
});
