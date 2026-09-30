import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APPS_DIR, GITHUB_TOKEN } from '../config.js';
import * as dbModule from '../db/index.js';
import { logManager } from './log-manager.js';
import { processSupervisor } from './process-supervisor.js';
import { eventBus } from './event-bus.js';
import { getRepoInstallationToken, getInstallationToken } from '../services/github-app.js';
import {
  detectProject,
  resolveStart,
  readJsonSafe,
  STATIC_SERVER_SOURCE
} from './project-detector.js';

const { queryOne, execute } = dbModule;

const DEFAULT_TIMEOUT_MS = Number(process.env.MORLINE_BUILD_TIMEOUT_MS) || 15 * 60 * 1000;
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const GENERIC_START_DEFAULTS = new Set(['node server.js', 'node index.js', 'node app.js', 'npm start']);

// Never hand the platform's own secrets to user build scripts.
const SECRET_ENV = /(^(GITHUB|MORLINE|DATABASE|DB|JWT|SESSION|COOKIE|ADMIN)_)|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL/i;

class BuildError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  return out
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '***');
}

function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_ENV.test(k) && v !== undefined) env[k] = v;
  }
  return {
    ...env,
    CI: 'true',
    FORCE_COLOR: '0',
    DEBIAN_FRONTEND: 'noninteractive',
    GIT_TERMINAL_PROMPT: '0',
    HUSKY: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_yes: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    ASTRO_TELEMETRY_DISABLED: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
    PYTHONUNBUFFERED: '1'
  };
}

class BuildManager {
  /** serviceId -> { deploymentId, child, kill, cancelled, superseded, done } */
  active = new Map();

