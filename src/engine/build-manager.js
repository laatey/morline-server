import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { APPS_DIR, GITHUB_TOKEN } from '../config.js';
import { queryOne, execute } from '../db/index.js';
import { logManager } from './log-manager.js';
import { processSupervisor } from './process-supervisor.js';
import { eventBus } from './event-bus.js';

class BuildManager {
  getWorkspaceDir(serviceId) {
    const dir = path.join(APPS_DIR, serviceId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  seedTemplateFiles(serviceId, templateId, serviceName) {
    const dir = this.getWorkspaceDir(serviceId);
    const serverJsPath = path.join(dir, 'server.js');

    if (!fs.existsSync(serverJsPath)) {
      const templateCode = `// Moorline Service: ${serviceName}
import http from 'node:http';

const port = process.env.PORT || 3000;
const serviceName = process.env.SERVICE_NAME || '${serviceName}';

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: serviceName,
      port: Number(port),
      uptime: process.uptime(),
      time: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from Moorline!',
    service: serviceName,
    path: req.url,
    method: req.method,
    headers: req.headers
  }));
});

server.listen(port, () => {
  console.log(\`[\${serviceName}] Server is online and listening on http://0.0.0.0:\${port}\`);
});
`;
      fs.writeFileSync(serverJsPath, templateCode, 'utf-8');

      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, JSON.stringify({
          name: serviceName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          version: '1.0.0',
          type: 'module',
          scripts: {
            start: 'node server.js'
          }
        }, null, 2), 'utf-8');
      }
    }
  }

  async buildAndDeploy(serviceId, deploymentId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) throw new Error(`Service ${serviceId} not found`);

    const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', serviceId) || {};
    const cwd = this.getWorkspaceDir(serviceId);

    // If GitHub source, clone repository
    if (service.source_type === 'github' && service.source_repo) {
      const gitDir = path.join(cwd, '.git');
      if (!fs.existsSync(gitDir)) {
        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'info',
          message: `[Git] Cloning repository https://github.com/${service.source_repo}...`
        });

        const cloneUrl = GITHUB_TOKEN
          ? `https://${GITHUB_TOKEN}@github.com/${service.source_repo}.git`
          : `https://github.com/${service.source_repo}.git`;
        const branch = service.source_branch || 'main';

        await new Promise((resolve) => {
          exec(`git clone --depth 1 -b ${branch} ${cloneUrl} .`, { cwd }, (err) => {
            if (err) {
              logManager.appendLog({
                deploymentId,
                serviceId,
                serviceName: service.name,
                environmentId: service.environment_id,
                level: 'warn',
                message: `[Git] Clone failed or branch unavailable. Using seed files.`
              });
              this.seedTemplateFiles(serviceId, service.source_template_id, service.name);
            } else {
              logManager.appendLog({
                deploymentId,
                serviceId,
                serviceName: service.name,
                environmentId: service.environment_id,
                level: 'info',
                message: `[Git] Successfully cloned repository.`
              });
            }
            resolve();
          });
        });
      }
    } else {
      // Prepare files if not present
      this.seedTemplateFiles(serviceId, service.source_template_id, service.name);
    }

    execute('UPDATE deployments SET state = ?, started_at = ? WHERE id = ?', 'building', new Date().toISOString(), deploymentId);
    execute('UPDATE services SET building_deployment_id = ? WHERE id = ?', deploymentId, serviceId);

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'deployment.updated',
      at: new Date().toISOString(),
      actorId: null,
      canvasRevision: null,
      data: { id: deploymentId, state: 'building' }
    });

    logManager.appendLog({
      deploymentId,
      serviceId,
      serviceName: service.name,
      environmentId: service.environment_id,
      level: 'info',
      message: `[Build] Preparing build in workspace ${cwd}`
    });

    const buildCommand = settings.build_command;
    if (buildCommand && buildCommand.trim()) {
      logManager.appendLog({
        deploymentId,
        serviceId,
        serviceName: service.name,
        environmentId: service.environment_id,
        level: 'info',
        message: `[Build] Executing: ${buildCommand}`
      });

      const buildSuccess = await new Promise((resolve) => {
        const proc = exec(buildCommand, { cwd, env: { ...process.env, CI: 'true' } });
        proc.stdout?.on('data', (d) => {
          logManager.appendLog({
            deploymentId,
            serviceId,
            serviceName: service.name,
            environmentId: service.environment_id,
            level: 'info',
            message: d.toString().trim()
          });
        });
        proc.stderr?.on('data', (d) => {
          logManager.appendLog({
            deploymentId,
            serviceId,
            serviceName: service.name,
            environmentId: service.environment_id,
            level: 'warn',
            message: d.toString().trim()
          });
        });
        proc.on('close', (code) => {
          resolve(code === 0);
        });
      });

      if (!buildSuccess) {
        execute('UPDATE deployments SET state = ?, finished_at = ?, error_summary = ? WHERE id = ?',
          'failed', new Date().toISOString(), 'Build command failed', deploymentId);
        execute('UPDATE services SET building_deployment_id = NULL WHERE id = ?', serviceId);

        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'error',
          message: '[Build] Failed with non-zero exit code'
        });

        eventBus.emitEnvironmentEvent(service.environment_id, {
          type: 'deployment.updated',
          at: new Date().toISOString(),
          actorId: null,
          canvasRevision: null,
          data: { id: deploymentId, state: 'failed' }
        });
        return;
      }
    }

    // Deploying phase
    execute('UPDATE deployments SET state = ? WHERE id = ?', 'deploying', deploymentId);
    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'deployment.updated',
      at: new Date().toISOString(),
      actorId: null,
      canvasRevision: null,
      data: { id: deploymentId, state: 'deploying' }
    });

    const startCommand = settings.start_command || 'node server.js';
    await processSupervisor.startService(serviceId, deploymentId, {
      cwd,
      command: startCommand
    });
  }
}

export const buildManager = new BuildManager();
