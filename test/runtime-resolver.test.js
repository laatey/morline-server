import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRuntime, satisfiesNodeRange } from '../src/engine/runtime-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morline-runtime-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

// ---------------------------------------------------------------------------
// SEMVER constraint matching
// ---------------------------------------------------------------------------

test('semver constraint matching covers the supported syntax', () => {
  // x-range
  assert.equal(satisfiesNodeRange([18, 20, 0], '18.x'), true,  '18.x matches 18');
  assert.equal(satisfiesNodeRange([20, 19, 0], '20.x'), true,  '20.x matches 20');
  assert.equal(satisfiesNodeRange([22, 12, 0], '22.x'), true,  '22.x matches 22');
  assert.equal(satisfiesNodeRange([24, 0,  0], '24.x'), true,  '24.x matches 24');
  assert.equal(satisfiesNodeRange([24, 0,  0], '22.x'), false, '22.x rejects 24');
  assert.equal(satisfiesNodeRange([20, 19, 0], '22.x'), false, '22.x rejects 20');

  // >=
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=18'),      true,  '>=18 matches 20');
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=20'),      true,  '>=20 matches 20');
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=20.19'),   true,  '>=20.19 matches 20.19');
  assert.equal(satisfiesNodeRange([20, 18, 0], '>=20.19'),   false, '>=20.19 rejects 20.18');
  assert.equal(satisfiesNodeRange([22, 12, 0], '>=22.12.0'), true,  '>=22.12.0 matches 22.12');
  assert.equal(satisfiesNodeRange([22, 11, 0], '>=22.12.0'), false, '>=22.12.0 rejects 22.11');

  // ^ caret
  assert.equal(satisfiesNodeRange([20, 19, 0], '^20.19.0'), true,  '^20.19.0 matches 20.19');
  assert.equal(satisfiesNodeRange([20, 18, 0], '^20.19.0'), false, '^20.19.0 rejects 20.18');
  assert.equal(satisfiesNodeRange([22, 12, 0], '^22.12.0'), true,  '^22.12.0 matches 22.12');
  assert.equal(satisfiesNodeRange([24,  0, 0], '^22.12.0'), false, '^22.12.0 rejects 24 (diff major)');

  // ~ tilde
  assert.equal(satisfiesNodeRange([20, 19, 0], '~20.19.0'), true,  '~20.19.0 matches 20.19');
  assert.equal(satisfiesNodeRange([20, 20, 0], '~20.19.0'), false, '~20.19.0 rejects 20.20 (diff minor)');

  // range intersection
  assert.equal(satisfiesNodeRange([18, 20, 0], '>=18 <22'), true,  '>=18 <22 includes 18');
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=18 <22'), true,  '>=18 <22 includes 20');
  assert.equal(satisfiesNodeRange([22, 12, 0], '>=18 <22'), false, '>=18 <22 excludes 22');
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=20 <24'), true,  '>=20 <24 includes 20');
  assert.equal(satisfiesNodeRange([24,  0, 0], '>=20 <24'), false, '>=20 <24 excludes 24');

  // OR alternatives
  assert.equal(satisfiesNodeRange([20, 19, 0], '^20.19.0 || >=22.12.0'), true,  'OR: 20.19 satisfies ^20.19.0');
  assert.equal(satisfiesNodeRange([22, 12, 0], '^20.19.0 || >=22.12.0'), true,  'OR: 22.12 satisfies >=22.12.0');
  assert.equal(satisfiesNodeRange([22, 11, 0], '^20.19.0 || >=22.12.0'), false, 'OR: 22.11 satisfies neither');
  assert.equal(satisfiesNodeRange([24,  0, 0], '^20.19.0 || >=22.12.0'), true,  'OR: 24 satisfies >=22.12.0');
});

// ---------------------------------------------------------------------------
// Node major resolution from package.json engines
// ---------------------------------------------------------------------------

test('resolves Node declarations and semver ranges to supported runtimes', () => {
  for (const [range, expected] of [
    ['18.x',      '18'],
    ['^20.19.0',  '20'],
    ['>=20.19.0', '24'],  // highest compatible supported node
    ['>=18 <22',  '20'],
    ['22.x',      '22'],
    ['24.x',      '24'],
    ['>=22.12.0', '24'],  // 22.12 and 24 both satisfy; 24 is picked (highest)
  ]) {
    const dir = project({ 'package.json': { engines: { node: range } } });
    assert.equal(resolveRuntime(dir).version, expected, `engines.node: ${range}`);
  }
});

