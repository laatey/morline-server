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

  applyMigrations(db);
  seedCatalog(db);

  dbInstance = db;
  return dbInstance;
}

function applyMigrations(db) {
  // 1. Ensure onboarding_state has rich progress columns
  const onboardingCols = db.prepare('PRAGMA table_info(onboarding_state);').all().map(c => c.name);
  if (!onboardingCols.includes('step')) db.exec('ALTER TABLE onboarding_state ADD COLUMN step INTEGER NOT NULL DEFAULT 0;');
  if (!onboardingCols.includes('completed')) db.exec('ALTER TABLE onboarding_state ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;');
  if (!onboardingCols.includes('workspace_name')) db.exec('ALTER TABLE onboarding_state ADD COLUMN workspace_name TEXT;');
  if (!onboardingCols.includes('selected_template')) db.exec('ALTER TABLE onboarding_state ADD COLUMN selected_template TEXT;');
  if (!onboardingCols.includes('invited_emails')) db.exec('ALTER TABLE onboarding_state ADD COLUMN invited_emails TEXT;');
  if (!onboardingCols.includes('data')) db.exec("ALTER TABLE onboarding_state ADD COLUMN data TEXT NOT NULL DEFAULT '{}';");
  if (!onboardingCols.includes('updated_at')) db.exec('ALTER TABLE onboarding_state ADD COLUMN updated_at TEXT;');

  // 2. Ensure github_integration has installation_id
  const githubCols = db.prepare('PRAGMA table_info(github_integration);').all().map(c => c.name);
  if (!githubCols.includes('installation_id')) {
    db.exec('ALTER TABLE github_integration ADD COLUMN installation_id INTEGER;');
  }
  // Clean up duplicate github_integration rows that were auto-propagated to multiple teams
  try {
    db.exec(`
      DELETE FROM github_integration 
      WHERE installation_id IS NOT NULL 
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM github_integration GROUP BY installation_id
        );
    `);
  } catch (err) {
    console.error('Error cleaning up duplicate github integrations:', err.message);
  }

  // 3. Ensure assistant_threads allows nullable project_id and environment_id
  const threadCols = db.prepare('PRAGMA table_info(assistant_threads);').all();
  const projCol = threadCols.find(c => c.name === 'project_id');
  if (projCol && projCol.notnull === 1) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS assistant_threads_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'New Conversation',
        archived INTEGER NOT NULL DEFAULT 0,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      );
      INSERT INTO assistant_threads_new SELECT id, project_id, environment_id, title, archived, created_by, created_at, last_activity_at FROM assistant_threads;
      DROP TABLE assistant_threads;
      ALTER TABLE assistant_threads_new RENAME TO assistant_threads;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  // 4. Create password_resets table for forgot-password flow
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (token)
    );
  `);

  // 5. staged_changes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS staged_changes (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      service_id TEXT,
      service_name TEXT,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  // 6. variable_suggestion_dismissals table
  db.exec(`
    CREATE TABLE IF NOT EXISTS variable_suggestion_dismissals (
      service_id TEXT NOT NULL,
      key TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      PRIMARY KEY (service_id, key)
    );
  `);

  // 7. source_url on services (anonymous public repo URL)
  const servicesCols = db.prepare('PRAGMA table_info(services);').all().map(c => c.name);
  if (!servicesCols.includes('source_url')) {
    db.exec('ALTER TABLE services ADD COLUMN source_url TEXT;');
  }

  // 8. base_path on service_settings (HTTP base path for reverse proxy)
  const settingsCols = db.prepare('PRAGMA table_info(service_settings);').all().map(c => c.name);
  if (!settingsCols.includes('base_path')) {
    db.exec('ALTER TABLE service_settings ADD COLUMN base_path TEXT;');
  }
}

function clean(params) {
  return params.map(p => (p === undefined ? null : p));
}

export function queryOne(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...clean(params));
}

export function queryAll(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...clean(params));
}

export function execute(sql, ...params) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.run(...clean(params));
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
