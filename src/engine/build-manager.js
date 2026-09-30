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

    // 1. Source Preparation (Git Clone or Template Seeding)
    if (service.source_type === 'github' && service.source_repo) {
      const gitDir = path.join(cwd, '.git');
      if (!fs.existsSync(gitDir)) {
        // Retrieve team's OAuth access token from database
        const teamRow = queryOne(`
          SELECT gi.access_token 
          FROM services s
          JOIN environments e ON e.id = s.environment_id
          JOIN projects p ON p.id = e.project_id
          LEFT JOIN github_integration gi ON gi.team_id = p.team_id AND gi.connected = 1
          WHERE s.id = ?
        `, serviceId);
        const token = teamRow?.access_token || GITHUB_TOKEN || null;

        const branch = service.source_branch || 'main';
        const cleanRepo = service.source_repo.replace(/\.git$/, '');
        const cloneUrl = token
          ? `https://x-access-token:${token}@github.com/${cleanRepo}.git`
          : `https://github.com/${cleanRepo}.git`;

        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'info',
          message: `[Git] Cloning repository https://github.com/${cleanRepo} (branch: ${branch})...`
        });

        const cloneResult = await new Promise((resolve) => {
          exec(`git clone --depth 1 -b ${branch} ${cloneUrl} .`, { cwd }, (err, stdout, stderr) => {
            if (err) {
              const errMsg = stderr?.trim() || err.message;
              resolve({ success: false, error: errMsg });
            } else {
              resolve({ success: true });
            }
          });
        });

        if (!cloneResult.success) {
          const errDetail = `Git clone failed: ${cloneResult.error}`;
          logManager.appendLog({
            deploymentId,
            serviceId,
            serviceName: service.name,
            environmentId: service.environment_id,
            level: 'error',
            message: `[Git] ${errDetail}`
          });

          execute('UPDATE deployments SET state = ?, finished_at = ?, error_summary = ? WHERE id = ?',
            'failed', new Date().toISOString(), errDetail, deploymentId);
          execute('UPDATE services SET status = ?, building_deployment_id = NULL WHERE id = ?', 'crashed', serviceId);

          eventBus.emitEnvironmentEvent(service.environment_id, {
            type: 'deployment.updated',
            at: new Date().toISOString(),
            actorId: null,
            canvasRevision: null,
            data: { id: deploymentId, state: 'failed', errorSummary: errDetail }
          });
          eventBus.emitEnvironmentEvent(service.environment_id, {
            type: 'service.status',
            at: new Date().toISOString(),
            actorId: null,
            canvasRevision: null,
            data: { id: serviceId, status: 'crashed' }
          });
          return; // Abort immediately - NEVER replace user repo with dummy seed files
        }

        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'info',
          message: `[Git] Successfully cloned repository.`
        });
      }
    } else {
      // Template or empty service -> seed template files
      this.seedTemplateFiles(serviceId, service.source_template_id, service.name);
    }

    // 2. Resolve Build Command
    let buildCommand = (settings.build_command || '').trim();
    if (!buildCommand) {
      const pkgPath = path.join(cwd, 'package.json');
      const reqPath = path.join(cwd, 'requirements.txt');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.scripts?.build) {
            buildCommand = 'npm install && npm run build';
          } else if (pkg.dependencies || pkg.devDependencies) {
            buildCommand = 'npm install';
          }
        } catch (e) {}
      } else if (fs.existsSync(reqPath)) {
        buildCommand = 'pip install -r requirements.txt';
      }
    }

    // 3. Execute Build Phase if build command exists
    if (buildCommand) {
      logManager.appendLog({
        deploymentId,
        serviceId,
        serviceName: service.name,
        environmentId: service.environment_id,
        level: 'info',
        message: `[Build] Running build command: ${buildCommand}`
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
        const errDetail = `Build command failed with exit code: ${buildCommand}`;
        execute('UPDATE deployments SET state = ?, finished_at = ?, error_summary = ? WHERE id = ?',
          'failed', new Date().toISOString(), errDetail, deploymentId);
        execute('UPDATE services SET status = ?, building_deployment_id = NULL WHERE id = ?', 'crashed', serviceId);

        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'error',
          message: `[Build] ${errDetail}`
        });

        eventBus.emitEnvironmentEvent(service.environment_id, {
          type: 'deployment.updated',
          at: new Date().toISOString(),
          actorId: null,
          canvasRevision: null,
          data: { id: deploymentId, state: 'failed', errorSummary: errDetail }
        });
        return;
      }
    }

    // 4. Resolve Start Command
    let startCommand = (settings.start_command || '').trim();
    if (!startCommand) {
      const pkgPath = path.join(cwd, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.scripts?.start) {
            startCommand = 'npm start';
          } else if (pkg.main && fs.existsSync(path.join(cwd, pkg.main))) {
            startCommand = `node ${pkg.main}`;
          }
        } catch (e) {}
      }
      if (!startCommand) {
        if (fs.existsSync(path.join(cwd, 'server.js'))) startCommand = 'node server.js';
        else if (fs.existsSync(path.join(cwd, 'index.js'))) startCommand = 'node index.js';
        else if (fs.existsSync(path.join(cwd, 'app.js'))) startCommand = 'node app.js';
        else if (fs.existsSync(path.join(cwd, 'main.py'))) startCommand = 'python main.py';
        else startCommand = 'node server.js';
      }
    }

    // 5. Deploying Phase
    execute('UPDATE deployments SET state = ? WHERE id = ?', 'deploying', deploymentId);
    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'deployment.updated',
      at: new Date().toISOString(),
      actorId: null,
      canvasRevision: null,
      data: { id: deploymentId, state: 'deploying' }
    });

    logManager.appendLog({
      deploymentId,
      serviceId,
      serviceName: service.name,
      environmentId: service.environment_id,
      level: 'info',
      message: `[Deploy] Launching process: ${startCommand}`
    });

    await processSupervisor.startService(serviceId, deploymentId, {
      cwd,
      command: startCommand
    });
  }
}

export const buildManager = new BuildManager();