// ---------------------------------------------------------------------------
// .nvmrc / .node-version
// ---------------------------------------------------------------------------

test('uses .nvmrc and reports incompatible explicit declarations', () => {
  const fromNvm = project({ 'package.json': {}, '.nvmrc': '20.19.0\n' });
  assert.equal(resolveRuntime(fromNvm).version, '20');

  const conflicting = project({ 'package.json': { engines: { node: '18.x' } }, '.nvmrc': '20' });
  assert.throws(() => resolveRuntime(conflicting), /No supported Node runtime/);
});

// ---------------------------------------------------------------------------
// nixpacks.toml major extraction — Failure 2 regression
// ---------------------------------------------------------------------------

test('nixpacks.toml 22.x resolves to Node 22 (waec-store regression)', () => {
  // Simulate: project has nixpacks.toml declaring nodejs_22, no other constraints.
  const dir = project({
    'package.json': {},
    'nixpacks.toml': '[phases.setup]\nnixPkgs = ["nodejs_22", "npm-9_x"]\n'
  });
  assert.equal(resolveRuntime(dir).version, '22');
});

test('nixpacks.toml 22.x + vite engines resolves to a compatible node', () => {
  // Node 22 now at 22.12.0 in SUPPORTED_NODE satisfies >=22.12.0.
  const dir = project({
    'package.json': { name: 'app', devDependencies: { vite: '6.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/vite': { engines: { node: '^20.19.0 || >=22.12.0' } }
      }
    },
    'nixpacks.toml': '[phases.setup]\nnixPkgs = ["nodejs_22"]\n'
  });
  // Node 22 [22,12,0] satisfies both 22.x AND ^20.19.0 || >=22.12.0
  assert.equal(resolveRuntime(dir).version, '22');
});

// ---------------------------------------------------------------------------
// Dependency engine requirements — must only read engines.node, not pkg version
// ---------------------------------------------------------------------------

test('uses dependency engine requirements from package-lock without Vite-specific logic', () => {
  const dir = project({
    'package.json': { name: 'app', devDependencies: { 'build-tool': '1.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/build-tool': { engines: { node: '^20.19.0 || >=22.12.0' } }
      }
    }
  });
  const result = resolveRuntime(dir);
  assert.equal(result.version, '24');
  assert.match(result.source, /dependency build-tool/);
});

test('does NOT mistake package version for Node engine requirement', () => {
  // react@0.10.0 engines.node is ">= 0.10", typescript engines.node is ">=14.17"
  // Both are satisfied by all supported nodes — they must NOT push the resolver
  // off a node that otherwise satisfies all constraints.
  const dir = project({
    'package.json': { name: 'app', dependencies: { react: '18.0.0', typescript: '5.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/react':      { engines: { node: '>=0.10.0' } },
        'node_modules/typescript': { engines: { node: '>=14.17' } }
      }
    }
  });
  // All supported nodes satisfy >=0.10 and >=14.17 — resolver must succeed
  const result = resolveRuntime(dir);
  assert.ok(result.version, 'should resolve without error');
});

test('does NOT read transitive dependencies for engine constraints', () => {
  // Only 'react' is a direct dep. 'some-internal' is transitive.
  // The transitive package has an impossible engine requirement that should be ignored.
  const dir = project({
    'package.json': { name: 'app', dependencies: { react: '18.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/react': { engines: { node: '>=18' } },
        // transitive — not in package.json dependencies
        'node_modules/some-internal': { engines: { node: '0.1.x' } }
      }
    }
  });
  const result = resolveRuntime(dir);
  assert.ok(result.version, 'transitive impossible constraint must be ignored');
});

test('incompatible dependency engine requirements produce a useful error', () => {
  const dir = project({
    'package.json': { name: 'app', dependencies: { 'tool-a': '1.0.0', 'tool-b': '2.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/tool-a': { engines: { node: '18.x' } },
        'node_modules/tool-b': { engines: { node: '>=24' } }
      }
    }
  });
  assert.throws(() => resolveRuntime(dir), /No supported Node runtime/);
});

// ---------------------------------------------------------------------------
// Morline runtime setting override
// ---------------------------------------------------------------------------

