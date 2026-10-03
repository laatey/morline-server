import fs from 'node:fs';
import path from 'node:path';

// Versions registered here are used for constraint evaluation only.
// Each entry represents the actual Node version that the build platform ships
// for that major. Keep these accurate: an overly-optimistic version causes the
// resolver to select a major whose platform binary does not satisfy the
// constraint at runtime.
//
// Nixpacks v1.41 ships:
//   nodejs_18 → 18.20.x  nodejs_20 → 20.19.x
//   nodejs_22 → 22.12.x  nodejs_24 → 24.0.x
const SUPPORTED_NODE = [
  { major: 18, version: [18, 20, 0] },
  { major: 20, version: [20, 19, 0] },
  // v1.41 nixpkgs provides Node 22.12, which satisfies modern Vite's >=22.12.0
  { major: 22, version: [22, 12, 0] },
  { major: 24, version: [24, 0, 0] }
];

const read = (cwd, name) => { try { return fs.readFileSync(path.join(cwd, name), 'utf8').trim(); } catch { return null; } };
const json = (cwd, name) => { try { return JSON.parse(read(cwd, name)); } catch { return null; } };
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};
const parseVersion = (value) => {
  const m = String(value || '').trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/);
  return m ? [Number(m[1]), Number(m[2]) || 0, Number(m[3]) || 0] : null;
};

function satisfiesComparator(version, token) {
  const value = token.trim();
  if (!value || value === '*' || /^latest$/i.test(value)) return true;
  const match = value.match(/^(>=|<=|>|<|=|~|\^)?\s*v?(\d+(?:\.(?:\d+|x|X|\*))?(?:\.(?:\d+|x|X|\*))?)/);
  if (!match) return true;
  const op = match[1] || '';
  const raw = match[2];
  const target = parseVersion(raw);
  if (!target) return true;
  const cmp = compare(version, target);
  if (op === '>=') return cmp >= 0;
  if (op === '>') return cmp > 0;
  if (op === '<=') return cmp <= 0;
  if (op === '<') return cmp < 0;
  if (op === '^') return version[0] === target[0] && cmp >= 0;
  if (op === '~') return version[0] === target[0] && version[1] === target[1] && cmp >= 0;
  if (/[xX*]/.test(raw)) {
    const parts = raw.split('.');
    return version[0] === target[0] && (parts.length < 2 || /[xX*]/.test(parts[1]) || version[1] === target[1]);
  }
  return cmp === 0 || (raw.split('.').length === 1 && version[0] === target[0]);
}

export function satisfiesNodeRange(version, range) {
  return String(range || '*').replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').split('||').some((alternative) =>
    alternative.trim().split(/\s+/).filter(Boolean).every((token) => satisfiesComparator(version, token))
  );
}

function nodeRequirementsFromLockfile(cwd) {
  const lock = json(cwd, 'package-lock.json');
  const pkg = json(cwd, 'package.json') || {};
  // Only direct dependencies declared in package.json influence runtime selection.
  // Transitive dependencies are excluded: they are already constrained by their
  // own direct consumers. Using transitives causes an explosion of constraints
  // that are impossible to satisfy simultaneously.
  const direct = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {})
  ]);
  if (!lock?.packages || !direct.size) return [];
  return Object.entries(lock.packages)
    // name.slice strips the leading 'node_modules/' prefix
    .filter(([name, meta]) => {
      const pkgName = name.slice('node_modules/'.length);
      // Only include direct deps that declare an engines.node constraint.
      // Do NOT mistake package version, peer dependency version, or any other
      // field for a Node engine requirement.
      return direct.has(pkgName) && typeof meta?.engines?.node === 'string';
    })
    .map(([name, meta]) => ({
      source: `dependency ${name.slice('node_modules/'.length)}`,
      range: meta.engines.node
    }));
}

// Parse a nixpacks.toml or nixpacks.json to extract a declared Node major.
// The file may declare the node package as 'nodejs_22', 'nodejs_22_x',
// 'nodejs-22', etc. We extract only the leading major number.
function nodeVersionFromNixpacksConfig(cwd) {
  // Try TOML form first (most common)
  const toml = read(cwd, 'nixpacks.toml');
  if (toml) {
    // Match nodejs_XX or nodejs_XX_x in nixPkgs assignments
    const m = toml.match(/nodejs[_-](\d+)/);
    if (m) return m[1];
  }
  // Try JSON form
  const njson = json(cwd, 'nixpacks.json');
  if (njson) {
    const setup = njson?.phases?.setup;
    const pkgs = (setup?.nixPkgs || setup?.nixPackages || []).concat(setup?.pkgs || []);
    for (const pkg of pkgs) {
      const m = String(pkg).match(/nodejs[_-](\d+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function nodeRequirements(cwd) {
  const pkg = json(cwd, 'package.json') || {};
  const requirements = [];

  if (pkg.engines?.node) requirements.push({ source: 'package.json engines.node', range: pkg.engines.node, explicit: true });

  for (const file of ['.nvmrc', '.node-version']) {
    const value = read(cwd, file);
    if (value) requirements.push({ source: file, range: value, explicit: true });
  }

  // nixpacks.toml/nixpacks.json: treat as an explicit major declaration.
  const nixpacksMajor = nodeVersionFromNixpacksConfig(cwd);
  if (nixpacksMajor) {
    requirements.push({ source: 'nixpacks.toml', range: `${nixpacksMajor}.x`, explicit: true });
  }

  return [...requirements, ...nodeRequirementsFromLockfile(cwd)];
}

function resolveNode(cwd, override) {
  const requirements = nodeRequirements(cwd);
  if (override) requirements.unshift({ source: 'Morline runtime setting', range: override, explicit: true });
  const candidates = SUPPORTED_NODE.filter((candidate) =>
    requirements.every((req) => satisfiesNodeRange(candidate.version, req.range))
  );
  if (!candidates.length) {
    const requested = requirements.map((req) => `${req.source}: ${req.range}`).join('; ') || 'no version declaration';
    throw new Error(`No supported Node runtime satisfies ${requested}. Morline supports Node ${SUPPORTED_NODE.map((v) => v.major).join(', ')}.`);
  }
  const chosen = candidates.at(-1);
  return {
    runtime: 'node',
    version: String(chosen.major),
    source: requirements.length ? requirements.map((r) => r.source).join(', ') : 'Morline default',
    requirements
  };
}

function projectRuntime(cwd) {
  if (fs.existsSync(path.join(cwd, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(cwd, 'composer.json'))) return 'php';
  if (fs.existsSync(path.join(cwd, 'Gemfile'))) return 'ruby';
  return null;
}

export function resolveRuntime(cwd, { override = '' } = {}) {
  const runtime = projectRuntime(cwd);
  if (runtime === 'node') return resolveNode(cwd, override);
  const files = { python: ['.python-version', 'runtime.txt'], go: ['go.mod'], rust: ['rust-toolchain.toml'], php: ['composer.json'], ruby: ['.ruby-version', 'Gemfile'] };
  const source = (files[runtime] || []).find((file) => read(cwd, file));
  return runtime ? { runtime, version: null, source: source || 'Nixpacks default', requirements: [] } : null;
}
