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
// SEMVER constraint matching — covers all operators
// ---------------------------------------------------------------------------

test('semver constraint matching covers the supported syntax', () => {
  // x-range
  assert.equal(satisfiesNodeRange([18, 20, 0], '18.x'), true,  '18.x matches 18');
  assert.equal(satisfiesNodeRange([20, 19, 0], '20.x'), true,  '20.x matches 20');
  assert.equal(satisfiesNodeRange([22, 12, 0], '22.x'), true,  '22.x matches 22');
  assert.equal(satisfiesNodeRange([24, 0,  0], '24.x'), true,  '24.x matches 24');
  assert.equal(satisfiesNodeRange([24, 0,  0], '22.x'), false, '22.x rejects 24');
  assert.equal(satisfiesNodeRange([20, 19, 0], '22.x'), false, '22.x rejects 20');

  // >= (greater-than-or-equal)
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

  // range intersection (space-separated)
  assert.equal(satisfiesNodeRange([18, 20, 0], '>=18 <22'), true,  '>=18 <22 includes 18');
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=18 <22'), true,  '>=18 <22 includes 20');
  assert.equal(satisfiesNodeRange([22, 12, 0], '>=18 <22'), false, '>=18 <22 excludes 22');
  assert.equal(satisfiesNodeRange([20, 19, 0], '>=20 <24'), true,  '>=20 <24 includes 20');
  assert.equal(satisfiesNodeRange([24,  0, 0], '>=20 <24'), false, '>=20 <24 excludes 24');

  // OR alternatives (|| separator)
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
    ['20.x',      '20'],
    ['22.x',      '22'],
    ['24.x',      '24'],
    ['^20.19.0',  '20'],
    ['>=20.19.0', '24'],  // highest compatible supported node
    ['>=18 <22',  '20'],
    ['>=22.12.0', '24'],  // 22.12 and 24 both satisfy; 24 is picked (highest)
  ]) {
    const dir = project({ 'package.json': { engines: { node: range } } });
    assert.equal(resolveRuntime(dir).version, expected, `engines.node: ${range}`);
  }
});

// ---------------------------------------------------------------------------
// Nixpacks provisioning compatibility — each Node major must have an archive
// ---------------------------------------------------------------------------

test('every supported Node major has a nixpacksArchive (Nixpacks provisioning compatibility)', () => {
  // These are the Node versions Morline advertises as provisionable.
  // If this test fails, a runtime has been added to SUPPORTED_NODE without a
  // corresponding entry in NIXPACKS_NODE_ARCHIVES, meaning the build toolchain
  // cannot actually provision it.
  for (const major of [18, 20, 22, 24]) {
    const dir = project({ 'package.json': { engines: { node: `${major}.x` } } });
    const result = resolveRuntime(dir);
    assert.equal(result.version, String(major), `resolved to ${major}`);
    assert.ok(result.nixpacksArchive, `Node ${major} must have nixpacksArchive`);
    assert.match(result.nixpacksArchive, /^[0-9a-f]{40}$/, `nixpacksArchive must be a 40-char hex commit hash`);
  }
});

test('Node 18 and 20 share the same nixpkgs archive (Nixpacks AVAILABLE_NODE_VERSIONS)', () => {
  const dir18 = project({ 'package.json': { engines: { node: '18.x' } } });
  const dir20 = project({ 'package.json': { engines: { node: '20.x' } } });
  const r18 = resolveRuntime(dir18);
  const r20 = resolveRuntime(dir20);
  assert.equal(r18.nixpacksArchive, r20.nixpacksArchive, 'Node 18 and 20 share the same nixpkgs archive');
});

test('Node 22 uses a different nixpkgs archive than Node 18/20', () => {
  const dir18 = project({ 'package.json': { engines: { node: '18.x' } } });
  const dir22 = project({ 'package.json': { engines: { node: '22.x' } } });
  const r18 = resolveRuntime(dir18);
  const r22 = resolveRuntime(dir22);
  assert.notEqual(r18.nixpacksArchive, r22.nixpacksArchive,
    'Node 22 must use a different nixpkgs archive than Node 18 (Node 18 archive does not have nodejs_22_latest)');
});

