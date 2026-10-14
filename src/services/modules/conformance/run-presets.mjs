#!/usr/bin/env node
// End-to-end conformance run. NEEDS NETWORK (npm install) and, for data modules, real services.
// For every preset it renders the project, installs it, runs its own tests, boots it in
// production mode and probes it like a client would. Run it in CI and before publishing
// catalog changes; the engine's own tests (npm test) cover everything that can be checked offline.
//
//   CONFORMANCE_DATABASE_URL=postgres://... CONFORMANCE_REDIS_URL=redis://... \
//   CONFORMANCE_MONGODB_URL=mongodb://... node conformance/run-presets.mjs [preset ...]
//
// Cases that need a service you did not provide are skipped, not failed.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { getCatalog } from '../lib/catalog.js';
import { buildFromCompose } from '../lib/compose.js';

const SERVICES = { postgres: process.env.CONFORMANCE_DATABASE_URL, redis: process.env.CONFORMANCE_REDIS_URL, mongodb: process.env.CONFORMANCE_MONGODB_URL };
const catalog = await getCatalog();
const wanted = process.argv.slice(2);
const cases = Object.keys(catalog.meta.presets).filter((p) => !wanted.length || wanted.includes(p)).map((preset) => ({ name: preset, compose: { name: `conf-${preset}`, preset } }));
cases.push({ name: 'providers', compose: { name: 'conf-providers', preset: 'api-minimal', modules: ['email-resend', 'llm-anthropic', 'payments-stripe', 'payments-paystack', 'storage-s3', 'sms-twilio', 'metrics'] } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? 'pass' : 'FAIL'}  ${what}`); if (!ok) failures++; };

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).status < 500) return true; } catch { /* not up yet */ } await sleep(250); }
  return false;
}

for (const c of cases) {
  const result = buildFromCompose(catalog, c.compose);
  const missing = result.addons.filter((a) => !SERVICES[a.kind]);
  console.log(`\n== ${c.name} (${result.files.length} files)`);
  if (missing.length) { console.log(`  skip  needs ${missing.map((a) => a.kind).join(', ')}`); continue; }

  const dir = await mkdtemp(path.join(tmpdir(), 'conformance-'));
  try {
    for (const f of result.files) { await mkdir(path.dirname(path.join(dir, f.path)), { recursive: true }); await writeFile(path.join(dir, f.path), f.content); }
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe' });
    try { execFileSync('npm', ['test'], { cwd: dir, stdio: 'pipe' }); check(true, "project's own tests"); }
    catch (err) { check(false, `project's own tests\n${String(err.stdout)}`); continue; }

    const manifest = JSON.parse(result.files.find((f) => f.path === '.morline/modules.json').content);
    const has = (id) => id in manifest.modules;
    const env = { ...process.env, NODE_ENV: 'production', PORT: '38123', LOG_LEVEL: 'silent', JWT_SECRET: 'j'.repeat(48) };
    for (const id of Object.keys(manifest.modules)) for (const v of catalog.modules.get(id).env) if (v.required && !v.provisioned && !env[v.key]) env[v.key] = v.key.includes('URL') ? 'smtp://u:p@localhost:2525' : 'test-value';
    env.DATABASE_URL = SERVICES.postgres; env.REDIS_URL = SERVICES.redis; env.MONGODB_URL = SERVICES.mongodb;

    const server = spawn(process.execPath, ['src/server.js'], { cwd: dir, env, stdio: 'ignore' });
    const exited = once(server, 'exit');
    const base = 'http://127.0.0.1:38123';
    if (!(await waitFor(`${base}/health`))) { check(false, 'server boots in production mode'); server.kill(); continue; }
    check(true, 'server boots in production mode');

    const health = await fetch(`${base}/health`);
    check(health.status === 200 && (await health.json()).status === 'ok', 'GET /health');
    check((await fetch(`${base}/ready`)).status === 200, 'GET /ready');
    const id = 'conformance-123';
    check((await fetch(`${base}/health`, { headers: { 'x-request-id': id } })).headers.get('x-request-id') === id, 'request id is echoed');
    const missingRoute = await fetch(`${base}/definitely-missing`);
    check(has('auth-jwt') ? missingRoute.status === 401 : missingRoute.status === 404 && (await missingRoute.json()).code === 'not_found', 'unknown routes follow the standard shape');
    if (has('security-headers')) check((await fetch(`${base}/health`)).headers.get('x-content-type-options') === 'nosniff', 'security headers');
    if (has('cors')) check((await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin') === null, 'CORS denies unlisted origins');
    if (has('rate-limit')) {
      let limited = null;
      for (let i = 0; i < manifest.modules['rate-limit'].options.max + 5 && !limited; i++) { const r = await fetch(`${base}/`); if (r.status === 429) limited = r; }
      check(Boolean(limited?.headers.get('retry-after')), 'rate limit returns 429 with Retry-After');
    }
    if (has('auth-password')) {
      const bad = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nope', password: 'x' }) });
      check(bad.status === 400 && (await bad.json()).code === 'validation_error', 'registration validates input');
      check((await fetch(`${base}/auth/me`)).status === 401, 'GET /auth/me needs a token');
    }
    server.kill('SIGTERM');
    const [code] = await Promise.race([exited, sleep(10000).then(() => [null])]);
    check(code === 0, 'graceful shutdown on SIGTERM');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
