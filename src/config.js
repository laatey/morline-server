import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');

// Default to /data when it exists on Linux (the production container mounts the host data dir there)
const defaultDataDir = (process.platform !== 'win32' && fs.existsSync('/data'))
  ? '/data'
  : path.join(ROOT_DIR, 'data');
export const DATA_DIR = process.env.DATA_DIR || defaultDataDir;
export const APPS_DIR = path.join(DATA_DIR, 'apps');
export const DB_PATH = path.join(DATA_DIR, 'morline.db');

export const PORT = parseInt(process.env.PORT || '3001', 10);
export const HOST = process.env.HOST || '0.0.0.0';
export const BASE_DOMAIN = process.env.BASE_DOMAIN || 'morline.space';

// Public URL: explicit PUBLIC_URL, else a Railway-provided domain (legacy), else api.<BASE_DOMAIN>
export const PUBLIC_URL = process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  (process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null) ||
  (BASE_DOMAIN && BASE_DOMAIN !== 'localhost' ? `https://api.${BASE_DOMAIN}` : `http://localhost:${PORT}`);

// Frontend URL (where the Lovable/React app lives)
export const FRONTEND_URL = process.env.FRONTEND_URL ||
  (BASE_DOMAIN && BASE_DOMAIN !== 'localhost' ? `https://${BASE_DOMAIN}` : 'http://localhost:5173');

// Resend email API
export const RESEND_API_KEY = process.env.RESEND_API_KEY || null;

// Cloudflare Tunnel Token (optional; only used when ENABLE_CLOUDFLARE_TUNNEL=true)
export const CLOUDFLARE_TUNNEL_TOKEN = process.env.ENABLE_CLOUDFLARE_TUNNEL === 'true'
  ? (process.env.CLOUDFLARE_TUNNEL_TOKEN || process.env.TUNNEL_TOKEN || null)
  : null;

export const JWT_SECRET = process.env.JWT_SECRET || null;
export const JWT_EXPIRES_IN = '7d';
export const REFRESH_EXPIRES_DAYS = 30;

export const LOG_RETENTION_LINES = 10000;

// GitHub OAuth & App Configuration
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '5132622';
export const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME || 'morline-cloud';
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Iv23li05lbpUNBiGC7CI';
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || null;
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || null;
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

// GitHub Private Key loader (string, base64, or file)
function loadGitHubPrivateKey() {
  if (process.env.GITHUB_PRIVATE_KEY) {
    return process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (process.env.GITHUB_PRIVATE_KEY_BASE64) {
    return Buffer.from(process.env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  }
  const defaultKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH || path.join(DATA_DIR, 'github-private-key.pem');
  if (fs.existsSync(defaultKeyPath)) {
    try {
      return fs.readFileSync(defaultKeyPath, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}
export const GITHUB_PRIVATE_KEY = loadGitHubPrivateKey();

// AI Assistant LLM Provider Configuration
export const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || 'https://key-keeper-proxy.lovable.app/api/public/ai';
export const AI_GATEWAY_KEY = process.env.AI_GATEWAY_KEY || null;
export const AI_GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || 'google/gemini-2.5-flash';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

if (process.env.NODE_ENV === 'production' && !JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}


