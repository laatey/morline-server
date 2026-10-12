import assert from 'node:assert/strict';
import test from 'node:test';

process.env.JWT_SECRET ??= 'test-secret-not-for-production';
const { initDb, execute, queryOne, queryAll } = await import('../src/db/index.js');
const { normalizePath, applyEdits, resolveChanges, validateNewFiles } = await import('../src/services/builder/files.js');
const { lineDiff, describeChanges } = await import('../src/services/builder/diff.js');
const { extractJson } = await import('../src/services/llm.js');
const { validateLimits, capacityReport } = await import('../src/engine/capacity.js');
const { createAction, applyAction, revertAction, dismissAction, publicAction } = await import('../src/services/assistant-actions.js');
const { buildManager } = await import('../src/engine/build-manager.js');

initDb();
const deploys = [];
buildManager.buildAndDeploy = async (serviceId, deploymentId) => { deploys.push({ serviceId, deploymentId }); };

// --- pure helpers ------------------------------------------------------------------------------

test('paths are normalised and unsafe ones refused', () => {
  assert.equal(normalizePath('src/app.js'), 'src/app.js');
  assert.equal(normalizePath('./README.md'), 'README.md');
  for (const bad of ['../x', '/etc/passwd', 'a//b', 'a\\b', 'node_modules/x.js', '.git/config', '', null]) assert.equal(normalizePath(bad), null, String(bad));
});

test('new file sets are validated', () => {
  assert.throws(() => validateNewFiles([]), /no files/);
  assert.throws(() => validateNewFiles([{ path: '.env', content: 'SECRET=1' }]), /secrets/);
  assert.throws(() => validateNewFiles([{ path: 'a.js', content: 'x' }, { path: 'A.js', content: 'y' }]), /Duplicate/);
  const ok = validateNewFiles([{ path: 'Dockerfile', content: 'FROM node' }, { path: '.env.example', content: 'A=' }]);
  assert.equal(ok[0].content, 'FROM node\n');
  assert.equal(ok.length, 2);
});

test('edits must match exactly once', () => {
  assert.equal(applyEdits('a b c', [{ find: 'b', replace: 'X' }]), 'a X c');
  assert.throws(() => applyEdits('a a', [{ find: 'a', replace: 'b' }]), /more than once/);
  assert.throws(() => applyEdits('a', [{ find: 'z', replace: 'b' }]), /not found/);
});

test('proposed changes resolve against real files and no-ops are dropped', () => {
  const existing = new Map([['a.js', 'one\ntwo\n'], ['b.js', 'keep\n']]);
  const out = resolveChanges([
    { path: 'a.js', action: 'update', edits: [{ find: 'two', replace: '2' }] },
    { path: 'b.js', action: 'update', content: 'keep\n' },
    { path: 'c.js', action: 'create', content: 'new\n' }
  ], existing);
  assert.deepEqual(out.map((c) => [c.path, c.action]), [['a.js', 'update'], ['c.js', 'create']]);
  assert.throws(() => resolveChanges([{ path: 'x.js', action: 'delete' }], existing), /does not exist/);
  assert.throws(() => resolveChanges([{ path: 'a.js', action: 'update', content: 'x' }, { path: 'a.js', action: 'delete' }], existing), /twice/);
  assert.throws(() => resolveChanges([{ path: 'hidden.js', action: 'create', content: 'x' }], existing, new Set(['hidden.js'])), /not provided/);
});

test('line diff reports hunks with context and counts', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 10\n', 'line ten\nextra\n');
  const d = lineDiff(before, after);
  assert.equal(d.additions, 2);
  assert.equal(d.deletions, 1);
  assert.equal(d.hunks.length, 1);
  assert.equal(d.hunks[0].lines.filter((l) => l.type === 'ctx').length, 6);
  const created = describeChanges([{ path: 'n.txt', action: 'create', before: '', after: 'a\nb\n' }])[0];
  assert.equal(created.additions, 2);
});

