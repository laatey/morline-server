import crypto from 'node:crypto';
import { execute, queryOne } from '../db/index.js';

/**
 * Morline's starter templates are the folders of https://github.com/laatey/morline-templates.
 * Each folder is a self-contained project with its own Dockerfile, so a template service is
 * just a GitHub service pointed at that repository with the folder as its root directory.
 * This table records what each folder needs on top of that: its listening port, where its
 * data lives, and the variables it expects.
 */
export const TEMPLATES_REPO = 'laatey/morline-templates';

const secret = () => crypto.randomBytes(18).toString('base64url');
const hex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
// [key, value, isSecret]
const v = (key, value, isSecret = false) => [key, value, isSecret];

export const TEMPLATE_CATALOG = {
  postgres: {
    folder: 'postgresql', port: 5432, database: 'postgres',
    volumes: [['data', '/var/lib/postgresql/data']],
    vars: () => [v('POSTGRES_USER', 'postgres'), v('POSTGRES_PASSWORD', secret(), true), v('POSTGRES_DB', 'app'),
      v('PGDATA', '/var/lib/postgresql/data/pgdata')]
  },
  mysql: {
    folder: 'mysql', port: 3306, database: 'mysql',
    volumes: [['data', '/var/lib/mysql']],
    vars: () => [v('MYSQL_ROOT_PASSWORD', secret(), true), v('MYSQL_DATABASE', 'app'), v('MYSQL_USER', 'app_user'),
      v('MYSQL_PASSWORD', secret(), true)]
  },
  mongodb: {
    folder: 'mongodb', port: 27017, database: 'mongodb',
    volumes: [['data', '/data/db']],
    vars: () => [v('MONGO_INITDB_ROOT_USERNAME', 'admin'), v('MONGO_INITDB_ROOT_PASSWORD', secret(), true),
      v('MONGO_INITDB_DATABASE', 'app')]
  },
  redis: {
    folder: 'redis-cache', port: 6379, database: 'redis',
    volumes: [['data', '/data']],
    vars: () => [v('REDIS_PASSWORD', secret(), true), v('REDIS_MAXMEMORY', '256mb'), v('REDIS_MAXMEMORY_POLICY', 'allkeys-lru')]
  },
  sqlite: { // PocketBase
    folder: 'pocketbase-sqlite', port: 8090, database: 'pocketbase',
    volumes: [['data', '/pb/pb_data']],
    vars: () => [v('PB_ADMIN_EMAIL', 'admin@morline.local'), v('PB_ADMIN_PASSWORD', secret(), true)]
  },
  js: { folder: 'nodejs-express', port: 3000, vars: () => [v('CORS_ORIGINS', '*')] },
  nextjs: { folder: 'nextjs-app-router', port: 3000, vars: () => [v('NEXT_PUBLIC_APP_NAME', 'My App')] },
  vite: { folder: 'vite-react-spa', port: 4173, vars: () => [v('VITE_APP_NAME', 'My App')] },
  python: { folder: 'python-fastapi', port: 8000, vars: () => [v('CORS_ORIGINS', '*')] },
  go: { folder: 'go-fiber', port: 8080, vars: () => [] },
  rust: { folder: 'rust-axum', port: 8080, vars: () => [] },
  strapi: {
    folder: 'strapi-cms', port: 1337,
    volumes: [['uploads', '/app/public/uploads'], ['db', '/app/.tmp']],
    vars: () => [v('HOST', '0.0.0.0'),
      v('APP_KEYS', Array.from({ length: 4 }, () => hex(16)).join(','), true),
      v('API_TOKEN_SALT', hex(), true), v('ADMIN_JWT_SECRET', hex(), true), v('TRANSFER_TOKEN_SALT', hex(), true),
      v('JWT_SECRET', hex(), true), v('ENCRYPTION_KEY', hex(), true)]
  },
  n8n: {
    folder: 'n8n-automation', port: 5678,
    volumes: [['data', '/home/node/.n8n']],
    vars: () => [v('N8N_BASIC_AUTH_ACTIVE', 'true'), v('N8N_BASIC_AUTH_USER', 'admin'),
      v('N8N_BASIC_AUTH_PASSWORD', secret(), true), v('N8N_ENCRYPTION_KEY', hex(), true), v('GENERIC_TIMEZONE', 'UTC')]
  },
  metabase: {
    folder: 'metabase-analytics', port: 3000,
    volumes: [['data', '/metabase-data']],
    vars: () => []
  }
};

export const hasTemplate = (templateId) => Boolean(templateId && TEMPLATE_CATALOG[templateId]);

/**
 * Points a freshly inserted template service at its folder in the templates repository and gives
 * it the port, volumes and variables that folder expects. Call inside the creation transaction,
 * after the services, service_settings and service_networking rows exist. Variables the caller
 * already supplied are kept.
 */
export function provisionTemplate(serviceId, templateId, now = new Date().toISOString()) {
  const entry = TEMPLATE_CATALOG[templateId];
  if (!entry) return null;

  execute(`UPDATE services SET source_type = 'github', source_repo = ?, source_url = ?, source_branch = NULL,
    source_root_dir = ?, port = NULL WHERE id = ?`,
    TEMPLATES_REPO, `https://github.com/${TEMPLATES_REPO}`, entry.folder, serviceId);

  // auto_deploy off: a push to the shared templates repo must never redeploy someone's database.
  execute(`UPDATE service_settings SET root_directory = ?, branch = NULL, start_command = NULL, auto_deploy = 0
    WHERE service_id = ?`, entry.folder, serviceId);
  execute('UPDATE service_networking SET target_port = ? WHERE service_id = ?', entry.port, serviceId);

  for (const [name, mountPath] of entry.volumes || []) {
    execute('INSERT INTO volumes (id, service_id, name, mount_path, created_at) VALUES (?, ?, ?, ?, ?)',
      `vol_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, serviceId, name, mountPath, now);
  }

  for (const [key, value, isSecret] of entry.vars()) {
    if (queryOne("SELECT 1 AS found FROM variables WHERE scope_type = 'service' AND scope_id = ? AND key = ?", serviceId, key)) continue;
    execute(`INSERT INTO variables (id, scope_type, scope_id, key, value, secret, created_at, updated_at)
      VALUES (?, 'service', ?, ?, ?, ?, ?, ?)`,
    `var_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, serviceId, key, value, isSecret ? 1 : 0, now, now);
  }
  return entry;
}