  // ------------------------------------------------------------------ workspace

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
const serviceName = process.env.SERVICE_NAME || ${JSON.stringify(serviceName)};

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

server.listen(port, '0.0.0.0', () => {
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
          scripts: { start: 'node server.js' }
        }, null, 2), 'utf-8');
      }
    }
  }

  // ------------------------------------------------------------------ public API

  /** Cancel an in-flight build (kills its whole process tree). */
  cancel(serviceId) {
    const run = this.active.get(serviceId);
    if (!run) return false;
    run.cancelled = true;
    run.kill?.('SIGTERM');
    return true;
  }

  async buildAndDeploy(serviceId, deploymentId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) throw new Error(`Service ${serviceId} not found`);

    // Two builds must never share a workspace. Supersede the older one and wait for it to stop.
    const previous = this.active.get(serviceId);
    if (previous) {
      previous.superseded = true;
      previous.cancelled = true;
      previous.kill?.('SIGTERM');
      await Promise.race([previous.done, sleep(15000)]);
    }

    const run = { deploymentId, child: null, kill: null, cancelled: false, superseded: false };
    run.done = new Promise((resolve) => { run.finish = resolve; });
    this.active.set(serviceId, run);

    const ctx = this._makeContext(service, deploymentId, run);

    try {
      await this._pipeline(ctx, service);
    } catch (err) {
      this._fail(ctx, err);
    } finally {
      if (this.active.get(serviceId) === run) this.active.delete(serviceId);
      run.finish();
    }
  }

  // ------------------------------------------------------------------ pipeline

  async _pipeline(ctx, service) {
    const { serviceId, deploymentId } = ctx;
    const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', serviceId) || {};

    execute('UPDATE deployments SET state = ?, started_at = ? WHERE id = ?', 'building', new Date().toISOString(), deploymentId);
    execute('UPDATE services SET building_deployment_id = ? WHERE id = ?', deploymentId, serviceId);
    ctx.emit('deployment.updated', { id: deploymentId, state: 'building' });
    ctx.log('info', `[Build] Preparing build in workspace ${ctx.cwd}`);

    // 1. Source
    if (service.source_type === 'github' && service.source_repo) {
      await this._syncGithub(ctx, service);
    } else if (this._isEmptyWorkspace(ctx.cwd)) {
      this.seedTemplateFiles(serviceId, service.source_template_id, service.name);
    }
    this._checkCancelled(ctx);

    // 2. Monorepo root directory + project detection
    const workDir = this._resolveWorkDir(ctx, settings);
    const detected = detectProject(workDir);
    const overrides = this._readProjectConfig(ctx, workDir);
    detected.notes.forEach((n) => ctx.log('info', `[Detect] ${n}`));

    const vars = { ...this._loadVariables(serviceId), ...overrides.env };
    Object.values(vars).forEach((v) => ctx.secrets.add(v));

    const userInstall = (settings.install_command || '').trim() || overrides.install || '';
    const userBuild = (settings.build_command || '').trim() || overrides.build || '';
    const userStart = (settings.start_command || '').trim();
    const customStart = userStart && !GENERIC_START_DEFAULTS.has(userStart) ? userStart : overrides.start || '';

    const installCommand = userInstall || detected.install;
    const buildCommand = userBuild || detected.build;

    ctx.log('info',
      `[Detect] ${detected.language}${detected.framework ? `/${detected.framework}` : ''}` +
      `${detected.packageManager ? ` (${detected.packageManager})` : ''}`);

    // 3. Pre-flight checks
    const timeoutMs = Number(settings.build_timeout_seconds) > 0
      ? Number(settings.build_timeout_seconds) * 1000
      : DEFAULT_TIMEOUT_MS;
    const env = { ...baseEnv(), ...detected.env, ...vars };

    await this._requireTools(ctx, detected.tools, env, workDir);
    if (detected.language === 'node') this._warnNodeVersion(ctx, workDir);

    // 4. Install (retried once: registries are flaky)
    if (installCommand) {
      await this._phase(ctx, 'Install', installCommand, workDir,
        { ...env, NODE_ENV: 'development', npm_config_production: 'false' },
        { attempts: 2, timeoutMs });
    }

    // 5. Build
    if (buildCommand) {
      await this._phase(ctx, 'Build', buildCommand, workDir,
        { ...env, NODE_ENV: vars.NODE_ENV || 'production' },
        { attempts: 1, timeoutMs });
    }
    this._checkCancelled(ctx);

    // 6. Start command (after build, so compiled output can be inspected)
    let startCommand = customStart;
    let staticDir = null;
    if (!startCommand) {
      const resolved = resolveStart(workDir, detected);
      if (!resolved) {
        throw new BuildError(
          'Could not work out how to start this project. Add a Procfile ("web: <command>"), ' +
          'a morline.json with {"start": "<command>"}, or set a start command in service settings.'
        );
      }
      startCommand = resolved.command;
      staticDir = resolved.staticDir || null;
      if (resolved.warn) ctx.log('warn', `[Deploy] ${resolved.warn}`);
    }

    if (staticDir) {
      const dir = path.join(workDir, '.morline');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'static-server.cjs'), STATIC_SERVER_SOURCE, 'utf-8');
      ctx.log('info', `[Deploy] Static site detected in "${staticDir}/" — using built-in static server`);
    }

    // 7. Deploy
    execute('UPDATE deployments SET state = ? WHERE id = ?', 'deploying', deploymentId);
    ctx.emit('deployment.updated', { id: deploymentId, state: 'deploying' });
    ctx.log('info', `[Deploy] Launching process: ${startCommand}`);

    const runtimeEnv = {
      ...detected.runtimeEnv,
      ...(detected.language === 'node' ? { NODE_ENV: 'production' } : {}),
      ...vars
    };

    // NOTE: the resolved command is deliberately NOT written back to service_settings.
    // Persisting it made stale auto-detected commands look like user-set ones on later deploys.
    await processSupervisor.startService(serviceId, deploymentId, {
      cwd: workDir,
      command: startCommand,
      env: runtimeEnv
    });
  }

  // ------------------------------------------------------------------ source: github

  async _syncGithub(ctx, service) {
    const repo = String(service.source_repo)
      .trim()
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new BuildError(`Invalid repository "${service.source_repo}" (expected owner/name)`);
    }

    const explicit = (service.source_branch || '').trim();
    if (explicit && (explicit.startsWith('-') || !/^[A-Za-z0-9_./-]+$/.test(explicit))) {
      throw new BuildError(`Invalid branch name "${explicit}"`);
    }
    const branches = explicit ? [explicit] : ['main', 'master'];

    const token = await this._resolveGithubToken(ctx, repo);
    let authArgs = [];
    if (token) {
      const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
      ctx.secrets.add(token);
      ctx.secrets.add(b64);
      // Header auth: the token never lands in .git/config, the remote URL or the process list URL.
      authArgs = ['-c', `http.extraheader=AUTHORIZATION: basic ${b64}`];
    }

    const env = { ...baseEnv() };
    const git = (args, opts = {}) => this._run(ctx, {
      file: 'git',
      args: [...authArgs, ...args],
      cwd: ctx.cwd,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
      stderrLevel: 'info',
      ...opts
    });

    const publicUrl = `https://github.com/${repo}.git`;
    if (!fs.existsSync(path.join(ctx.cwd, '.git'))) {
      // init+fetch (not clone) so it also works in a non-empty workspace
      const init = await git(['init', '-q']);
      if (init.code !== 0) throw new BuildError(`git init failed: ${init.tail.join(' ')}`);
    }
    await git(['remote', 'remove', 'origin'], { quiet: true });
    await git(['remote', 'add', 'origin', publicUrl]);

    let usedBranch = null;
    let lastTail = [];
    for (const branch of branches) {
      ctx.log('info', `[Git] Fetching ${repo} (branch: ${branch})...`);
      const r = await git(['fetch', '--depth', '1', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      this._checkCancelled(ctx);
      if (r.code === 0) { usedBranch = branch; break; }
      lastTail = r.tail;
    }
    if (!usedBranch) {
      // Abort: NEVER replace the user's repo with dummy seed files
      throw new BuildError(
        `Git fetch failed: ${lastTail.slice(-3).join(' ') || 'unknown error'}. ` +
        'Check the repository name, the branch, and that Morline has access to the repo.'
      );
    }

    const checkout = await git(['checkout', '-q', '-f', '-B', usedBranch, `refs/remotes/origin/${usedBranch}`]);
    if (checkout.code !== 0) throw new BuildError(`git checkout failed: ${checkout.tail.join(' ')}`);
    await git(['clean', '-fdq'], { quiet: true }); // removes stale untracked files, keeps ignored caches (node_modules, .venv, target)

    if (fs.existsSync(path.join(ctx.cwd, '.gitmodules'))) {
      ctx.log('info', '[Git] Initialising submodules...');
      await git(['submodule', 'update', '--init', '--recursive', '--depth', '1']); // best effort
    }

    const sha = await git(['rev-parse', '--short', 'HEAD'], { capture: true, quiet: true });
    ctx.log('info', `[Git] Checked out ${repo}@${usedBranch}${sha.stdout.trim() ? ` (${sha.stdout.trim()})` : ''}`);
  }

  async _resolveGithubToken(ctx, repo) {
    const [owner, name] = repo.split('/');
    try {
      const t = await getRepoInstallationToken(owner, name);
      if (t) return t;
    } catch (e) {
      ctx.log('warn', `[Git] Repo installation token lookup failed: ${e.message}`);
    }

    let row = null;
    try {
      row = queryOne(`
        SELECT gi.access_token, gi.installation_id
        FROM services s
        JOIN environments e ON e.id = s.environment_id
        JOIN projects p ON p.id = e.project_id
        LEFT JOIN github_integration gi ON gi.team_id = p.team_id AND gi.connected = 1
        WHERE s.id = ?
      `, ctx.serviceId);
    } catch (e) {
      ctx.log('warn', `[Git] Team integration lookup failed: ${e.message}`);
    }

    if (row?.installation_id) {
      try {
        const t = await getInstallationToken(row.installation_id);
        if (t) return t;
      } catch (e) {
        ctx.log('warn', `[Git] Installation token failed: ${e.message}`);
      }
    }
    return row?.access_token || GITHUB_TOKEN || null;
  }

  // ------------------------------------------------------------------ helpers

  _makeContext(service, deploymentId, run) {
    const ctx = {
      service,
      serviceId: service.id,
      deploymentId,
      run,
      cwd: this.getWorkspaceDir(service.id),
      secrets: new Set(),
      log: (level, message) => {
        const clean = redact(message, ctx.secrets).trim();
        if (!clean) return;
        logManager.appendLog({
          deploymentId,
          serviceId: service.id,
          serviceName: service.name,
          environmentId: service.environment_id,
          level,
          message: clean
        });
      },
      emit: (type, data) => eventBus.emitEnvironmentEvent(service.environment_id, {
        type,
        at: new Date().toISOString(),
        actorId: null,
        canvasRevision: null,
        data
      })
    };
    return ctx;
  }

  _checkCancelled(ctx) {
    if (ctx.run.cancelled) {
      throw new BuildError(ctx.run.superseded ? 'Superseded by a newer deployment' : 'Build cancelled');
    }
  }

  _isEmptyWorkspace(dir) {
    try {
      return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length === 0;
    } catch { return true; }
  }

  _resolveWorkDir(ctx, settings) {
    const rel = String(settings.root_directory || '').trim().replace(/^\/+/, '');
    if (!rel || rel === '.') return ctx.cwd;
    const abs = path.resolve(ctx.cwd, rel);
    if (abs !== ctx.cwd && !abs.startsWith(ctx.cwd + path.sep)) {
      throw new BuildError('Root directory must be inside the repository');
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new BuildError(`Root directory "${rel}" does not exist in the repository`);
    }
    ctx.log('info', `[Build] Using root directory: ${rel}`);
    return abs;
  }

  // Optional morline.json: { "install": "...", "build": "...", "start": "...", "env": { "KEY": "value" } }
  _readProjectConfig(ctx, workDir) {
    const cfg = readJsonSafe(workDir, 'morline.json');
    const out = { install: '', build: '', start: '', env: {} };
    if (!cfg || typeof cfg !== 'object') return out;
    for (const k of ['install', 'build', 'start']) {
      if (typeof cfg[k] === 'string') out[k] = cfg[k].trim();
    }
    if (cfg.env && typeof cfg.env === 'object') {
      for (const [k, v] of Object.entries(cfg.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) out.env[k] = String(v);
      }
    }
    ctx.log('info', '[Detect] Found morline.json');
    return out;
  }

  // Adjust the query to your schema. Silently returns {} if the table/helper doesn't exist.
  _loadVariables(serviceId) {
    const queryAll = dbModule.queryAll;
    if (typeof queryAll !== 'function') return {};
    try {
      const rows = queryAll('SELECT key, value FROM service_variables WHERE service_id = ?', serviceId);
      return Object.fromEntries(rows.map((r) => [r.key, String(r.value ?? '')]));
    } catch {
      return {};
    }
  }

  async _requireTools(ctx, tools, env, cwd) {
    for (const tool of tools || []) {
      const r = await this._run(ctx, { command: `command -v ${tool}`, cwd, env, timeoutMs: 15000, quiet: true });
      if (r.code !== 0) {
        throw new BuildError(`Required tool "${tool}" is not installed on the build host`);
      }
    }
  }

  _warnNodeVersion(ctx, workDir) {
    const pkg = readJsonSafe(workDir, 'package.json');
    let nvmrc = '';
    try { nvmrc = fs.readFileSync(path.join(workDir, '.nvmrc'), 'utf-8'); } catch {}
    const want = parseInt(String(pkg?.engines?.node || nvmrc).match(/\d+/)?.[0], 10);
    const have = parseInt(process.versions.node, 10);
    if (want && have < want) {
      ctx.log('warn', `[Build] Project asks for Node ${want}+ but the build host runs Node ${process.versions.node}`);
    }
  }

  async _phase(ctx, name, command, cwd, env, { attempts = 1, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this._checkCancelled(ctx);
      ctx.log('info', `[${name}] $ ${command}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ''}`);

      const r = await this._run(ctx, { command, cwd, env, timeoutMs });
      if (r.code === 0) return;

      this._checkCancelled(ctx);
      if (r.timedOut) throw new BuildError(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`);
      if (attempt === attempts) {
        const reason = r.error || `exit code ${r.code ?? r.signal}`;
        const hint = r.tail.length ? ` — ${r.tail.slice(-2).join(' | ')}` : '';
        throw new BuildError(`${name} command failed (${reason}): ${command}${hint}`);
      }
      ctx.log('warn', `[${name}] Failed (exit ${r.code}); retrying...`);
      await sleep(2000);
    }
  }

  /**
   * Run a shell command (`command`) or an executable with args (`file` + `args`, no shell → no injection).
   * Streams line-buffered output to the log, enforces a timeout, and kills the entire process group.
   * Resolves (never rejects) with { code, signal, timedOut, error, tail, stdout }.
   */
  _run(ctx, { command, file, args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, stderrLevel = 'warn', quiet = false, capture = false }) {
    return new Promise((resolve) => {
      const tail = [];
      let stdout = '';
      let timedOut = false;
      let settled = false;

      let child;
      try {
        const stdio = ['ignore', 'pipe', 'pipe'];
        child = command
          ? spawn(command, { cwd, env, shell: true, detached: true, stdio })
          : spawn(file, args, { cwd, env, detached: true, stdio });
      } catch (err) {
        return resolve({ code: -1, error: err.message, tail: [err.message], stdout: '' });
      }

      const kill = (sig) => {
        try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
      };
      ctx.run.child = child;
      ctx.run.kill = kill;

      const timer = setTimeout(() => {
        timedOut = true;
        ctx.log('error', `[Build] Command exceeded ${Math.round(timeoutMs / 1000)}s — terminating`);
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 5000).unref();
      }, timeoutMs);

      const onLine = (raw, level) => {
        const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
        if (!line) return;
        tail.push(line);
        if (tail.length > 15) tail.shift();
        if (!quiet) ctx.log(level, line);
      };

      const attach = (stream, level, isStdout) => {
        let buf = '';
        stream.on('data', (chunk) => {
          const text = chunk.toString();
          if (capture && isStdout) stdout += text;
          buf += text;
          const parts = buf.split(/\r\n|\n|\r/);
          buf = parts.pop();
          parts.forEach((l) => onLine(l, level));
          if (buf.length > 65536) { onLine(buf, level); buf = ''; }
        });
        stream.on('end', () => onLine(buf, level));
      };
      attach(child.stdout, 'info', true);
      attach(child.stderr, stderrLevel, false);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ctx.run.child === child) { ctx.run.child = null; ctx.run.kill = null; }
        resolve({ tail, stdout, timedOut, ...result });
      };
      child.on('error', (err) => finish({ code: -1, error: err.message }));
      child.on('close', (code, signal) => finish({ code, signal }));
    });
  }

  _fail(ctx, err) {
    const { serviceId, deploymentId, run } = ctx;
    const known = err instanceof BuildError;
    const summary = known ? err.message : `Unexpected build error: ${err?.message || err}`;

    ctx.log('error', `[Build] ${summary}`);
    if (!known && err?.stack) ctx.log('error', err.stack.split('\n').slice(0, 6).join('\n'));

    try {
      execute('UPDATE deployments SET state = ?, finished_at = ?, error_summary = ? WHERE id = ?',
        'failed', new Date().toISOString(), summary, deploymentId);
      ctx.emit('deployment.updated', { id: deploymentId, state: 'failed', errorSummary: summary });

      // A superseded build must not touch service status: a newer deployment now owns it.
      if (run.superseded) return;

      execute('UPDATE services SET status = ?, building_deployment_id = NULL WHERE id = ?', 'crashed', serviceId);
      ctx.emit('service.status', { id: serviceId, status: 'crashed' });
    } catch (dbErr) {
      console.error('[BuildManager] Failed to record build failure:', dbErr);
    }
  }
}

export const buildManager = new BuildManager();