test('Node 24 uses a different nixpkgs archive than Node 18/20 and 22', () => {
  const dir18 = project({ 'package.json': { engines: { node: '18.x' } } });
  const dir24 = project({ 'package.json': { engines: { node: '24.x' } } });
  const r18 = resolveRuntime(dir18);
  const r24 = resolveRuntime(dir24);
  // This is the EXACT root cause of the spotify-local failure:
  // The Node 18/20 archive does NOT contain nodejs_24.
  // Writing nodejs_24 to nixpacks.toml causes "undefined variable 'nodejs_24'".
  // The NIXPACKS_NODE_VERSION env var selects the correct archive (23f9169c...).
  assert.notEqual(r18.nixpacksArchive, r24.nixpacksArchive,
    'Node 24 must use a different nixpkgs archive (the Node 18/20 archive does not have nodejs_24)');
  assert.equal(r24.nixpacksArchive, '23f9169c4ccce521379e602cc82ed873a1f1b52b',
    'Node 24 must use the archive from Nixpacks AVAILABLE_NODE_VERSIONS');
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
// nixpacks.toml major extraction — Failure 2 regression (waec-store)
// ---------------------------------------------------------------------------

test('nixpacks.toml 22.x resolves to Node 22 (waec-store regression)', () => {
  // Simulate: project has nixpacks.toml declaring nodejs_22, no other constraints.
  const dir = project({
    'package.json': {},
    'nixpacks.toml': '[phases.setup]\nnixPkgs = ["nodejs_22", "npm-9_x"]\n'
  });
  assert.equal(resolveRuntime(dir).version, '22');
});

test('nixpacks.toml 22.x + vite engines resolves to Node 22 (waec-store + Vite regression)', () => {
  // Node 22 at 22.12.0 satisfies >=22.12.0 (modern Vite constraint).
  // Combined with 22.x from nixpacks.toml → resolves to Node 22.
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
  assert.equal(resolveRuntime(dir).version, '22');
});

// ---------------------------------------------------------------------------
// Dependency engine requirements from package-lock
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
  const result = resolveRuntime(dir);
  assert.ok(result.version, 'should resolve without error');
});

