import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execute, queryOne, queryAll } from '../db/index.js';
import { DATA_DIR } from '../config.js';
import { containerSupervisor, containerName } from './container-supervisor.js';
import zlib from 'node:zlib';
import { AppError, conflict, notFound } from '../middleware/error-handler.js';

/**
 * Everything database-specific lives here: listing tables/collections/keys, reading rows,
 * connection strings and backups. Commands run inside the database's own container with
 * `docker exec`, using the variables that container already has, so no password is ever put
 * on the Morline host's command line.
 */

const BY_TEMPLATE = { postgres: 'postgres', mysql: 'mysql', mongodb: 'mongodb', redis: 'redis', sqlite: 'pocketbase' };
// Services that were not created from a template are recognised by the variables they define.
const BY_VARIABLE = [
  ['POSTGRES_PASSWORD', 'postgres'], ['MYSQL_ROOT_PASSWORD', 'mysql'], ['MONGO_INITDB_ROOT_PASSWORD', 'mongodb'],
  ['REDIS_PASSWORD', 'redis'], ['PB_ADMIN_PASSWORD', 'pocketbase']
];
const DEFAULT_PORT = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379, pocketbase: 8090 };
const BACKUP_EXT = { postgres: 'sql.gz', mysql: 'sql.gz', mongodb: 'archive.gz', redis: 'rdb', pocketbase: 'tar.gz' };
const RESTORABLE = new Set(['postgres', 'mysql', 'mongodb']);
const KEEP_BACKUPS = 20;
const MAX_OUTPUT = 16 * 1024 * 1024;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// ------------------------------------------------------------------ lookup

export function describeDatabase(service) {
  const vars = containerSupervisor.variables(service.environment_id, service.id);
  let type = BY_TEMPLATE[service.source_template_id] || null;
  if (!type) type = BY_VARIABLE.find(([key]) => vars[key])?.[1] || null;
  if (!type) return null;
  const networking = queryOne('SELECT target_port FROM service_networking WHERE service_id = ?', service.id) || {};
  const port = Number(networking.target_port) && Number(networking.target_port) !== 3000
    ? Number(networking.target_port) : DEFAULT_PORT[type];
  return { type, vars, port, container: containerName(service.id), host: containerName(service.id) };
}

function requireDatabase(service) {
  const db = describeDatabase(service);
  if (!db) throw conflict('This service is not a recognised database', 'not_a_database');
  return db;
}

async function requireRunning(db) {
  const state = await run('docker', ['inspect', '-f', '{{.State.Running}}', db.container]).catch(() => null);
  if (!state || state.stdout.trim() !== 'true') {
    throw conflict('The database is not running. Deploy or restart it first.', 'database_not_running');
  }
}

// ------------------------------------------------------------------ process helpers

function run(command, args, { input = null, timeoutMs = 30_000, env = null, sink = null, maxBytes = MAX_OUTPUT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new AppError('The database command timed out', 504, 'database_timeout')); }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (sink) return;
      if (bytes > maxBytes) { child.kill('SIGKILL'); finish(reject, new AppError('The result was too large to return', 413, 'result_too_large')); return; }
      stdout += chunk;
    });
    if (sink) child.stdout.pipe(sink);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr, bytes }));

    child.stdin.on('error', () => { /* the process exited before reading all input */ });
    if (input && typeof input.pipe === 'function') input.pipe(child.stdin);
    else child.stdin.end(input ?? undefined);
  });
}

/** Runs a shell script inside the database container. `js` is passed as $MORLINE_JS (never holds secrets). */
async function exec(db, script, { input = null, js = null, timeoutMs, sink = null } = {}) {
  const args = ['exec', '-i', ...(js ? ['-e', `MORLINE_JS=${js}`] : []), db.container, 'sh', '-c', script];
  const result = await run('docker', args, { input, timeoutMs, sink });
  return result;
}

async function query(db, script, opts) {
  const result = await exec(db, script, opts);
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n').filter(Boolean).pop() || `exit code ${result.code}`;
    throw new AppError(`The database rejected the request: ${reason}`, 502, 'database_error');
  }
  return result.stdout;
}

function parseJson(text, fallback) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed === 'NULL' || trimmed === 'null') return fallback;
  try { return JSON.parse(trimmed); } catch { throw new AppError('The database returned an unreadable result', 502, 'database_error'); }
}

