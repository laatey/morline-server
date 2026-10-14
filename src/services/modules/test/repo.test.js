import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromise, projectWith, reader } from '../test-support/helpers.js';
import { planModuleChange, EngineError, MANIFEST_PATH } from '../index.js';

/** Apply engine changes to an in-memory repo, like the platform does when committing. */
function apply(repo, changes) {
  const next = new Map(repo);
  for (const c of changes) {
    if (c.action === 'delete') next.delete(c.path);
    else next.set(c.path, c.after);
  }
  return next;
}

async function repoWith(modules) {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, modules);
  return { catalog, repo: new Map(p.files) };
}

const same = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [k, v] of a) assert.equal(v, b.get(k), k);
};

test('adding a module to an existing repository yields a reviewable change set', async () => {
  const { catalog, repo } = await repoWith(['security-headers', 'rate-limit']);
  const steps = [];
  const result = await planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'add', id: 'email-resend' }], hooks: { onStep: (t, m) => steps.push([t, m.icon]) } });

  assert.deepEqual(steps, [['Adding Resend email', 'resend']]);
  assert.deepEqual(result.changes.map((c) => `${c.action} ${c.path}`), [
    'update .env.example',
    `update ${MANIFEST_PATH}`,
    'update README.md',
    'create src/lib/email.js',
    'create src/lib/http.js'
  ]);
  for (const c of result.changes.filter((x) => x.action === 'update')) assert.notEqual(c.before, c.after);
  assert.deepEqual(result.envVars.map((v) => v.key), ['RESEND_API_KEY']);
  assert.equal(result.summary, 'Added Resend email');

  const { catalog: c2, repo: expected } = await repoWith(['security-headers', 'rate-limit', 'email-resend']);
  assert.ok(c2);
  same(apply(repo, result.changes), expected);
});

test('removing a module deletes exactly what it added', async () => {
  const { catalog, repo } = await repoWith(['security-headers', 'cors', 'rate-limit', 'email-resend']);
  const result = await planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'remove', id: 'email-resend' }] });
  assert.deepEqual(result.changes.filter((c) => c.action === 'delete').map((c) => c.path).sort(), ['src/lib/email.js', 'src/lib/http.js']);
  const { repo: expected } = await repoWith(['security-headers', 'cors', 'rate-limit']);
  same(apply(repo, result.changes), expected);
});

test('switching provider is one change set', async () => {
  const { catalog, repo } = await repoWith(['email-postmark']);
  const result = await planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'add', id: 'email-resend' }] });
  assert.equal(result.replaced.length, 1);
  assert.ok(result.changes.some((c) => c.path === 'src/lib/email.js' && c.action === 'update'));
  const { repo: expected } = await repoWith(['email-resend']);
  same(apply(repo, result.changes), expected);
});

test('code the user wrote is never deleted silently', async () => {
  const { catalog, repo } = await repoWith(['scheduler', 'cors']);
  repo.set('src/jobs/index.js', "export const jobs = [{ name: 'nightly', schedule: '0 3 * * *', run: async () => {} }];\n");
  repo.set('src/plugins/cors.js', `${repo.get('src/plugins/cors.js')}// tuned by hand\n`);
  const result = await planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'remove', id: 'scheduler' }, { op: 'remove', id: 'cors' }] });
  const next = apply(repo, result.changes);
  assert.ok(next.has('src/jobs/index.js'), 'the user\'s job file is kept');
  assert.ok(!next.has('src/plugins/scheduler.js'));
  assert.ok(!next.has('src/plugins/cors.js'));
  assert.ok(result.warnings.some((w) => /Kept src\/jobs\/index\.js/.test(w)));
  assert.ok(result.warnings.some((w) => /src\/plugins\/cors\.js had been edited by hand/.test(w)));
});

test('files the user added to the wiring survive a module change', async () => {
  const { catalog, repo } = await repoWith(['security-headers', 'rate-limit']);
  repo.set('src/app.js', repo.get('src/app.js')
    .replace("import routes from './routes/index.js';", "import routes from './routes/index.js';\nimport myThing from './my-thing.js';")
    .replace('  // -- core --', '  await app.register(myThing);\n\n  // -- core --'));
  const result = await planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'add', id: 'cors' }, { op: 'remove', id: 'rate-limit' }] });
  const app = apply(repo, result.changes).get('src/app.js');
  assert.match(app, /import myThing from '\.\/my-thing\.js';/);
  assert.match(app, /await app\.register\(myThing\);/);
  assert.match(app, /await app\.register\(cors\);/);
  assert.ok(!app.includes('rateLimiting'));
});

test('a repository the engine did not generate is left alone with a clear reason', async () => {
  const catalog = await catalogPromise;
  const repo = new Map([['package.json', '{}'], ['src/index.js', 'x']]);
  await assert.rejects(planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'add', id: 'cors' }] }), (e) => e instanceof EngineError && e.code === 'not_modular');
  repo.set(MANIFEST_PATH, '{ nope');
  await assert.rejects(planModuleChange(catalog, { ...reader(repo), ops: [] }), (e) => e.code === 'not_modular');
});

test('when the user restructured a wired file the engine stops instead of guessing', async () => {
  const { catalog, repo } = await repoWith(['security-headers']);
  repo.set('src/app.js', repo.get('src/app.js').replace('  // -- security --\n', '').replace('  // -- core --\n', ''));
  await assert.rejects(planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'add', id: 'cors' }] }), (e) => e.code === 'patch_conflict' && /src\/app\.js/.test(e.message));
  const { repo: broken } = await repoWith(['cors']);
  broken.set('package.json', '{ not json');
  await assert.rejects(planModuleChange(catalog, { ...reader(broken), ops: [{ op: 'add', id: 'rate-limit' }] }), (e) => e.code === 'patch_conflict');
});

test('resources can be added to and removed from an existing repository', async () => {
  const { catalog, repo } = await repoWith(['postgres', 'auth-jwt', 'auth-password']);
  const added = await planModuleChange(catalog, { ...reader(repo), resources: [{ op: 'add', spec: { name: 'orders', fields: [{ name: 'total', type: 'number' }] } }] });
  assert.ok(added.changes.some((c) => c.path === 'migrations/0002_create_orders.sql' && c.action === 'create'));
  const next = apply(repo, added.changes);
  const removed = await planModuleChange(catalog, { ...reader(next), resources: [{ op: 'remove', name: 'orders' }] });
  assert.deepEqual(removed.changes.filter((c) => c.action === 'delete').map((c) => c.path), ['src/routes/orders.js']);
  assert.ok(removed.warnings.length === 1);
});

test('a no-op request produces no changes', async () => {
  const { catalog, repo } = await repoWith(['cors']);
  const result = await planModuleChange(catalog, { ...reader(repo), ops: [{ op: 'add', id: 'cors' }] });
  assert.deepEqual(result.changes, []);
});