test('JSON is pulled out of fenced or chatty replies', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('here {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => extractJson('nothing'), /JSON/);
});

test('resource limits must fit what the host has left', () => {
  const env = { MORLINE_CAPACITY_CPUS: '4', MORLINE_CAPACITY_MEMORY_MB: '8192', MORLINE_RESERVED_CPUS: '1', MORLINE_RESERVED_MEMORY_MB: '1024', MORLINE_DEFAULT_MEMORY_MB: '1024', MORLINE_DEFAULT_CPUS: '1' };
  const r = capacityReport({ env });
  assert.equal(r.cpu.total, 4);
  assert.ok(r.cpu.available <= 3);
  assert.equal(validateLimits({ serviceId: null, cpus: 0.05, env }) !== null, true);
  assert.equal(validateLimits({ serviceId: null, memoryMb: 64, env }) !== null, true);
  assert.equal(validateLimits({ serviceId: null, cpus: 100, env }) !== null, true);
  assert.equal(validateLimits({ serviceId: null, memoryMb: 100000, env }) !== null, true);
  const roomy = { ...env, MORLINE_CAPACITY_CPUS: '10000', MORLINE_CAPACITY_MEMORY_MB: '100000000' };
  assert.equal(validateLimits({ serviceId: null, cpus: 0.5, memoryMb: 256, env: roomy }), null);
});

// --- actions against a fake GitHub ---------------------------------------------------------------

