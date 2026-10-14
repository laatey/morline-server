import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromise, projectWith, filesOf, syntaxCheck } from '../test-support/helpers.js';
import { runChecks } from '../index.js';

const ORDER = { name: 'orders', fields: [{ name: 'total', type: 'number', required: true }, { name: 'status', type: 'string' }, { name: 'paid_at', type: 'datetime' }, { name: 'ref', type: 'string', unique: true }] };

test('PostgreSQL resources generate routes and a numbered migration', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['postgres', 'auth-jwt', 'auth-password']);
  p.addResource(ORDER);
  assert.ok(p.files.has('src/routes/orders.js'));
  assert.ok(p.files.has('migrations/0002_create_orders.sql'), 'numbered after the users migration');
  const sql = p.files.get('migrations/0002_create_orders.sql');
  assert.match(sql, /"total" double precision not null,/);
  assert.match(sql, /"ref" text unique,/);
  assert.match(sql, /id uuid primary key default gen_random_uuid\(\)/);
  const routes = p.files.get('src/routes/orders.js');
  assert.match(routes, /insert into "orders" \("total", "status", "paid_at", "ref"\) values \(\$1, \$2, \$3, \$4\) returning \*/);
  assert.match(routes, /export const prefix = '\/orders';/);
  assert.ok(!/req\.(body|query|params)[^;]*\+/.test(routes), 'no string-built SQL from request data');
  assert.deepEqual(await syntaxCheck(filesOf(p)), []);
  assert.deepEqual(runChecks(p.files).errors, []);
});

test('MongoDB resources use the connected client and valid object ids', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['mongodb']);
  p.addResource({ name: 'notes', fields: [{ name: 'title', type: 'string', required: true }, { name: 'dueAt', type: 'datetime' }, { name: 'slug', type: 'string', unique: true }] });
  const routes = p.files.get('src/routes/notes.js');
  assert.match(routes, /app\.mongo\.db\(\)\.collection\('notes'\)/);
  assert.match(routes, /\^\[a-f0-9\]\{24\}\$/);
  assert.match(routes, /createIndex\(\{ "slug": 1 \}, \{ unique: true \}\)/);
  assert.ok(![...p.files.keys()].some((f) => f.startsWith('migrations/')));
  assert.deepEqual(await syntaxCheck(filesOf(p)), []);
});

test('a resource adds the database it needs', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['security-headers']);
  p.addResource(ORDER);
  assert.ok(p.has('postgres'));
  assert.ok(p.files.get('package.json').includes('"pg"'));
});

test('resource names and fields are validated before anything is written', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['postgres']);
  const bad = (spec) => assert.throws(() => p.addResource(spec), (e) => e.code === 'bad_resource', JSON.stringify(spec));
  bad({ name: 'orders; drop table users', fields: [{ name: 'a', type: 'string' }] });
  bad({ name: 'Orders', fields: [{ name: 'a', type: 'string' }] });
  bad({ name: 'auth', fields: [{ name: 'a', type: 'string' }] });
  bad({ name: 'orders', fields: [] });
  bad({ name: 'orders', fields: [{ name: 'a"; drop', type: 'string' }] });
  bad({ name: 'orders', fields: [{ name: 'id', type: 'string' }] });
  bad({ name: 'orders', fields: [{ name: 'a', type: 'blob' }] });
  bad({ name: 'orders', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] });
  assert.ok(![...p.files.keys()].includes('src/routes/orders.js'), 'nothing was written by the failed attempts');
});

test('removing a resource keeps its migration so no table is ever dropped silently', async () => {
  const catalog = await catalogPromise;
  const p = projectWith(catalog, ['postgres']);
  p.addResource(ORDER);
  p.removeResource('orders');
  assert.ok(!p.files.has('src/routes/orders.js'));
  assert.ok(p.files.has('migrations/0001_create_orders.sql'));
  assert.ok(p.finish().warnings.some((w) => /never drops/.test(w)));
  p.removeModule('postgres');
});