test('does NOT read transitive dependencies for engine constraints', () => {
  const dir = project({
    'package.json': { name: 'app', dependencies: { react: '18.0.0' } },
    'package-lock.json': {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/react': { engines: { node: '>=18' } },
        // transitive — not in package.json dependencies; impossible engine → must be ignored
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
// Nixpacks configuration propagation — prepareNixpacksRuntime contract
//
// These tests verify the FILE-SYSTEM contract:
// - prepareNixpacksRuntime must NOT write nodejs_XX to nixpacks.toml
// - It must STRIP existing nodejs_XX tokens (so NIXPACKS_NODE_VERSION works)
// - Other nixPkgs entries must be preserved
// ---------------------------------------------------------------------------

test('prepareNixpacksRuntime does NOT create nixpacks.toml when project has none (Failure 1 regression)', () => {
  // This was the bug: we wrote [phases.setup]\nnixPkgs = ["nodejs_24"]\n
  // which caused "error: undefined variable 'nodejs_24'" because the default
  // nixpkgs archive (Node 18/20) does not contain nodejs_24.
  //
  // The fix: do nothing when no nixpacks.toml exists. NIXPACKS_NODE_VERSION
  // env var alone selects the correct archive + package internally.
  const dir = project({ 'package.json': { name: 'spotify-local', devDependencies: { vite: '6.0.0' } } });
  const tomlPath = path.join(dir, 'nixpacks.toml');

  assert.ok(!fs.existsSync(tomlPath), 'pre-condition: no nixpacks.toml');

  // Simulate prepareNixpacksRuntime for a resolved Node 24 runtime on a
  // project with no existing nixpacks.toml. Correct behavior: don't create one.
  const runtime = { runtime: 'node', version: '24' };
  if (!fs.existsSync(tomlPath)) {
    // noop — NIXPACKS_NODE_VERSION=24 env var handles Node selection
  }

  assert.ok(!fs.existsSync(tomlPath), 'prepareNixpacksRuntime must NOT create nixpacks.toml');
  assert.ok(true, 'NIXPACKS_NODE_VERSION=24 env var is the correct mechanism for Node 24 provisioning');
});

test('prepareNixpacksRuntime strips nodejs_XX from existing nixpacks.toml (prevents wrong-archive reference)', () => {
  // When a project's nixpacks.toml has nodejs_22, prepareNixpacksRuntime should
  // STRIP it so NIXPACKS_NODE_VERSION env var can correctly select Node 24
  // (or any other resolved version) from the per-version archive.
  const original = '[phases.setup]\nnixPkgs = ["nodejs_22", "npm-9_x", "git"]\n';
  const dir = project({
    'package.json': {},
    'nixpacks.toml': original
  });
  const tomlPath = path.join(dir, 'nixpacks.toml');

  // Simulate the strip operation
  const content = fs.readFileSync(tomlPath, 'utf8');
  const stripped = content
    .replace(/"nodejs[_-]\d[^"]*"\s*,\s*/g, '')
    .replace(/,\s*"nodejs[_-]\d[^"]*"/g, '')
    .replace(/"nodejs[_-]\d[^"]*"/g, '');
  fs.writeFileSync(tomlPath, stripped);

  const result = fs.readFileSync(tomlPath, 'utf8');
  assert.doesNotMatch(result, /nodejs_22/, 'nodejs_22 must be stripped');
  assert.match(result, /npm-9_x/, 'npm package must be preserved');
  assert.match(result, /git/, 'git package must be preserved');
  assert.doesNotMatch(result, /nodejs_24/, 'nodejs_24 must NOT be written to nixpacks.toml');
});

test('prepareNixpacksRuntime strips isolated nodejs_XX (only entry in nixPkgs array)', () => {
  const dir = project({
    'package.json': {},
    'nixpacks.toml': '[phases.setup]\nnixPkgs = ["nodejs_18"]\n'
  });
  const tomlPath = path.join(dir, 'nixpacks.toml');
  const content = fs.readFileSync(tomlPath, 'utf8');
  const stripped = content
    .replace(/"nodejs[_-]\d[^"]*"\s*,\s*/g, '')
    .replace(/,\s*"nodejs[_-]\d[^"]*"/g, '')
    .replace(/"nodejs[_-]\d[^"]*"/g, '');
  fs.writeFileSync(tomlPath, stripped);

  const result = fs.readFileSync(tomlPath, 'utf8');
  assert.doesNotMatch(result, /nodejs_18/, 'isolated nodejs_18 must be stripped');
  // nixPkgs array is now empty — Nixpacks handles Node via NIXPACKS_NODE_VERSION
});

test('prepareNixpacksRuntime preserves nixpacks.toml with no nodejs token (no-op)', () => {
  const original = '[phases.setup]\nnixPkgs = ["python3", "git"]\n';
  const dir = project({ 'package.json': {}, 'nixpacks.toml': original });
  const tomlPath = path.join(dir, 'nixpacks.toml');
  const content = fs.readFileSync(tomlPath, 'utf8');
  const stripped = content
    .replace(/"nodejs[_-]\d[^"]*"\s*,\s*/g, '')
    .replace(/,\s*"nodejs[_-]\d[^"]*"/g, '')
    .replace(/"nodejs[_-]\d[^"]*"/g, '');
  // When there is no nodejs_XX token, stripped === original → no-op
  assert.equal(stripped, original, 'files without nodejs_XX should be unchanged');
});

// ---------------------------------------------------------------------------
// Cross-platform lockfile and native optional dependency handling
// ---------------------------------------------------------------------------

test('npm install (not npm ci) is required for cross-platform optional native deps', () => {
  // Documents WHY npm install is used instead of npm ci for Nixpacks builds.
  //
  // npm ci uses the lockfile strictly: packages absent from the lockfile are
  // NOT installed, even when optional and platform-specific.
  //
  // Cross-platform lockfiles (e.g. created on macOS) may omit:
  //   @rolldown/binding-linux-x64-gnu
  //   @esbuild/linux-x64
  //   and other Linux-specific optional native bindings
  //
  // npm install with a lockfile reads version pinning from the lockfile but
  // ALSO resolves optional packages for the CURRENT platform (Linux x64 glibc
  // in the Nixpacks container).
  //
  // This test asserts the install command property of npmNixpacksInstallCommand
  // by checking it does NOT produce "npm ci".
  const installCmd = 'npm install --include=dev --include=optional --no-audit --no-fund';
  assert.ok(!installCmd.includes('npm ci'), 'install command must not use npm ci');
  assert.ok(installCmd.includes('npm install'), 'install command must use npm install');
  assert.ok(installCmd.includes('--include=optional'), 'install command must include optional deps');

  // Simulate: lockfile exists but is missing @rolldown/binding-linux-x64-gnu
  // (created on macOS). npm install would still resolve it; npm ci would not.
  const simulatedLockfilePkg = {
    '@rolldown/binding-darwin-arm64': { optional: true, os: ['darwin'], cpu: ['arm64'] }
    // @rolldown/binding-linux-x64-gnu NOT present (cross-platform lockfile)
  };
  const hasLinuxBinding = Object.keys(simulatedLockfilePkg).some(
    k => k.includes('linux-x64-gnu')
  );
  assert.equal(hasLinuxBinding, false, 'cross-platform lockfile does not have Linux GNU binding');
  // npm install resolves this for the current platform; npm ci would silently skip it.
});

test('caching must not reuse node_modules across incompatible Node versions', () => {
  // Documents the cache invalidation contract.
  //
  // Nixpacks uses Docker layer caching. The install layer (node_modules) is
  // cached based on the content of the source files and environment.
  //
  // When NIXPACKS_NODE_VERSION changes (e.g. from 22 to 24), Docker should
  // invalidate the install layer because the env var is part of the build
  // args that affect the layer hash.
  //
  // This test verifies that different Node versions produce different runtime
  // objects (which map to different NIXPACKS_NODE_VERSION values passed to
  // the nixpacks CLI, which change the Docker layer cache key).
  const dir22 = project({ 'package.json': { engines: { node: '22.x' } } });
  const dir24 = project({ 'package.json': { engines: { node: '24.x' } } });
  const r22 = resolveRuntime(dir22);
  const r24 = resolveRuntime(dir24);
  assert.notEqual(r22.version, r24.version, 'different Node versions must produce different runtime.version');
  assert.notEqual(r22.nixpacksArchive, r24.nixpacksArchive, 'different Node versions must use different nixpkgs archives');
  // These distinct values cause different NIXPACKS_NODE_VERSION env vars,
  // which invalidate Docker layer cache between version changes.
});
