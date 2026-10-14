import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromise, syntaxCheck } from '../test-support/helpers.js';
import { buildFromCompose, runChecks } from '../index.js';

const LIMITS = { files: 60, file: 200_000, total: 600_000 };

test('every preset renders a clean project', async () => {
  const catalog = await catalogPromise;
  for (const preset of Object.keys(catalog.meta.presets)) {
    const result = buildFromCompose(catalog, { name: `demo-${preset}`, description: 'Demo', preset });
    const map = new Map(result.files.map((f) => [f.path, f.content]));

    assert.ok(result.files.length <= LIMITS.files, `${preset}: ${result.files.length} files`);
    assert.ok(result.files.every((f) => f.content.length < LIMITS.file));
    assert.ok(result.files.reduce((n, f) => n + f.content.length, 0) < LIMITS.total);
    assert.deepEqual(runChecks(map).errors, [], `${preset} static checks`);
    assert.deepEqual(await syntaxCheck(map), [], `${preset} syntax`);
    for (const [path, text] of map) assert.ok(!/\{\{\s*[\w.]+(\|json)?\s*\}\}/.test(text), `${preset}: ${path} has no template markers`);
    assert.ok(map.has('Dockerfile') && map.has('.env.example') && map.has('.morline/modules.json'));
  }
});

test('a preset only contains code for the modules it uses', async () => {
  const catalog = await catalogPromise;
  const result = buildFromCompose(catalog, { name: 'tiny', preset: 'webhook-receiver' });
  const paths = result.files.map((f) => f.path);
  assert.ok(paths.includes('src/plugins/rate-limit.js'));
  assert.ok(!paths.some((p) => /postgres|auth|stripe|email|redis/.test(p)), 'nothing unrelated is shipped');
  const pkg = JSON.parse(result.files.find((f) => f.path === 'package.json').content);
  assert.deepEqual(Object.keys(pkg.dependencies), ['@fastify/helmet', '@fastify/rate-limit', 'fastify', 'fastify-plugin']);
  const env = result.files.find((f) => f.path === '.env.example').content;
  assert.ok(!env.includes('DATABASE_URL') && !env.includes('JWT_SECRET'));
});

test('generated app.js reads like hand-written code', async () => {
  const catalog = await catalogPromise;
  const result = buildFromCompose(catalog, { name: 'demo', preset: 'saas-backend' });
  const app = result.files.find((f) => f.path === 'src/app.js').content;
  assert.match(app, /\/\/ -- data --\n {2}await app\.register\(postgres\);\n {2}await app\.register\(redis\);\n/);
  assert.match(app, /\/\/ -- security --\n {2}await app\.register\(securityHeaders\);\n {2}await app\.register\(cors\);\n {2}await app\.register\(rateLimiting\);\n {2}await app\.register\(auth\);\n/);
  assert.ok(app.indexOf('// -- data --') < app.indexOf('// -- security --'));
  assert.ok(app.indexOf('// -- features --') < app.indexOf('// -- core --'));
});