const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const clamp = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// ------------------------------------------------------------------ per-engine: collections

const PSQL = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';
const MYSQL = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -N -B -r -u root -D "$MYSQL_DATABASE"';
const MONGOSH = 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin "${MONGO_INITDB_DATABASE:-test}" --eval "$MORLINE_JS"';
const REDIS = 'redis-cli -3 --json --no-auth-warning ${REDIS_PASSWORD:+-a "$REDIS_PASSWORD"}';

async function postgresCollections(db) {
  const out = await query(db, PSQL, { input: `
    SELECT coalesce(jsonb_agg(t ORDER BY t.name), '[]'::jsonb) FROM (
      SELECT c.relname AS name,
        CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS type,
        CASE WHEN c.relkind IN ('r', 'p') THEN
          CASE WHEN c.reltuples > 100000 THEN c.reltuples::bigint
               ELSE (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
          END
        END AS count,
        pg_total_relation_size(c.oid) AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    ) t;` });
  return parseJson(out, []);
}

async function mysqlCollections(db) {
  const out = await query(db, MYSQL, { input: `
    SELECT JSON_ARRAYAGG(JSON_OBJECT('name', table_name, 'type', IF(table_type = 'VIEW', 'view', 'table'),
      'count', table_rows, 'size', data_length + index_length))
    FROM information_schema.tables WHERE table_schema = DATABASE();` });
  return parseJson(out, []);
}

async function mongoCollections(db) {
  const js = `
    const list = db.getCollectionInfos().map((c) => {
      let count = null, size = null;
      try { count = db.getCollection(c.name).estimatedDocumentCount(); size = db.getCollection(c.name).stats().size; } catch (e) {}
      return { name: c.name, type: c.type === 'collection' ? 'collection' : c.type, count, size };
    }).sort((a, b) => a.name.localeCompare(b.name));
    print(EJSON.stringify(list));`;
  return parseJson(await query(db, MONGOSH, { js }), []);
}

const redisQuote = (key) => `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const REDIS_LENGTH = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' };

async function redisCollections(db) {
  const scanned = await query(db, `redis-cli --no-auth-warning \${REDIS_PASSWORD:+-a "$REDIS_PASSWORD"} --scan | head -n 200`);
  // eslint-disable-next-line no-control-regex
  const keys = scanned.split('\n').filter((k) => k && !/[\x00-\x1f]/.test(k));
  if (!keys.length) return [];
  const types = parseJsonLines(await query(db, REDIS, { input: keys.map((k) => `TYPE ${redisQuote(k)}`).join('\n') }));
  const commands = keys.flatMap((k, i) => [`${REDIS_LENGTH[types[i]] || 'EXISTS'} ${redisQuote(k)}`, `MEMORY USAGE ${redisQuote(k)}`]);
  const stats = parseJsonLines(await query(db, REDIS, { input: commands.join('\n') }));
  return keys.map((name, i) => ({ name, type: types[i] || 'unknown', count: num(stats[i * 2]), size: num(stats[i * 2 + 1]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseJsonLines(text) {
  return String(text).split('\n').filter((l) => l.trim() !== '').map((l) => { try { return JSON.parse(l); } catch { return l; } });
}

// PocketBase is reached over HTTP with its admin account.
async function pocketbaseToken(db) {
  const base = `http://${db.host}:${db.port}`;
  const body = JSON.stringify({ identity: db.vars.PB_ADMIN_EMAIL, password: db.vars.PB_ADMIN_PASSWORD });
  for (const route of ['/api/collections/_superusers/auth-with-password', '/api/admins/auth-with-password']) {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (res?.ok) return (await res.json()).token;
  }
  throw new AppError('Could not sign in to PocketBase with PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD', 502, 'database_error');
}

