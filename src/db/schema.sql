-- Morline Database Schema for SQLite

PRAGMA foreign_keys = ON;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  avatar_url TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- User Preferences / Settings
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'system',
  default_team_id TEXT,
  canvas_snap_to_grid INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  email_notifications INTEGER NOT NULL DEFAULT 1
);

-- User Onboarding
CREATE TABLE IF NOT EXISTS onboarding_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  step INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  workspace_name TEXT,
  selected_template TEXT,
  invited_emails TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  team_created INTEGER NOT NULL DEFAULT 0,
  github_connected INTEGER NOT NULL DEFAULT 0,
  first_project_created INTEGER NOT NULL DEFAULT 0,
  first_deploy_succeeded INTEGER NOT NULL DEFAULT 0,
  dismissed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  user_agent TEXT,
  ip TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'hobby',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Team Members
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

-- Team Invites
CREATE TABLE IF NOT EXISTS team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT UNIQUE NOT NULL,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  default_environment_id TEXT,
  settings_pr_environments INTEGER NOT NULL DEFAULT 1,
  settings_spend_limit_usd REAL,
  settings_default_region TEXT NOT NULL DEFAULT 'us-east-1',
  settings_base_environment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- User Favorite Projects
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);

-- Environments
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'development',
  protected INTEGER NOT NULL DEFAULT 0,
  pull_request INTEGER,
  forked_from_environment_id TEXT,
  canvas_revision INTEGER NOT NULL DEFAULT 1,
  viewport_x REAL DEFAULT 0,
  viewport_y REAL DEFAULT 0,
  viewport_zoom REAL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Services
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'app',
  logo TEXT NOT NULL DEFAULT 'js',
  status TEXT NOT NULL DEFAULT 'created', -- 'created' (never deployed), 'deploying', 'online', 'crashed', 'sleeping', 'stopped'
  framework TEXT, -- from build detection, e.g. 'nextjs', 'django'
  runtime TEXT, -- from build detection, e.g. 'node', 'python', 'go'
  replicas_before_stop INTEGER,
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'template',
  source_repo TEXT,
  source_branch TEXT,
  source_root_dir TEXT,
  source_url TEXT,
  source_image TEXT,
  source_template_id TEXT,
  source_display TEXT,
  region TEXT NOT NULL DEFAULT 'us-east-1',
  replicas INTEGER NOT NULL DEFAULT 1,
  port INTEGER,
  primary_domain TEXT,
  cron_schedule TEXT,
  active_deployment_id TEXT,
  building_deployment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Service Settings
CREATE TABLE IF NOT EXISTS service_settings (
  service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  branch TEXT,
  root_directory TEXT,
  base_path TEXT,
  auto_deploy INTEGER NOT NULL DEFAULT 1,
  build_command TEXT,
  start_command TEXT,
  runtime_version TEXT,
  dockerfile_path TEXT,
  healthcheck_path TEXT DEFAULT '/',
  healthcheck_timeout_sec INTEGER DEFAULT 30,
  restart_policy TEXT DEFAULT 'on-failure',
  replicas INTEGER DEFAULT 1,
  cron_schedule TEXT,
  sleep_after_minutes INTEGER,
  cpu_limit REAL,
  memory_limit_mb INTEGER
);

-- Service Networking
CREATE TABLE IF NOT EXISTS service_networking (
  service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  public INTEGER NOT NULL DEFAULT 1,
  target_port INTEGER DEFAULT 3000,
  private_hostname TEXT,
  private_port INTEGER
);

-- Service Connections
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  from_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  to_service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL DEFAULT 'http',
  port INTEGER,
  label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(from_service_id, to_service_id)
);

-- Service Volumes
CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  size_gb REAL NOT NULL DEFAULT 1.0,
  used_gb REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL
);

-- Variables (both service and environment level)
CREATE TABLE IF NOT EXISTS variables (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL, -- 'service' or 'environment'
  scope_id TEXT NOT NULL,   -- service_id or environment_id
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  is_reference INTEGER NOT NULL DEFAULT 0,
  resolved_preview TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope_type, scope_id, key)
);

-- Domains
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT,
  host TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'provided', -- 'provided' or 'custom'
  status TEXT NOT NULL DEFAULT 'active', -- 'pending', 'verifying', 'active', 'failed'
  target_port INTEGER,
  tls_configured INTEGER NOT NULL DEFAULT 1,
  dns_records TEXT, -- JSON array of records
  verification_token TEXT, -- custom domains: value of the _morline-challenge TXT record
  verified_at TEXT, -- when ownership was proven
  tls_expires_at TEXT, -- expiry of the certificate actually being served
  last_checked_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Deployments
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued', -- 'queued', 'building', 'deploying', 'active', 'failed', 'crashed', 'cancelled', 'removed'
  trigger TEXT NOT NULL DEFAULT 'manual', -- 'push', 'manual', 'rollback', 'config_change', 'assistant', 'template'
  commit_sha TEXT,
  commit_message TEXT,
  commit_author TEXT,
  commit_branch TEXT,
  image TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  rollback_of_deployment_id TEXT,
  rollbackable INTEGER NOT NULL DEFAULT 1,
  snapshot TEXT, -- JSON: { variables, config, source } as used at deploy time
  error_summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_sec INTEGER,
  url TEXT,
  created_at TEXT NOT NULL
);

