import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');

// Railway Persistent Volume support: default to /data if directory exists on Linux
const defaultDataDir = (process.platform !== 'win32' && fs.existsSync('/data'))
  ? '/data'
  : path.join(ROOT_DIR, 'data');
export const DATA_DIR = process.env.DATA_DIR || defaultDataDir;
export const APPS_DIR = path.join(DATA_DIR, 'apps');
export const DB_PATH = path.join(DATA_DIR, 'morline.db');

export const PORT = parseInt(process.env.PORT || '3001', 10);
export const HOST = process.env.HOST || '0.0.0.0';
export const BASE_DOMAIN = process.env.BASE_DOMAIN || 'morline.space';

// Auto-detect public URL from Railway environment variables or BASE_DOMAIN
export const PUBLIC_URL = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null) ||
  (BASE_DOMAIN && BASE_DOMAIN !== 'localhost' ? `https://api.${BASE_DOMAIN}` : `http://localhost:${PORT}`);

// Cloudflare Tunnel Token (optional, for token-based cloudflared tunnel execution on Railway)
export const CLOUDFLARE_TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.TUNNEL_TOKEN || null;

export const JWT_SECRET = process.env.JWT_SECRET || 'morline-super-secret-production-jwt-key-2026';
export const JWT_EXPIRES_IN = '7d';
export const REFRESH_EXPIRES_DAYS = 30;

export const SERVICE_PORT_MIN = parseInt(process.env.SERVICE_PORT_MIN || '4100', 10);
export const SERVICE_PORT_MAX = parseInt(process.env.SERVICE_PORT_MAX || '4999', 10);

export const LOG_RETENTION_LINES = 10000;

// GitHub OAuth & App Configuration
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || null;
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || null;
export const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME || 'morline';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

// AI Assistant LLM Provider Configuration
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;


