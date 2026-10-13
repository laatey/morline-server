import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

process.env.JWT_SECRET ??= 'test-secret-not-for-production';
const { initDb, execute, queryOne } = await import('../src/db/index.js');
const { DATA_DIR, APPS_DIR } = await import('../src/config.js');
const { destroyService, destroyProject, sweepOrphans } = await import('../src/services/service-cleanup.js');
const { logManager } = await import('../src/engine/log-manager.js');

initDb();
const t = Date.now();
const now = new Date().toISOString();
const base = `cl_${t}`;
const team = `team_${base}`;
execute(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, 'U', 'x', ?, ?)`, `usr_${base}`, `${base}@c.test`, now, now);
execute(`INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'T', ?, ?, ?)`, team, base, now, now);

function fixture(tag) {
  const ids = { project: `prj_${tag}`, env: `env_${tag}`, service: `srv_${tag}`, deployment: `dep_${tag}`, domain: `dom_${tag}`, backup: `bak_${tag}` };
  execute(`INSERT INTO projects (id, team_id, name, description, created_at, updated_at) VALUES (?, ?, 'P', '', ?, ?)`, ids.project, team, now, now);
  execute(`INSERT INTO environments (id, project_id, name, type, created_at, updated_at) VALUES (?, ?, 'production', 'production', ?, ?)`, ids.env, ids.project, now, now);
  execute(`INSERT INTO services (id, environment_id, name, kind, status, source_type, created_at, updated_at) VALUES (?, ?, 'svc', 'app', 'running', 'github', ?, ?)`, ids.service, ids.env, now, now);
  execute(`INSERT INTO service_networking (service_id, public, target_port) VALUES (?, 1, 3000)`, ids.service);
  execute(`INSERT INTO deployments (id, service_id, service_name, environment_id, state, created_at) VALUES (?, ?, 'svc', ?, 'active', ?)`, ids.deployment, ids.service, ids.env, now);
  execute(`INSERT INTO domains (id, environment_id, service_id, service_name, host, kind, status, created_at) VALUES (?, ?, ?, 'svc', ?, 'provided', 'active', ?)`, ids.domain, ids.env, ids.service, `${tag}.example.test`, now);
  execute(`INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at) VALUES (?, 'service', ?, 'SECRET', 'x', 1, ?, ?)`, `var_s_${tag}`, ids.service, now, now);
  execute(`INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at) VALUES (?, 'environment', ?, 'ENVVAR', 'x', 0, ?, ?)`, `var_e_${tag}`, ids.env, now, now);
  execute(`INSERT INTO service_udp_ports (service_id, container_port, public_port) VALUES (?, 1812, ?)`, ids.service, 40000 + (t % 20000));
  logManager.appendLog({ deploymentId: ids.deployment, serviceId: ids.service, serviceName: 'svc', environmentId: ids.env, level: 'error', message: 'boom' });
  const dirs = ['apps', 'service-volumes', 'backups'].map((d) => path.join(DATA_DIR, d, ids.service));
  for (const d of dirs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'file.txt'), 'data'); }
  return { ids, dirs };
}
const gone = (sql, ...p) => assert.equal(queryOne(sql, ...p), undefined);

test('deleting a service removes its domains, variables, ports, logs and files', async () => {
  const { ids, dirs } = fixture(`a${t}`);
  const out = await destroyService(ids.service);
  assert.equal(out.domains, 1);
  gone('SELECT 1 AS x FROM services WHERE id = ?', ids.service);
  gone('SELECT 1 AS x FROM domains WHERE id = ?', ids.domain);
  gone("SELECT 1 AS x FROM variables WHERE scope_type = 'service' AND scope_id = ?", ids.service);
  gone('SELECT 1 AS x FROM service_udp_ports WHERE service_id = ?', ids.service);
  gone('SELECT 1 AS x FROM deployment_logs WHERE service_id = ?', ids.service);
  for (const d of dirs) assert.equal(fs.existsSync(d), false, d);
  assert.equal(queryOne("SELECT 1 AS x FROM variables WHERE id = ?", `var_e_a${t}`)?.x, 1, 'environment variables belong to the environment');
});

test('deleting a project tears down its services, domains and environment variables', async () => {
  const { ids, dirs } = fixture(`b${t}`);
  await destroyProject(ids.project);
  execute('DELETE FROM projects WHERE id = ?', ids.project);
  gone('SELECT 1 AS x FROM services WHERE id = ?', ids.service);
  gone('SELECT 1 AS x FROM domains WHERE host = ?', `b${t}.example.test`);
  gone("SELECT 1 AS x FROM variables WHERE scope_type = 'environment' AND scope_id = ?", ids.env);
  for (const d of dirs) assert.equal(fs.existsSync(d), false);
});

test('the startup sweep clears orphans left by older versions and only reports orphan folders', () => {
  const { ids, dirs } = fixture(`c${t}`);
  // What an old delete left behind: the service row gone, everything else still there.
  execute('PRAGMA foreign_keys = OFF');
  execute('DELETE FROM services WHERE id = ?', ids.service);
  execute('PRAGMA foreign_keys = ON');
  execute('UPDATE domains SET service_id = NULL WHERE id = ?', ids.domain);
  const report = sweepOrphans({});
  assert.ok(report.domains >= 1 && report.variables >= 1);
  gone('SELECT 1 AS x FROM domains WHERE id = ?', ids.domain);
  gone("SELECT 1 AS x FROM variables WHERE scope_type = 'service' AND scope_id = ?", ids.service);
  assert.ok(report.folders.includes(`apps/${ids.service}`));
  assert.equal(fs.existsSync(dirs[0]), true, 'folders are kept unless sweeping is switched on');
  sweepOrphans({ MORLINE_SWEEP_ORPHAN_FILES: '1' });
  for (const d of dirs) assert.equal(fs.existsSync(d), false);
});

test('every logManager method the code calls exists', () => {
  const used = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/logManager\.(\w+)\(/g)) used.add(m[1]);
    }
  };
  walk(path.resolve('src'));
  for (const name of used) assert.equal(typeof logManager[name], 'function', `logManager.${name} is called but does not exist`);
  assert.ok(Array.isArray(logManager.getServiceLogs('srv_none', { limit: 5 })));
});
