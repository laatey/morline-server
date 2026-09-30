import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { APPS_DIR, GITHUB_TOKEN } from '../config.js';
import { queryOne, execute } from '../db/index.js';
import { logManager } from './log-manager.js';
import { processSupervisor } from './process-supervisor.js';
import { eventBus } from './event-bus.js';
import { getRepoInstallationToken, getInstallationToken } from '../services/github-app.js';

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
      const templateCode = `// Morline Service: ${serviceName}
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
    message: 'Hello from Morline!',
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
        // Retrieve installation token or team's OAuth access token from database
        const cleanRepo = service.source_repo.replace(/\.git$/, '');
        const [repoOwner, repoNameOnly] = cleanRepo.includes('/') ? cleanRepo.split('/') : [null, cleanRepo];

        let token = null;
        if (repoOwner && repoNameOnly) {
          token = await getRepoInstallationToken(repoOwner, repoNameOnly);
        }

        if (!token) {
          const teamRow = queryOne(`
            SELECT gi.access_token, gi.installation_id 
            FROM services s
            JOIN environments e ON e.id = s.environment_id
            JOIN projects p ON p.id = e.project_id
            LEFT JOIN github_integration gi ON gi.team_id = p.team_id AND gi.connected = 1
            WHERE s.id = ?
          `, serviceId);

          if (teamRow?.installation_id) {
            token = await getInstallationToken(teamRow.installation_id);
          }
          if (!token) {
            token = teamRow?.access_token || GITHUB_TOKEN || null;
          }
        }

        const branch = service.source_branch || 'main';
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
    // Use stored command only if it was explicitly set by the user (not the default placeholder).
    // After a build we re-inspect the workspace so TypeScript/compiled projects work correctly.
    const GENERIC_DEFAULTS = ['node server.js', 'node index.js', 'node app.js', 'npm start'];
    let startCommand = (settings.start_command || '').trim();
    const isDefaultPlaceholder = !startCommand || GENERIC_DEFAULTS.includes(startCommand);

    if (isDefaultPlaceholder) {
      // Re-read package.json after the build so we see post-compile scripts
      const pkgPath = path.join(cwd, 'package.json');
      let pkg = null;
      if (fs.existsSync(pkgPath)) {
        try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch (e) {}
      }

      // 4a. Prefer package.json scripts.start if it exists and is NOT a dev command
      if (pkg?.scripts?.start && !pkg.scripts.start.includes('react-scripts start')) {
        startCommand = 'npm start';
      }

      // 4b. Detect Static Single Page Applications (Vite, React, Vue, Svelte, static HTML)
      // If index.html is in dist/, build/, out/, or public/ and no backend start script was defined:
      const candidateStaticDirs = ['dist', 'build', 'out', 'public'];
      const foundStaticDir = candidateStaticDirs.find(d => fs.existsSync(path.join(cwd, d, 'index.html')));

      if (foundStaticDir && (!pkg?.scripts?.start || startCommand === 'npm start')) {
        // Check if there is an actual backend JS file in dist (like NestJS/TypeScript backend)
        const hasBackendEntryInStaticDir = ['server.js', 'index.js', 'main.js', 'app.js'].some(f => {
          const p = path.join(cwd, foundStaticDir, f);
          return fs.existsSync(p) && !fs.statSync(p).isDirectory();
        });

        // If it's a frontend (e.g. Vite outputs index.html + assets/) and not a backend:
        const isViteOrFrontend = Boolean(pkg?.devDependencies?.vite || pkg?.dependencies?.vite || pkg?.scripts?.build?.includes('vite') || !hasBackendEntryInStaticDir);

        if (isViteOrFrontend) {
          const staticServerScript = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const port = parseInt(process.env.PORT || '3000', 10);
const staticDir = path.join(__dirname, '${foundStaticDir}');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(staticDir, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(staticDir, 'index.html'); // SPA client-side routing fallback
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(500); res.end('Error loading asset'); return; }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000'
    });
    res.end(content);
  });
});
server.listen(port, '0.0.0.0', () => {
  console.log('[Morline Static Server] Serving ${foundStaticDir} on http://0.0.0.0:' + port);
});
`.trim();

          const scriptPath = path.join(cwd, '_morline_server.cjs');
          fs.writeFileSync(scriptPath, staticServerScript, 'utf-8');
          startCommand = 'node _morline_server.cjs';
          logManager.appendLog({
            deploymentId, serviceId, serviceName: service.name, environmentId: service.environment_id,
            level: 'info',
            message: `[Deploy] Detected static web application in "${foundStaticDir}/" — configured production static server`
          });
        }
      }

      // 4b. For TypeScript projects: check tsconfig outDir to find compiled entry point
      if (!startCommand || startCommand === 'npm start') {
        const tsconfigPath = path.join(cwd, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
          try {
            const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
            const outDir = tsconfig?.compilerOptions?.outDir || 'dist';
            const outDirAbs = path.join(cwd, outDir);
            // Look for common compiled entry points
            const candidates = ['index.js', 'server.js', 'app.js', 'main.js'];
            for (const c of candidates) {
              if (fs.existsSync(path.join(outDirAbs, c))) {
                // If package.json scripts.start exists, trust it — otherwise point directly
                if (!pkg?.scripts?.start) {
                  startCommand = `node ${outDir}/${c}`;
                }
                break;
              }
            }
          } catch (e) {}
        }
      }

      // 4c. Check common compiled output dirs (dist/, build/, out/) regardless of tsconfig
      if (!startCommand || GENERIC_DEFAULTS.includes(startCommand)) {
        const compiledDirs = ['dist', 'build', 'out', 'lib'];
        const entryNames = ['index.js', 'server.js', 'app.js', 'main.js'];
        outer: for (const dir of compiledDirs) {
          for (const entry of entryNames) {
            const p = path.join(cwd, dir, entry);
            if (fs.existsSync(p)) {
              startCommand = pkg?.scripts?.start ? 'npm start' : `node ${dir}/${entry}`;
              break outer;
            }
          }
        }
      }

      // 4d. Fall back to pkg.main if it exists on disk
      if (!startCommand || GENERIC_DEFAULTS.includes(startCommand)) {
        if (pkg?.main && fs.existsSync(path.join(cwd, pkg.main))) {
          startCommand = `node ${pkg.main}`;
        }
      }

      // 4e. Plain JS roots (only if actually present)
      if (!startCommand || GENERIC_DEFAULTS.includes(startCommand)) {
        const jsRoots = ['index.js', 'server.js', 'app.js', 'main.js'];
        for (const f of jsRoots) {
          if (fs.existsSync(path.join(cwd, f))) {
            startCommand = `node ${f}`;
            break;
          }
        }
      }

      // 4f. Python
      if (!startCommand || GENERIC_DEFAULTS.includes(startCommand)) {
        if (fs.existsSync(path.join(cwd, 'main.py'))) startCommand = 'python main.py';
        else if (fs.existsSync(path.join(cwd, 'app.py'))) startCommand = 'uvicorn app:app --host 0.0.0.0 --port $PORT';
      }

      // 4g. Last resort — log clearly that we couldn't detect it
      if (!startCommand || GENERIC_DEFAULTS.includes(startCommand)) {
        startCommand = pkg?.scripts?.start ? 'npm start' : 'node server.js';
        logManager.appendLog({
          deploymentId, serviceId, serviceName: service.name, environmentId: service.environment_id,
          level: 'warn',
          message: `[Deploy] Could not auto-detect start command — using "${startCommand}". Set a custom start command in service settings if this fails.`
        });
      }

      // Persist the resolved command so next redeploy reuses it
      execute('UPDATE service_settings SET start_command = ? WHERE service_id = ?', startCommand, serviceId);
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
