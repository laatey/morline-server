import { getDb } from '../src/db/index.js';

const db = getDb();
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN TRANSACTION;');

// 1. Migrate assistant_threads to allow nullable project_id and environment_id
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

// 2. Add columns to onboarding_state
const cols = db.prepare('PRAGMA table_info(onboarding_state);').all().map(c => c.name);
if (!cols.includes('step')) db.exec('ALTER TABLE onboarding_state ADD COLUMN step INTEGER NOT NULL DEFAULT 0;');
if (!cols.includes('completed')) db.exec('ALTER TABLE onboarding_state ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;');
if (!cols.includes('workspace_name')) db.exec('ALTER TABLE onboarding_state ADD COLUMN workspace_name TEXT;');
if (!cols.includes('selected_template')) db.exec('ALTER TABLE onboarding_state ADD COLUMN selected_template TEXT;');
if (!cols.includes('invited_emails')) db.exec('ALTER TABLE onboarding_state ADD COLUMN invited_emails TEXT;');
if (!cols.includes('data')) db.exec("ALTER TABLE onboarding_state ADD COLUMN data TEXT DEFAULT '{}';");
if (!cols.includes('updated_at')) db.exec('ALTER TABLE onboarding_state ADD COLUMN updated_at TEXT;');

db.exec('COMMIT;');
db.exec('PRAGMA foreign_keys = ON;');
console.log('Migration successfully completed!');
