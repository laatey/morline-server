// Static checks on a generated file set. They run without installing anything, so they can
// gate every proposal cheaply: syntax is checked elsewhere (node --check in tests/CI), these
// catch the wiring mistakes that only show up at runtime: an import nobody declared, an env
// var nobody documented, a plugin imported but never registered.

import { builtinModules } from 'node:module';

const BUILTINS = new Set(builtinModules);
// Built-ins that can only be imported with the node: prefix.
const PREFIX_ONLY = new Set(['test', 'test/reporters', 'sea', 'sqlite']);
const SOURCE = /^(src|test)\/.*\.js$/;
const SECRET = /(sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{30,})/;

const importsOf = (text) => [
  ...[...text.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
];

const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

function resolveRelative(from, spec, files) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const target = parts.join('/');
  return [target, `${target}.js`, `${target}/index.js`].find((p) => files.has(p));
}

/** @param {Map<string,string> | {path:string,content:string}[]} input */
export function runChecks(input) {
  const files = input instanceof Map ? input : new Map(input.map((f) => [f.path, f.content]));
  const errors = [];
  const warnings = [];

  let pkg;
  try { pkg = JSON.parse(files.get('package.json') ?? ''); } catch { errors.push('package.json is missing or not valid JSON'); }
  const deps = new Set(Object.keys(pkg?.dependencies ?? {}));
  if (pkg && !pkg.scripts?.start) errors.push('package.json has no "start" script');
  if (!files.has('Dockerfile')) errors.push('There is no Dockerfile');

  const envExample = files.get('.env.example') ?? '';
  const documented = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const ALWAYS = new Set(['NODE_ENV', 'PORT']);

  for (const [path, text] of files) {
    if (SECRET.test(text)) errors.push(`${path} looks like it contains a real secret`);
    if (/\{\{\s*[\w.]+(\|json)?\s*\}\}/.test(text) && SOURCE.test(path)) errors.push(`${path} still contains an unreplaced template marker`);
    if (!SOURCE.test(path)) continue;

    for (const spec of importsOf(text)) {
      if (spec.startsWith('node:')) { if (!BUILTINS.has(spec.slice(5)) && !PREFIX_ONLY.has(spec.slice(5))) errors.push(`${path} imports unknown built-in ${spec}`); continue; }
      if (spec.startsWith('.')) { if (!resolveRelative(path, spec, files)) errors.push(`${path} imports ${spec}, which does not exist`); continue; }
      if (BUILTINS.has(spec)) continue;
      if (!deps.has(packageName(spec))) errors.push(`${path} imports "${packageName(spec)}" but it is not in package.json dependencies`);
    }

    if (path !== 'src/lib/env.js') {
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        if (path.startsWith('src/')) warnings.push(`${path} reads process.env.${m[1]} directly; use env from src/lib/env.js`);
        else if (!ALWAYS.has(m[1]) && !documented.has(m[1])) { /* tests may set variables freely */ }
      }
      if (path.startsWith('src/')) {
        for (const m of text.matchAll(/env\.(?:required|optional|int|bool)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
          if (!documented.has(m[1]) && !ALWAYS.has(m[1])) errors.push(`${path} reads ${m[1]} but .env.example does not document it`);
        }
      }
    }
  }

  const app = files.get('src/app.js');
  if (app) {
    for (const m of app.matchAll(/^import (\w+) from '\.\/plugins\/[\w.-]+\.js';$/gm)) {
      if (!new RegExp(`register\\(${m[1]}\\b`).test(app)) errors.push(`src/app.js imports ${m[1]} but never registers it`);
    }
    for (const m of app.matchAll(/register\((\w+)\b/g)) {
      if (!new RegExp(`^import ${m[1]} from `, 'm').test(app)) errors.push(`src/app.js registers ${m[1]} but does not import it`);
    }
  } else {
    errors.push('src/app.js is missing');
  }
  if (!/\/health/.test([...files].filter(([p]) => p.startsWith('src/')).map(([, t]) => t).join('\n'))) errors.push('No /health route found');

  return { errors, warnings };
}
