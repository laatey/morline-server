import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { PORT, HOST, DATA_DIR, PUBLIC_URL } from './config.js';
import { initDb } from './db/index.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { reverseProxyMiddleware } from './engine/reverse-proxy.js';
import { processSupervisor } from './engine/process-supervisor.js';
import { tunnelManager } from './engine/tunnel-manager.js';

// Import route modules
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import teamsRouter from './routes/teams.js';
import projectsRouter from './routes/projects.js';
import environmentsRouter from './routes/environments.js';
import connectionsRouter from './routes/connections.js';
import servicesRouter from './routes/services.js';
import deploymentsRouter from './routes/deployments.js';
import domainsRouter from './routes/domains.js';
import notificationsRouter from './routes/notifications.js';
import activityRouter from './routes/activity.js';
import searchRouter from './routes/search.js';
import assistantRouter from './routes/assistant.js';
import githubRouter from './routes/github.js';
import templatesRouter from './routes/templates.js';

// Initialize Database & Seeds
initDb();

const app = express();

// Enable CORS for frontend applications
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Accept']
}));

// Reverse proxy middleware for requests to internal service ports
app.use(reverseProxyMiddleware);

// Middleware
app.use(requestIdMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static avatars
app.use('/avatars', express.static(path.join(DATA_DIR, 'avatars')));

// Root & Healthcheck
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    name: 'Morline API Server',
    version: '1.0.0',
    documentation: '/v1'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// GitHub App installation redirect handler
// GitHub redirects to: https://api.morline.space/settings/integrations?installation_id=...&setup_action=install
app.get('/settings/integrations', async (req, res) => {
  const { installation_id, setup_action, error } = req.query;

  if (error) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f5f5f5;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}</style>
</head><body><p style="color:#f87171;font-size:14px">GitHub connection failed: ${String(error).slice(0, 100)}</p></body></html>`);
  }

  // If GitHub sent an installation_id, auto-save it
  if (installation_id) {
    try {
      const { execute, queryOne } = await import('./db/index.js');
      const { generateGitHubAppJwt } = await import('./services/github-app.js');
      const { GITHUB_APP_NAME } = await import('./config.js');

      const instId = parseInt(installation_id, 10);
      let account = 'GitHub Account';

      const jwt = generateGitHubAppJwt();
      if (jwt) {
        const r = await fetch(`https://api.github.com/app/installations/${instId}`, {
          headers: { 'Authorization': `Bearer ${jwt}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'Morline-App' }
        });
        if (r.ok) {
          const data = await r.json();
          account = data.account?.login || account;
        }
      }

      const firstTeam = queryOne('SELECT id FROM teams ORDER BY created_at ASC LIMIT 1');
      const teamId = firstTeam?.id || 'team_default';
      const now = new Date().toISOString();

      execute(`
        INSERT INTO github_integration (team_id, account, install_url, installation_id, connected, connected_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(team_id) DO UPDATE SET
          account = excluded.account,
          installation_id = excluded.installation_id,
          connected = 1,
          connected_at = excluded.connected_at
      `, teamId, account, `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`, instId, now);

      console.log(`[GitHub] Saved installation ${instId} (${account}) for team ${teamId}`);
    } catch (e) {
      console.error('[GitHub] Failed to save installation from redirect:', e.message);
    }
  }

  // Serve minimal auto-close page
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GitHub Connected</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #f5f5f5;
      font-family: system-ui, -apple-system, sans-serif;
      display: grid;
      place-items: center;
      min-height: 100vh;
      gap: 0;
    }
    .wrap { text-align: center; }
    .dot {
      width: 32px; height: 32px;
      border-radius: 50%;
      background: #22c55e;
      display: inline-grid;
      place-items: center;
      margin-bottom: 12px;
    }
    .dot svg { width: 16px; height: 16px; stroke: #fff; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    p { font-size: 13px; color: #a3a3a3; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="dot">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <div style="font-size:14px;font-weight:500">GitHub connected</div>
    <p>You can close this window.</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'github_connected' }, '*');
      }
    } catch(e) {}
    setTimeout(() => window.close(), 1500);
  </script>
</body>
</html>`);
});

// Mount /v1 Router
const v1 = express.Router();
v1.use(authenticate);

v1.use('/', templatesRouter);
v1.use('/auth', authRouter);
v1.use('/me', usersRouter);
v1.use('/', teamsRouter);
v1.use('/projects', projectsRouter);
v1.use('/environments', environmentsRouter);
v1.use('/connections', connectionsRouter);
v1.use('/', servicesRouter);
v1.use('/deployments', deploymentsRouter);
v1.use('/domains', domainsRouter);
v1.use('/notifications', notificationsRouter);
v1.use('/', activityRouter);
v1.use('/search', searchRouter);
v1.use('/', assistantRouter);
v1.use('/integrations/github', githubRouter);

app.use('/v1', v1);

// Error Handler
app.use(errorHandler);

// Start server
const server = app.listen(PORT, HOST, async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Morline API Backend Server running on http://${HOST}:${PORT}`);
  console.log(`📡 OpenAPI Base URL: ${PUBLIC_URL}/v1`);
  console.log(`======================================================\n`);

  // If running on a dynamic platform port (like Railway), also listen on 3001 for tunnel compatibility
  if (PORT !== 3001) {
    try {
      const fallbackServer = app.listen(3001, '0.0.0.0', () => {
        console.log(`🔗 Also listening on internal fallback port http://0.0.0.0:3001`);
      });
      fallbackServer.on('error', () => {});
    } catch (e) {}
  }

  // Start Cloudflare Tunnel if token is configured
  try {
    await tunnelManager.start();
  } catch (err) {
    console.error('[TunnelManager] Failed to start tunnel:', err.message);
  }
});

// Graceful Shutdown
function handleShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  tunnelManager.stop();
  server.close(async () => {
    // Terminate any active child processes
    for (const [serviceId] of processSupervisor.processes) {
      await processSupervisor.stopService(serviceId, true);
    }
    console.log('Server and processes terminated cleanly.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

export default app;
