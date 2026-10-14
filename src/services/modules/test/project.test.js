import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromise, projectWith, filesOf, syntaxCheck } from '../test-support/helpers.js';
import { Project, EngineError } from '../index.js';

const same = (a, b, label) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${label}: same set of files`);
  for (const [path, content] of a) assert.equal(content, b.get(path), `${label}: ${path} is identical`);
};

const BASES = [
  [],
  ['security-headers', 'cors', 'rate-limit'],
  ['postgres', 'redis', 'auth-jwt'],
  ['metrics', 'swagger-docs', 'postgres']
];

test('adding any module equals generating the project with it from scratch', async () => {
  const catalog = await catalogPromise;
  for (const def of catalog.ordered.filter((m) => !m.internal)) {
    for (const base of BASES.filter((b) => !b.includes(def.id) && !(def.capability && b.some((x) => catalog.modules.get(x).capability === def.capability)))) {
      const added = projectWith(catalog, base);
      added.addModule(def.id);
      const fresh = projectWith(catalog, [...base, def.id]);
      same(filesOf(added), filesOf(fresh), `add ${def.id} to [${base}]`);
    }
  }
});

test('removing a module restores exactly the project without it', async () => {
  const catalog = await catalogPromise;
  for (const def of catalog.ordered.filter((m) => !m.internal)) {
    for (const base of BASES.filter((b) => !b.includes(def.id) && !(def.capability && b.some((x) => catalog.modules.get(x).capability === def.capability)))) {
      const p = projectWith(catalog, [...base, def.id]);
      const before = new Set(p.installed);
      p.removeModule(def.id);
      // Whatever the module pulled in stays (the user may rely on it); internal helpers go away when unused.
      const expected = [...before].filter((id) => id !== def.id && !catalog.modules.get(id).internal);
      same(filesOf(p), filesOf(projectWith(catalog, expected)), `remove ${def.id} from [${base}]`);
    }
  }
});

test('adding then removing a module with no requirements is a perfect round trip', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['security-headers', 'cors']);
  const original = filesOf(p);
  p.addModule('rate-limit');
  p.addModule('metrics');
  p.removeModule('metrics');
  p.removeModule('rate-limit');
  same(filesOf(p), original, 'round trip');
});

test('every module renders valid JavaScript on its own and in combination', async () => {
  const catalog = await catalogPromise;
  const everything = catalog.ordered
    .filter((m) => !m.internal)
    .filter((m, _i, all) => !m.capability || all.find((x) => x.capability === m.capability) === m)
    .map((m) => m.id);
  const p = projectWith(catalog, everything);
  assert.deepEqual(await syntaxCheck(filesOf(p)), []);
  const mongo = projectWith(catalog, ['mongodb', 'auth-password', 'redis', 'queue']);
  assert.deepEqual(await syntaxCheck(filesOf(mongo)), []);
});

test('the module variant follows the connected database', async () => {
  const catalog = await catalogPromise;
  const pg = projectWith(catalog, ['postgres', 'auth-password']);
  assert.ok(pg.files.has('migrations/0001_create_users.sql'));
  assert.match(pg.files.get('src/services/users.js'), /app\.pg\.query/);

  const mongo = projectWith(catalog, ['mongodb', 'auth-password']);
  assert.ok(!mongo.files.has('migrations/0001_create_users.sql'));
  assert.match(mongo.files.get('src/services/users.js'), /app\.mongo/);

  const auto = projectWith(catalog, ['auth-password']);
  assert.ok(auto.has('postgres'), 'a database is added when the module needs one');
});

test('providers of the same capability replace each other', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['email-postmark']);
  p.addModule('email-resend');
  assert.ok(!p.has('email-postmark') && p.has('email-resend'));
  same(filesOf(p), filesOf(projectWith(catalog, ['email-resend'])), 'swap');
  const result = p.finish();
  assert.deepEqual(result.replaced, [{ from: 'email-postmark', to: 'email-resend', capability: 'email' }]);
  assert.ok(!result.files.some((f) => f.content.includes('POSTMARK')), 'nothing of the old provider is left behind');
});

test('modules cannot be removed while something else needs them', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['redis', 'queue']);
  assert.throws(() => p.removeModule('redis'), (e) => e instanceof EngineError && e.code === 'has_dependents' && /Background jobs/.test(e.message));
  const q = projectWith(catalog, ['postgres']);
  q.addResource({ name: 'orders', fields: [{ name: 'total', type: 'number' }] });
  assert.throws(() => q.removeModule('postgres'), (e) => e.code === 'has_dependents' && /orders/.test(e.message));
});

test('options are validated and can reconfigure an installed module', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['rate-limit']);
  p.addModule('rate-limit', { max: 5, window: '1 hour' });
  assert.match(p.files.get('src/plugins/rate-limit.js'), /max: 5,/);
  assert.match(p.files.get('src/plugins/rate-limit.js'), /timeWindow: "1 hour"/);
  same(filesOf(p), filesOf(projectWith(catalog, [{ id: 'rate-limit', options: { max: 5, window: '1 hour' } }])), 'reconfigure');

  const r = projectWith(catalog, ['rate-limit']);
  r.addModule('rate-limit', { store: 'redis' });
  assert.ok(r.has('redis'), 'the redis store pulls in Redis');
  assert.match(r.files.get('src/plugins/rate-limit.js'), /redis: app\.redis/);

  const fresh = () => Project.create(catalog, { name: 'x' });
  assert.throws(() => fresh().addModule('rate-limit', { window: '1 minute"; process.exit(1); //' }), (e) => e.code === 'bad_option');
  assert.throws(() => fresh().addModule('rate-limit', { max: 99999999 }), (e) => e.code === 'bad_option');
  assert.throws(() => fresh().addModule('rate-limit', { nope: 1 }), (e) => e.code === 'bad_option' && /valid: max, window, store/.test(e.message));
  assert.throws(() => fresh().addModule('auth-jwt', { accessTtl: '15 minutes' }), (e) => e.code === 'bad_option');
  assert.throws(() => fresh().addModule('rate-limitt'), (e) => e.code === 'unknown_module' && /rate-limit/.test(e.message));
  assert.throws(() => fresh().addModule('http-client'), (e) => e.code === 'internal_module');
});

test('steps carry the label and icon the UI shows', async () => {
  const catalog = await catalogPromise;
  const seen = [];
  const p = Project.create(catalog, { name: 'x' }, { onStep: (text, meta) => seen.push({ text, ...meta }) });
  p.addModule('email-resend');
  p.addModule('payments-stripe');
  p.addModule('postgres');
  assert.deepEqual(seen.map((s) => [s.text, s.icon]), [
    ['Adding Resend email', 'resend'],
    ['Adding Stripe payments', 'stripe'],
    ['Connecting PostgreSQL', 'postgresql']
  ]);
});

test('env vars, addons and extra services are reported for the platform to act on', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['postgres', 'redis', 'auth-jwt', 'email-resend', 'queue']);
  const r = p.finish();
  const byKey = Object.fromEntries(r.envVars.map((v) => [v.key, v]));
  assert.equal(byKey.JWT_SECRET.generate, true);
  assert.equal(byKey.RESEND_API_KEY.generate, false);
  assert.ok(!('DATABASE_URL' in byKey) && !('EMAIL_FROM' in byKey), 'provisioned and optional variables are not asked of the user');
  assert.deepEqual(r.addons, [{ kind: 'postgres', env: 'DATABASE_URL' }, { kind: 'redis', env: 'REDIS_URL' }]);
  assert.deepEqual(r.services.map((s) => [s.name, s.start]), [['worker', 'node src/worker.js']]);
});

test('extra dependencies are restricted to exact names and caret versions', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['rate-limit']);
  p.addExtraDependencies({ 'date-fns': '^4.1.0' });
  assert.equal(JSON.parse(p.files.get('package.json')).dependencies['date-fns'], '^4.1.0');
  assert.throws(() => p.addExtraDependencies({ 'left-pad': 'latest' }), (e) => e.code === 'bad_dependency');
  assert.throws(() => p.addExtraDependencies({ 'x; rm -rf /': '^1.0.0' }), (e) => e.code === 'bad_dependency');
  p.removeModule('rate-limit');
  assert.ok('date-fns' in JSON.parse(p.files.get('package.json')).dependencies, 'dependencies the user asked for survive module removal');
});