async function pocketbaseGet(db, token, route) {
  const res = await fetch(`http://${db.host}:${db.port}${route}`, { headers: { Authorization: token }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new AppError(`PocketBase returned ${res.status}`, 502, 'database_error');
  return res.json();
}

async function pocketbaseCollections(db) {
  const token = await pocketbaseToken(db);
  const { items = [] } = await pocketbaseGet(db, token, '/api/collections?perPage=200&sort=name');
  return Promise.all(items.filter((c) => !c.system).map(async (c) => {
    const page = await pocketbaseGet(db, token, `/api/collections/${encodeURIComponent(c.name)}/records?perPage=1`).catch(() => null);
    return { name: c.name, type: c.type, count: page?.totalItems ?? null, size: null };
  }));
}

// ------------------------------------------------------------------ public: collections and rows

export async function listCollections(service) {
  const db = requireDatabase(service);
  await requireRunning(db);
  const list = await ({
    postgres: postgresCollections, mysql: mysqlCollections, mongodb: mongoCollections,
    redis: redisCollections, pocketbase: pocketbaseCollections
  })[db.type](db);
  return list.map((c) => ({ name: c.name, count: num(c.count), type: c.type || null, size: num(c.size) }));
}

export async function readRows(service, name, { limit, offset } = {}) {
  const db = requireDatabase(service);
  await requireRunning(db);
  const take = clamp(limit, 1, 500, 50);
  const skip = clamp(offset, 0, 10_000_000, 0);

  // The name is only ever used if it is one of the database's own collections.
  const known = (await listCollections(service)).find((c) => c.name === name);
  if (!known) throw notFound(`"${name}" was not found in this database`, 'collection_not_found');

  if (db.type === 'postgres') {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const out = await query(db, PSQL, { input: `SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM public.${quoted} LIMIT ${take} OFFSET ${skip}) t;` });
    return parseJson(out, []);
  }

  if (db.type === 'mysql') {
    const columns = (await query(db, MYSQL, { input: `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${name.replace(/'/g, "''")}' ORDER BY ordinal_position;` }))
      .split('\n').filter(Boolean);
    if (!columns.length) return [];
    const pairs = columns.map((c) => `'${c.replace(/'/g, "''")}', \`${c.replace(/`/g, '``')}\``).join(', ');
    const out = await query(db, MYSQL, { input: `SELECT JSON_OBJECT(${pairs}) FROM \`${name.replace(/`/g, '``')}\` LIMIT ${take} OFFSET ${skip};` });
    return out.split('\n').filter(Boolean).map((line) => parseJson(line, null)).filter(Boolean);
  }

  if (db.type === 'mongodb') {
    const js = `print(EJSON.stringify(db.getCollection(${JSON.stringify(name)}).find({}).skip(${skip}).limit(${take}).toArray(), { relaxed: true }));`;
    return parseJson(await query(db, MONGOSH, { js }), []);
  }

  if (db.type === 'redis') return redisRows(db, name, known.type, take, skip);

  const token = await pocketbaseToken(db);
  const page = Math.floor(skip / take) + 1;
  const result = await pocketbaseGet(db, token, `/api/collections/${encodeURIComponent(name)}/records?perPage=${take}&page=${page}`);
  return result.items || [];
}

async function redisRows(db, key, type, take, skip) {
  const k = redisQuote(key);
  const command = {
    string: `GET ${k}`,
    hash: `HGETALL ${k}`,
    list: `LRANGE ${k} ${skip} ${skip + take - 1}`,
    set: `SMEMBERS ${k}`,
    zset: `ZRANGE ${k} ${skip} ${skip + take - 1} WITHSCORES`,
    stream: `XRANGE ${k} - + COUNT ${take}`
  }[type];
  if (!command) return [{ value: `(${type} values cannot be shown)` }];
  const [reply] = parseJsonLines(await query(db, REDIS, { input: command }));
  switch (type) {
    case 'string': return [{ value: reply }];
    case 'hash': return Object.entries(reply || {}).slice(skip, skip + take).map(([field, value]) => ({ field, value }));
    case 'list': return (reply || []).map((value, i) => ({ index: skip + i, value }));
    case 'set': return (reply || []).slice(skip, skip + take).map((member) => ({ member }));
    case 'zset': return (reply || []).map(([member, score]) => ({ member, score }));
    default: return (reply || []).map(([id, fields]) => ({ id, fields }));
  }
}

// ------------------------------------------------------------------ public: connection