-- Deployment Phases
CREATE TABLE IF NOT EXISTS deployment_phases (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- 'initialize', 'build', 'deploy', 'healthcheck', 'release'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'succeeded', 'failed', 'skipped'
  started_at TEXT,
  finished_at TEXT
);

-- Deployment Logs
CREATE TABLE IF NOT EXISTS deployment_logs (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  replica INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'info', -- 'debug', 'info', 'warn', 'error'
  message TEXT NOT NULL,
  attributes TEXT, -- JSON
  phase TEXT, -- 'build' | 'deploy'
  timestamp TEXT NOT NULL
);

-- Database backups (files live under DATA_DIR/backups/<service_id>/)
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'scheduled' | 'pre-restore'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
  size INTEGER, -- bytes
  file TEXT,
  error TEXT,
  restore_status TEXT, -- NULL, 'running', 'completed', 'failed'
  restored_at TEXT,
  restore_error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_backups_service ON backups(service_id, created_at);

-- AI crash analysis, one per deployment
CREATE TABLE IF NOT EXISTS deployment_diagnoses (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
  summary TEXT,
  root_cause TEXT,
  suggested_fix TEXT,
  can_auto_fix INTEGER NOT NULL DEFAULT 0,
  fix_title TEXT,
  fix_files TEXT, -- JSON [{ path, diff, content, baseHash }]; content/baseHash never leave the server
  pr_url TEXT,
  pr_number INTEGER,
  dismissed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project_id TEXT,
  target_url TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Activity Log
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT,
  service_id TEXT,
  type TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT NOT NULL DEFAULT 'user', -- 'user', 'system', 'api_key'
  actor_name TEXT,
  actor_avatar_url TEXT,
  summary TEXT NOT NULL,
  target_url TEXT,
  created_at TEXT NOT NULL
);

-- Assistant Threads
CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Conversation',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

-- Assistant Messages
CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'user', 'assistant', 'system'
  status TEXT NOT NULL DEFAULT 'done', -- 'pending', 'streaming', 'done', 'error'
  content TEXT NOT NULL,
  context TEXT, -- JSON
  tool_calls TEXT, -- JSON
  citations TEXT, -- JSON
  actions TEXT, -- JSON
  error TEXT, -- JSON
  feedback TEXT,
  author TEXT, -- JSON
  created_at TEXT NOT NULL
);

-- Assistant Actions
CREATE TABLE IF NOT EXISTS assistant_actions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'applying', 'applied', 'failed', 'dismissed', 'reverted'
  title TEXT NOT NULL,
  description TEXT,
  risk TEXT NOT NULL DEFAULT 'low', -- 'low', 'medium', 'high'
  reversible INTEGER NOT NULL DEFAULT 1,
  targets TEXT, -- JSON
  payload TEXT, -- JSON
  diff TEXT, -- JSON
  result TEXT, -- JSON
  applied_by TEXT, -- JSON
  applied_at TEXT,
  created_at TEXT NOT NULL
);

-- GitHub Integration
CREATE TABLE IF NOT EXISTS github_integration (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  install_url TEXT NOT NULL,
  access_token TEXT,
  installation_id INTEGER,
  connected INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT NOT NULL
);

-- Templates Catalog
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo TEXT NOT NULL,
  kind TEXT NOT NULL,
  "group" TEXT NOT NULL,
  hint TEXT,
  inputs TEXT -- JSON
);

-- Regions Catalog
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_services_env ON services(environment_id);
CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service_id);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment_id);
CREATE INDEX IF NOT EXISTS idx_logs_deploy ON deployment_logs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_logs_env ON deployment_logs(environment_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON deployment_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_variables_scope ON variables(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_connections_env ON connections(environment_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages(thread_id);

-- Metered usage, one row per service per month. Filled once a minute by engine/usage-meter.js.
CREATE TABLE IF NOT EXISTS usage_monthly (
  service_id TEXT NOT NULL,
  month TEXT NOT NULL, -- 'YYYY-MM' (UTC)
  cpu_seconds REAL NOT NULL DEFAULT 0, -- vCPU-seconds actually used
  memory_gb_seconds REAL NOT NULL DEFAULT 0, -- GB-seconds actually used
  volume_gb_seconds REAL NOT NULL DEFAULT 0, -- GB-seconds of stored volume data
  egress_bytes INTEGER NOT NULL DEFAULT 0, -- bytes sent to visitors
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, month)
);

-- One private Docker network per environment, so "<service>.morline.internal" only ever resolves
-- to a container in the same environment.
CREATE TABLE IF NOT EXISTS private_networks (
  environment_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  idx INTEGER NOT NULL UNIQUE, -- which /26 of the pool this network uses
  subnet TEXT NOT NULL,
  created_at TEXT NOT NULL
);
