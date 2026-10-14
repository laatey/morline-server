import fp from 'fastify-plugin';
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { env } from '../lib/env.js';

const migrationsDir = new URL('../../migrations/', import.meta.url);
const LOCK_ID = 727274;

// Applies every migrations/*.sql file that has not run yet, in name order, one transaction each.
// The advisory lock keeps two instances starting at once from running the same migration twice.
async function migrate(pool, log) {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((row) => row.name));

    let files = [];
    try {
      files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, migrationsDir), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      log.info({ migration: file }, 'applied migration');
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

export default fp(async function postgres(app) {
  const pool = new pg.Pool({ connectionString: env.required('DATABASE_URL'), max: env.int('PG_POOL_MAX', 10) });
  pool.on('error', (err) => app.log.error({ err }, 'postgres pool error'));
  await migrate(pool, app.log);

  app.decorate('pg', pool);
  app.readinessChecks.push(async () => { await pool.query('select 1'); });
  app.addHook('onClose', async () => { await pool.end(); });
}, { name: 'postgres' });
