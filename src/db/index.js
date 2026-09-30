import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR, APPS_DIR } from '../config.js';
import { seedCatalog } from './seed.js';

let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    initDb();
  }
  return dbInstance;
}

export function initDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(APPS_DIR)) {
    fs.mkdirSync(APPS_DIR, { recursive: true });
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const schemaPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);

  seedCatalog(db);

  dbInstance = db;
  return dbInstance;
}

export function queryOne(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

export function queryAll(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

export function execute(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

export function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN TRANSACTION;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}