export function connectionInfo(service) {
  const db = describeDatabase(service);
  if (!db) return { host: null, port: null, user: null, password: null, database: null, url: null, publicUrl: null };
  const { vars, host, port } = db;
  const enc = encodeURIComponent;
  let user = null; let password = null; let database = null; let url = null;

  if (db.type === 'postgres') {
    user = vars.POSTGRES_USER || 'postgres'; password = vars.POSTGRES_PASSWORD || ''; database = vars.POSTGRES_DB || user;
    url = `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${enc(database)}`;
  } else if (db.type === 'mysql') {
    user = vars.MYSQL_USER || 'root';
    password = (vars.MYSQL_USER ? vars.MYSQL_PASSWORD : vars.MYSQL_ROOT_PASSWORD) || '';
    database = vars.MYSQL_DATABASE || null;
    url = `mysql://${enc(user)}:${enc(password)}@${host}:${port}${database ? `/${enc(database)}` : ''}`;
  } else if (db.type === 'mongodb') {
    user = vars.MONGO_INITDB_ROOT_USERNAME || 'admin'; password = vars.MONGO_INITDB_ROOT_PASSWORD || '';
    database = vars.MONGO_INITDB_DATABASE || null;
    url = `mongodb://${enc(user)}:${enc(password)}@${host}:${port}/${database ? enc(database) : ''}?authSource=admin`;
  } else if (db.type === 'redis') {
    user = 'default'; password = vars.REDIS_PASSWORD || '';
    url = `redis://${password ? `:${enc(password)}@` : ''}${host}:${port}`;
  } else {
    user = vars.PB_ADMIN_EMAIL || null; password = vars.PB_ADMIN_PASSWORD || null;
    url = `http://${host}:${port}`;
  }
  // Morline has no public TCP proxy yet, so databases are only reachable over the private network.
  return { host, port, user, password, database, url, publicUrl: null };
}

// ------------------------------------------------------------------ backups

const busy = new Set();
const mapBackup = (row) => ({
  id: row.id,
  createdAt: row.created_at,
  size: row.size ?? null,
  status: row.status,
  kind: row.kind,
  ...(row.error ? { error: row.error } : {}),
  restore: row.restore_status ? { status: row.restore_status, at: row.restored_at, ...(row.restore_error ? { error: row.restore_error } : {}) } : null
});

export function listBackups(service) {
  return queryAll('SELECT * FROM backups WHERE service_id = ? ORDER BY created_at DESC', service.id).map(mapBackup);
}

const PG_AUTH = 'PGPASSWORD="$POSTGRES_PASSWORD" ${TOOL} -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"';

// SQL dumps are gzipped on the Morline side (the dump's own exit code then decides success).
const COMPRESSED_ON_HOST = new Set(['postgres', 'mysql']);

function dumpScript(type) {
  return {
    postgres: `${PG_AUTH.replace('${TOOL}', 'pg_dump')} --clean --if-exists --no-owner`,
    mysql: 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -u root --single-transaction --routines --triggers --databases "$MYSQL_DATABASE"',
    mongodb: 'mongodump --archive --gzip -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin',
    redis: 'f=$(mktemp) && redis-cli --no-auth-warning ${REDIS_PASSWORD:+-a "$REDIS_PASSWORD"} --rdb "$f" >&2 && cat "$f"; s=$?; rm -f "$f"; exit $s',
    pocketbase: 'tar czf - -C /pb pb_data'
  }[type];
}

function restoreScript(type) {
  return {
    postgres: `${PG_AUTH.replace('${TOOL}', 'psql -X -q')} -o /dev/null`,
    mysql: 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root',
    mongodb: 'mongorestore --archive --gzip --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
  }[type];
}

function lock(serviceId) {
  if (busy.has(serviceId)) throw conflict('A backup or restore is already running for this database', 'backup_in_progress');
  busy.add(serviceId);
}

