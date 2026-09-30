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
    name: 'Moorline API Server',
    version: '1.0.0',
    documentation: '/v1'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
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
  console.log(`🚀 Moorline API Backend Server running on http://${HOST}:${PORT}`);
  console.log(`📡 OpenAPI Base URL: ${PUBLIC_URL}/v1`);
  console.log(`======================================================\n`);

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