const t = Date.now();
const now = new Date().toISOString();
const ids = { owner: `usr_b_o_${t}`, viewer: `usr_b_v_${t}`, team: `team_b_${t}`, project: `prj_b_${t}`, env: `env_b_${t}`, thread: `thd_b_${t}`, msg: `msg_b_${t}`, service: `srv_b_${t}` };
for (const [id, email] of [[ids.owner, `o_${t}@b.test`], [ids.viewer, `v_${t}@b.test`]]) {
  execute(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, 'U', 'x', ?, ?)`, id, email, now, now);
}
execute(`INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'T', ?, ?, ?)`, ids.team, `b-${t}`, now, now);
execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`, ids.team, ids.owner, now);
execute(`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'viewer', ?)`, ids.team, ids.viewer, now);
execute(`INSERT INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'P', '', ?, ?)`, ids.project, ids.team, now, now);
execute(`INSERT INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, ids.env, ids.project, now, now);
execute(`INSERT INTO assistant_threads (id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at) VALUES (?, ?, ?, 't', 0, ?, ?, ?)`, ids.thread, ids.project, ids.env, ids.owner, now, now);
execute(`INSERT INTO assistant_messages (id, thread_id, role, status, content, created_at) VALUES (?, ?, 'assistant', 'done', 'x', ?)`, ids.msg, ids.thread, now);
execute(`INSERT INTO github_integration (team_id, account, install_url, access_token, connected, connected_at) VALUES (?, 'acct', 'https://github.com/apps/x/installations/new', 'oauth-token', 1, ?)`, ids.team, now);
const owner = { id: ids.owner, name: 'Owner', email: `o_${t}@b.test` };
const viewer = { id: ids.viewer, name: 'Viewer', email: `v_${t}@b.test` };

// Minimal GitHub: repos with one branch, atomic commits, branch protection off.
const gh = { repos: new Map(), calls: [], takenOnce: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.github.com') return realFetch(url, init);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  const path = u.pathname;
  gh.calls.push(`${method} ${path}`);
  const reply = (status, data) => new Response(status === 204 ? null : JSON.stringify(data), { status });
  let m;
  if (path === '/user') return reply(200, { login: 'acct' });
  if (method === 'POST' && path === '/user/repos') {
    if (body.name === 'task-api' && !gh.takenOnce) { gh.takenOnce = true; return reply(422, { message: 'name already exists on this account' }); }
    gh.repos.set(`acct/${body.name}`, { head: 'c0', n: 0 });
    return reply(201, { full_name: `acct/${body.name}`, html_url: `https://github.com/acct/${body.name}`, default_branch: 'main' });
  }
  if ((m = path.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/))) {
    const repo = gh.repos.get(m[1]);
    const rest = m[2];
    if (!repo) return reply(404, { message: 'Not Found' });
    if (method === 'GET' && /^git\/ref\/heads\//.test(rest)) return reply(200, { object: { sha: repo.head } });
    if (method === 'GET' && /^git\/commits\//.test(rest)) return reply(200, { tree: { sha: 'tree0' } });
    if (method === 'POST' && rest === 'git/blobs') return reply(201, { sha: `blob${++repo.n}` });
    if (method === 'POST' && rest === 'git/trees') { repo.lastTree = body.tree; return reply(201, { sha: `tree${++repo.n}` }); }
    if (method === 'POST' && rest === 'git/commits') return reply(201, { sha: `c${++repo.n}`, html_url: `https://github.com/${m[1]}/commit/x` });
    if (method === 'PATCH' && /^git\/refs\/heads\//.test(rest)) { repo.head = body.sha; return reply(200, {}); }
    if (method === 'POST' && rest === 'git/refs') return reply(201, {});
    if (method === 'POST' && rest === 'pulls') return reply(201, { html_url: `https://github.com/${m[1]}/pull/7`, number: 7 });
  }
  return reply(404, { message: `unhandled ${method} ${path}` });
};
test.after(() => { globalThis.fetch = realFetch; });

const newAction = (type, payload, diff = []) => createAction({ messageId: ids.msg, threadId: ids.thread, type, title: 't', payload, diff });
const row = (id) => queryOne('SELECT * FROM assistant_actions WHERE id = ?', id);

test('create_app makes a repo, commits the files, creates and deploys the service, and can be reverted', async () => {
  const id = newAction('create_app', {
    name: 'task-api', description: 'Tasks', port: 4000, environmentId: ids.env, projectId: ids.project,
    envVars: [{ key: 'JWT_SECRET', description: 'signing key', generate: true }, { key: 'EXTERNAL_KEY', generate: false }],
    files: [{ path: 'Dockerfile', content: 'FROM node:22\n' }, { path: 'index.js', content: 'console.log(1)\n' }]
  });
  const done = await applyAction(row(id), owner);
  assert.equal(done.status, 'applied');
  const result = JSON.parse(done.result);
  assert.equal(result.repo.fullName, 'acct/task-api-2', 'a taken name falls back to a suffixed one');
  assert.ok(result.commitSha && result.serviceId && result.deploymentId);

  const service = queryOne('SELECT * FROM services WHERE id = ?', result.serviceId);
  assert.equal(service.source_repo, 'acct/task-api-2');
  assert.equal(queryOne('SELECT target_port FROM service_networking WHERE service_id = ?', service.id).target_port, 4000);
  const vars = queryAll('SELECT key, secret, value FROM variables WHERE scope_id = ?', service.id);
  assert.deepEqual(vars.map((v) => v.key), ['JWT_SECRET'], 'only generated variables are created');
  assert.equal(vars[0].secret, 1);
  assert.equal(vars[0].value.length, 48);
  assert.ok(deploys.some((d) => d.deploymentId === result.deploymentId));
  assert.equal(queryOne('SELECT trigger FROM deployments WHERE id = ?', result.deploymentId).trigger, 'assistant');

  assert.equal(publicAction(row(id)).payload.files, undefined, 'file bodies are not sent to the client');

  const reverted = await revertAction(row(id), owner);
  assert.equal(reverted.status, 'reverted');
  assert.equal(queryOne('SELECT 1 AS x FROM services WHERE id = ?', result.serviceId), undefined);
});

test('applying twice is refused and viewers cannot apply', async () => {
  const id = newAction('create_app', { name: 'solo', port: 3000, environmentId: ids.env, envVars: [], files: [{ path: 'Dockerfile', content: 'FROM scratch\n' }] });
  await assert.rejects(applyAction(row(id), viewer), /Viewers/);
  await applyAction(row(id), owner);
  await assert.rejects(applyAction(row(id), owner), (e) => e.code === 'action_stale');
});

test('modify_code commits on the branch, redeploys, and revert restores the old files', async () => {
  gh.repos.set('acct/site', { head: 'base1', n: 0 });
  execute(`INSERT INTO services (id, environment_id, name, kind, status, source_type, source_repo, source_branch, created_at, updated_at) VALUES (?, ?, 'site', 'app', 'running', 'github', 'acct/site', 'main', ?, ?)`, ids.service, ids.env, now, now);
  const changes = [
    { path: 'a.js', action: 'update', before: 'old\n', after: 'new\n' },
    { path: 'b.js', action: 'create', before: null, after: 'b\n' },
    { path: 'c.js', action: 'delete', before: 'c\n', after: null }
  ];
  const id = newAction('modify_code', { serviceId: ids.service, repo: 'acct/site', branch: 'main', baseSha: 'base1', mode: 'commit', message: 'Add b', summary: 's', changes }, describeChanges(changes));
  const before = deploys.length;
  const done = await applyAction(row(id), owner);
  assert.equal(done.status, 'applied');
  const result = JSON.parse(done.result);
  assert.equal(gh.repos.get('acct/site').head, result.commitSha);
  assert.deepEqual(gh.repos.get('acct/site').lastTree.map((e) => [e.path, e.sha === null]), [['a.js', false], ['b.js', false], ['c.js', true]]);
  assert.equal(deploys.length, before + 1);

  const reverted = await revertAction(row(id), owner);
  assert.equal(reverted.status, 'reverted');
  const undo = gh.repos.get('acct/site').lastTree.map((e) => [e.path, e.sha === null]);
  assert.deepEqual(undo, [['a.js', false], ['b.js', true], ['c.js', false]], 'create is deleted, delete is recreated, update is restored');
});

test('a branch that moved on makes the proposal stale instead of overwriting it', async () => {
  gh.repos.set('acct/moved', { head: 'newer', n: 0 });
  const id = newAction('modify_code', { serviceId: null, repo: 'acct/moved', branch: 'main', baseSha: 'older', mode: 'commit', message: 'x', changes: [{ path: 'a.js', action: 'create', before: null, after: 'a\n' }] });
  await assert.rejects(applyAction(row(id), owner), (e) => e.code === 'action_stale');
  assert.equal(row(id).status, 'dismissed');
  assert.equal(gh.repos.get('acct/moved').head, 'newer');
});

test('pull request mode opens a PR and does not deploy', async () => {
  gh.repos.set('acct/pr', { head: 'p1', n: 0 });
  const id = newAction('modify_code', { serviceId: null, repo: 'acct/pr', branch: 'main', baseSha: 'p1', mode: 'commit', message: 'Tweak', summary: 'Tweaked', changes: [{ path: 'a.js', action: 'create', before: null, after: 'a\n' }] });
  execute('UPDATE assistant_actions SET payload = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(row(id).payload), mode: 'pr' }), id);
  const before = deploys.length;
  const done = await applyAction(row(id), owner);
  const result = JSON.parse(done.result);
  assert.match(result.pullRequestUrl, /pull\/7$/);
  assert.match(result.branch, /^morline\//);
  assert.equal(deploys.length, before);
  await assert.rejects(revertAction(row(id), owner), (e) => e.code === 'action_not_reversible');
});

test('pending actions can be dismissed once', () => {
  const id = newAction('create_app', { name: 'n', files: [] });
  assert.equal(dismissAction(row(id), owner).status, 'dismissed');
  assert.throws(() => dismissAction(row(id), owner), (e) => e.code === 'action_stale');
});