async function runBackup(db, row) {
  const file = path.join(BACKUP_DIR, row.service_id, `${row.id}.${BACKUP_EXT[db.type]}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execute("UPDATE backups SET status = 'running', file = ? WHERE id = ?", file, row.id);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  const closed = new Promise((resolve) => out.on('close', resolve));
  const sink = COMPRESSED_ON_HOST.has(db.type) ? zlib.createGzip() : out;
  if (sink !== out) sink.pipe(out);
  try {
    const result = await exec(db, dumpScript(db.type), { sink, timeoutMs: 30 * 60_000 });
    await closed;
    if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || `exit code ${result.code}`);
    if (!fs.statSync(file).size) throw new Error('The backup was empty');
    execute("UPDATE backups SET status = 'completed', size = ?, finished_at = ? WHERE id = ?", fs.statSync(file).size, new Date().toISOString(), row.id);
    pruneBackups(row.service_id);
  } catch (err) {
    sink.destroy();
    out.destroy();
    fs.rmSync(file, { force: true });
    execute("UPDATE backups SET status = 'failed', error = ?, file = NULL, finished_at = ? WHERE id = ?", String(err.message).slice(0, 500), new Date().toISOString(), row.id);
    throw err;
  }
}

function pruneBackups(serviceId) {
  const old = queryAll("SELECT id, file FROM backups WHERE service_id = ? AND status = 'completed' ORDER BY created_at DESC", serviceId).slice(KEEP_BACKUPS);
  for (const b of old) {
    if (b.file) fs.rmSync(b.file, { force: true });
    execute('DELETE FROM backups WHERE id = ?', b.id);
  }
}

function newBackupRow(serviceId, kind) {
  const id = `bkp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  execute("INSERT INTO backups (id, service_id, kind, status, created_at) VALUES (?, ?, ?, 'pending', ?)", id, serviceId, kind, new Date().toISOString());
  return queryOne('SELECT * FROM backups WHERE id = ?', id);
}

export async function startBackup(service, kind = 'manual') {
  const db = requireDatabase(service);
  await requireRunning(db);
  lock(service.id);
  let row;
  try { row = newBackupRow(service.id, kind); } catch (err) { busy.delete(service.id); throw err; }
  runBackup(db, row)
    .catch((err) => console.error(`[Backup] ${service.id} failed: ${err.message}`))
    .finally(() => busy.delete(service.id));
  return mapBackup(row);
}

export async function startRestore(service, backupId) {
  const db = requireDatabase(service);
  const backup = queryOne('SELECT * FROM backups WHERE id = ? AND service_id = ?', backupId, service.id);
  if (!backup) throw notFound('Backup not found', 'backup_not_found');
  if (backup.status !== 'completed' || !backup.file || !fs.existsSync(backup.file)) {
    throw conflict('This backup is not available to restore', 'backup_unavailable');
  }
  if (!RESTORABLE.has(db.type)) {
    throw conflict(`Restoring ${db.type === 'redis' ? 'Redis' : 'PocketBase'} backups is not supported yet. The backup file is kept and can be restored manually.`, 'restore_unsupported');
  }
  await requireRunning(db);
  lock(service.id);
  execute("UPDATE backups SET restore_status = 'running', restore_error = NULL WHERE id = ?", backupId);

  (async () => {
    try {
      // Safety net: snapshot the current data first, and stop if that fails.
      await runBackup(db, newBackupRow(service.id, 'pre-restore'));
      const source = fs.createReadStream(backup.file);
      source.on('error', () => { /* surfaced by the restore command failing */ });
      const input = COMPRESSED_ON_HOST.has(db.type) ? source.pipe(zlib.createGunzip()).on('error', () => {}) : source;
      const result = await exec(db, restoreScript(db.type), { input, timeoutMs: 30 * 60_000 });
      if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || `exit code ${result.code}`);
      execute("UPDATE backups SET restore_status = 'completed', restored_at = ? WHERE id = ?", new Date().toISOString(), backupId);
    } catch (err) {
      execute("UPDATE backups SET restore_status = 'failed', restore_error = ?, restored_at = ? WHERE id = ?", String(err.message).slice(0, 500), new Date().toISOString(), backupId);
      console.error(`[Restore] ${service.id} failed: ${err.message}`);
    } finally {
      busy.delete(service.id);
    }
  })();

  return { status: 'running', backupId };
}

/** Backups and restores cannot survive a server restart; mark them failed instead of leaving them "running". */
export function recoverBackups() {
  const at = new Date().toISOString();
  execute("UPDATE backups SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ? WHERE status IN ('pending', 'running')", at);
  execute("UPDATE backups SET restore_status = 'failed', restore_error = 'Interrupted by a server restart', restored_at = ? WHERE restore_status = 'running'", at);
}
