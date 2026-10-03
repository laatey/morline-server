import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRuntime, satisfiesNodeRange } from '../src/engine/runtime-resolver.js';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morline-runtime-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('resolves Node declarations and semver ranges to supported runtimes', () => {
  for (const [range, version] of [['18.x', '18'], ['^20.19.0', '20'], ['>=20.19.0', '24'], ['>=18 <22', '20']]) {
    const dir = project({ 'package.json': { engines: { node: range } } });
    assert.equal(resolveRuntime(dir).version, version, range);
  }
});

test('uses .nvmrc and reports incompatible explicit declarations', () => {
  const fromNvm = project({ 'package.json': {}, '.nvmrc': '20.19.0\n' });
  assert.equal(resolveRuntime(fromNvm).version, '20');
  const conflicting = project({ 'package.json': { engines: { node: '18.x' } }, '.nvmrc': '20' });
  assert.throws(() => resolveRuntime(conflicting), /No supported Node runtime/);
});

test('uses dependency engine requirements from package-lock without Vite-specific logic', () => {
  const dir = project({
    'package.json': { name: 'app', devDependencies: { 'build-tool': '1.0.0' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': { name: 'app' }, 'node_modules/build-tool': { engines: { node: '^20.19.0 || >=22.12.0' } } } }
  });
  const result = resolveRuntime(dir);
  assert.equal(result.version, '24');
  assert.match(result.source, /dependency build-tool/);
});

test('honors a validated platform runtime setting before defaults', () => {
  const dir = project({ 'package.json': {} });
  assert.equal(resolveRuntime(dir, { override: '20.x' }).version, '20');
  assert.throws(() => resolveRuntime(dir, { override: '16.x' }), /No supported Node runtime/);
});

test('detects representative non-Node runtimes and version source files', () => {
  assert.equal(resolveRuntime(project({ 'pyproject.toml': '[project]\n' })).runtime, 'python');
  assert.equal(resolveRuntime(project({ 'go.mod': 'module example\ngo 1.22\n' })).runtime, 'go');
  assert.equal(resolveRuntime(project({ 'Cargo.toml': '[package]\nname="app"\n' })).runtime, 'rust');
});

test('semver constraint matching covers the supported syntax', () => {
  assert.equal(satisfiesNodeRange([20, 19, 0], '^20.19.0'), true);
  assert.equal(satisfiesNodeRange([22, 11, 0], '>=22.12.0'), false);
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=18 <22'), true);
});
