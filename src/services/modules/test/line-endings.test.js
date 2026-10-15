import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadCatalog, buildFromCompose } from '../index.js';
import { catalogPromise } from '../test-support/helpers.js';

const toCrlf = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) toCrlf(p);
    else writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
};

test('a catalog checked out with Windows line endings still builds (the app.js anchors match)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'catalog-crlf-'));
  cpSync(fileURLToPath(new URL('../catalog/node-fastify/', import.meta.url)), tmp, { recursive: true });
  toCrlf(tmp);
  const catalog = await loadCatalog(pathToFileURL(`${tmp}/`));
  const out = buildFromCompose(catalog, { name: 'x', preset: 'rest-api', modules: [{ id: 'postgres' }, { id: 'cors' }, { id: 'rate-limit' }] });
  const app = out.files.find((f) => f.path === 'src/app.js').content;
  assert.ok(!app.includes('\r'), 'generated files are LF');
  assert.match(app, /-- security --/);
});

test('every module can be added without failing the generated project checks', async () => {
  const catalog = await catalogPromise;
  const ids = [...catalog.modules.keys()].filter((id) => !catalog.modules.get(id).internal);
  for (const id of ids) {
    assert.doesNotThrow(() => buildFromCompose(catalog, { name: 'x', preset: 'rest-api', modules: [{ id }] }), id);
  }
});