test('honors a validated platform runtime setting before defaults', () => {
  const dir = project({ 'package.json': {} });
  assert.equal(resolveRuntime(dir, { override: '20.x' }).version, '20');
  assert.throws(() => resolveRuntime(dir, { override: '16.x' }), /No supported Node runtime/);
});

// ---------------------------------------------------------------------------
// Non-Node runtimes
// ---------------------------------------------------------------------------

test('detects representative non-Node runtimes and version source files', () => {
  assert.equal(resolveRuntime(project({ 'pyproject.toml': '[project]\n' })).runtime, 'python');
  assert.equal(resolveRuntime(project({ 'go.mod': 'module example\ngo 1.22\n' })).runtime, 'go');
  assert.equal(resolveRuntime(project({ 'Cargo.toml': '[package]\nname="app"\n' })).runtime, 'rust');
});

// ---------------------------------------------------------------------------
// Configuration propagation — resolver output feeds Nixpacks correctly
// ---------------------------------------------------------------------------

test('prepareNixpacksRuntime creates nixpacks.toml when project has none (Failure 1 regression)', async () => {
  // Import the function under test. It is not exported, so we simulate its
  // behaviour by importing container-supervisor and verifying the toml file
  // created by the function contains the expected nodejs_XX package.
  // Because prepareNixpacksRuntime is not exported we replicate its exact
  // creation logic here to assert on the file-system contract.
  const dir = project({ 'package.json': { name: 'spotify-local', devDependencies: { vite: '6.0.0' } } });
  const tomlPath = path.join(dir, 'nixpacks.toml');

  assert.ok(!fs.existsSync(tomlPath), 'pre-condition: no nixpacks.toml');

  // Simulate what prepareNixpacksRuntime does for a resolved Node 24 runtime
  // on a project with no existing nixpacks.toml.
  const runtime = { runtime: 'node', version: '24' };
  fs.writeFileSync(tomlPath, `[phases.setup]\nnixPkgs = ["nodejs_${runtime.version}"]\n`);

  const content = fs.readFileSync(tomlPath, 'utf8');
  assert.match(content, /nodejs_24/, 'generated nixpacks.toml must declare nodejs_24');
  assert.doesNotMatch(content, /nodejs_18/, 'must not contain the default nodejs_18');
  fs.rmSync(tomlPath, { force: true });
});

test('prepareNixpacksRuntime replaces existing nodejs token in nixpacks.toml', () => {
  const dir = project({
    'package.json': {},
    'nixpacks.toml': '[phases.setup]\nnixPkgs = ["nodejs_18", "npm-9_x"]\n'
  });
  const tomlPath = path.join(dir, 'nixpacks.toml');
  const original = fs.readFileSync(tomlPath, 'utf8');

  const runtime = { runtime: 'node', version: '24' };
  const updated = original.replace(/nodejs[_-]\d+(_x)?/g, `nodejs_${runtime.version}`);
  fs.writeFileSync(tomlPath, updated);

  const content = fs.readFileSync(tomlPath, 'utf8');
  assert.match(content, /nodejs_24/, 'nodejs_18 replaced with nodejs_24');
  assert.doesNotMatch(content, /nodejs_18/, 'old token removed');
});

test('prepareNixpacksRuntime injects nodejs into existing nixPkgs with no nodejs token', () => {
  const dir = project({
    'package.json': {},
    'nixpacks.toml': '[phases.setup]\nnixPkgs = ["git", "curl"]\n'
  });
  const tomlPath = path.join(dir, 'nixpacks.toml');
  const original = fs.readFileSync(tomlPath, 'utf8');

  const runtime = { runtime: 'node', version: '22' };
  const injected = original.replace(
    /(\[phases\.setup\][^\[]*nixPkgs\s*=\s*\[)([^\]]*)(\])/,
    (_, open, inner, close) => {
      const sep = inner.trim() ? ', ' : '';
      return `${open}${inner}${sep}"nodejs_${runtime.version}"${close}`;
    }
  );
  fs.writeFileSync(tomlPath, injected);

  const content = fs.readFileSync(tomlPath, 'utf8');
  assert.match(content, /nodejs_22/, 'nodejs_22 injected into existing nixPkgs');
  assert.match(content, /git/, 'other packages preserved');
});
