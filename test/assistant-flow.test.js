import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET ??= 'test-secret-not-for-production';
const { initDb, execute, queryOne } = await import('../src/db/index.js');
const { parseChangeOutput } = await import('../src/services/builder/format.js');
const { createRepoService, writeWorkspaceFiles, listWorkspaceFiles, readWorkspaceFile, applyWorkspaceChanges } = await import('../src/services/service-factory.js');
const { createAction, publicAction } = await import('../src/services/assistant-actions.js');
const { summarizeFailure } = await import('../src/services/notifications.js');
const { destroyService } = await import('../src/services/service-cleanup.js');

initDb();
const tag = `af_${Date.now()}`;
const now = new Date().toISOString();
execute(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, 'U', 'x', ?, ?)`, `usr_${tag}`, `${tag}@c.test`, now, now);
execute(`INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'T', ?, ?, ?)`, `team_${tag}`, tag, now, now);
execute(`INSERT INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'P', '', ?, ?)`, `prj_${tag}`, `team_${tag}`, now, now);
execute(`INSERT INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, `env_${tag}`, `prj_${tag}`, now, now);

test('a change set without a <summary> is still usable', () => {
  const out = parseChangeOutput('<change path="Dockerfile" action="update"><edit><find>a</find><replace>b</replace></edit></change>');
  assert.equal(out.complete, true);
  assert.equal(out.changes.length, 1);
  assert.match(out.summary, /Dockerfile/);
});

test('prose with no change blocks is not complete', () => {
  assert.equal(parseChangeOutput('Sure, I will do that.').complete, false);
});

test('a service deployed without GitHub keeps its files in its workspace and can be edited', async () => {
  const svc = createRepoService({ environmentId: `env_${tag}`, name: 'local-app', repo: null, branch: null, port: 3000 });
  assert.equal(svc.source_type, 'local');
  writeWorkspaceFiles(svc.id, [{ path: 'src/index.js', content: 'console.log(1)\n' }, { path: 'Dockerfile', content: 'FROM node:20\n' }]);
  assert.deepEqual(listWorkspaceFiles(svc.id).map((f) => f.path).sort(), ['Dockerfile', 'src/index.js']);
  applyWorkspaceChanges(svc.id, [{ path: 'src/index.js', action: 'update', content: 'console.log(2)\n' }, { path: 'Dockerfile', action: 'delete' }]);
  assert.equal(readWorkspaceFile(svc.id, 'src/index.js'), 'console.log(2)\n');
  assert.equal(readWorkspaceFile(svc.id, 'Dockerfile'), null);
  assert.throws(() => writeWorkspaceFiles(svc.id, [{ path: '../escape.txt', content: 'x' }]));
  await destroyService(svc.id);
});

test('an applied action reports the state of the deployment it started', () => {
  execute(`INSERT INTO services (id, environment_id, name, kind, status, source_type, created_at, updated_at) VALUES (?, ?, 's', 'app', 'crashed', 'local', ?, ?)`, `srv_${tag}`, `env_${tag}`, now, now);
  execute(`INSERT INTO deployments (id, service_id, service_name, environment_id, state, error_summary, created_at) VALUES (?, ?, 's', ?, 'failed', 'boom', ?)`, `dep_${tag}`, `srv_${tag}`, `env_${tag}`, now);
  execute(`INSERT INTO assistant_threads (id, project_id, title, created_at, last_activity_at) VALUES (?, ?, 't', ?, ?)`, `thd_${tag}`, `prj_${tag}`, now, now);
  execute(`INSERT INTO assistant_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', 'x', ?)`, `msg_${tag}`, `thd_${tag}`, now);
  const id = createAction({ messageId: `msg_${tag}`, threadId: `thd_${tag}`, type: 'modify_code', title: 't', payload: { changes: [] }, diff: [] });
  execute('UPDATE assistant_actions SET status = ?, result = ? WHERE id = ?', 'applied', JSON.stringify({ deploymentId: `dep_${tag}` }), id);
  const pub = publicAction(queryOne('SELECT * FROM assistant_actions WHERE id = ?', id));
  assert.equal(pub.deployment.state, 'failed');
  assert.equal(pub.deployment.error, 'boom');
});

test('a build failure is summarised in one readable line, not a Docker log dump', () => {
  const raw = 'Unexpected build error: #0 building with "default" instance #1 [internal] load build definition #1 DONE 0.0s #8 ERROR: process "/bin/sh -c npm install --omit=dev" did not complete successfully: exit code: 1';
  assert.equal(summarizeFailure(raw), 'The build failed while running "npm install --omit=dev" (exit code 1).');
  assert.match(summarizeFailure('#0 building #1 [internal] load x #1 DONE 0.0s'), /Open the deployment in Morline/);
  assert.match(summarizeFailure(''), /Open it in Morline/);
});
