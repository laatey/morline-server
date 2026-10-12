import fs from 'node:fs';
import { udpPublishSpecs, udpEnv } from './public-udp.js';
import { hardeningArgs } from './container-hardening.js';
import { effectiveLimits } from './capacity.js';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { parseDocument } from 'yaml';
import { APPS_DIR, DATA_DIR } from '../config.js';
import { execute, queryAll, queryOne } from '../db/index.js';
import { logManager } from './log-manager.js';
import { eventBus } from './event-bus.js';
import { attachToPrivateNetwork, attachByLabel } from './private-network.js';
import { notify, recipientsForDeployment, projectOfEnvironment, adminsOfProject, projectLink } from '../services/notifications.js';

const NETWORK = 'morline-runtime';
const safeName = (value) => String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
export const containerName = (serviceId) => `morline-${safeName(serviceId)}`;
const imageName = (serviceId, deploymentId) => `morline/${safeName(serviceId)}:${safeName(deploymentId)}`;


// Docker only tells us which *stream* a line came from, and plenty of healthy programs
// (uvicorn, postgres, python logging, npm) write ordinary INFO output to stderr. Labelling
// by stream made normal startup output show up as errors. Classify by content instead.
const TAG = '(^|[\\s\\[(|:])';
const END = '(\\b|:|\\])';
const RE_ERROR = new RegExp(`${TAG}(ERROR|FATAL|CRITICAL|PANIC|SEVERE)${END}`);
const RE_WARN = new RegExp(`${TAG}(WARN|WARNING)${END}`);
const RE_INFO = new RegExp(`${TAG}(INFO|DEBUG|LOG|NOTICE|TRACE)${END}`);

function detectLevel(line) {
  const t = line.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const l = String(j.level ?? j.severity ?? j.lvl ?? '').toLowerCase();
      if (l) {
        if (/^(err|fatal|panic|crit|dpanic|alert|emerg)/.test(l)) return 'error';
        if (l.startsWith('warn')) return 'warn';
        return 'info';
      }
    } catch { /* not JSON, fall through */ }
  }
  if (/^\s*(\w+: )?(error|fatal|panic)\b[:\s]/i.test(t) || /Traceback \(most recent call last\)/.test(t)
    || /\b(Unhandled|Uncaught)\b/.test(t) || /^\w*Error: /.test(t) || /\bnpm ERR!/.test(t)
    || RE_ERROR.test(t)) return 'error';
  if (/^\s*(\w+: )?warning:/i.test(t) || /\bnpm warn\b/.test(t) || RE_WARN.test(t)) return 'warn';
  if (RE_INFO.test(t)) return 'info';
  return null;
}

// Per-stream classifier. Unrecognised lines that follow an error/warning within a moment
// (stack traces, multi-line messages) inherit its level; everything else is plain info.
function makeLevelClassifier() {
  let last = { level: 'info', at: 0 };
  return (line) => {
    const now = Date.now();
    let level = detectLevel(line);
    if (!level) level = last.level !== 'info' && now - last.at < 250 ? last.level : 'info';
    last = { level, at: now };
    return level;
  };
}

function hostWorkspacePath(cwd) {
  const hostData = process.env.HOST_DATA_DIR;
  if (!hostData || !cwd.startsWith(DATA_DIR + path.sep)) return cwd;
  return path.join(hostData, path.relative(DATA_DIR, cwd));
}

function prepareBuildIgnore(cwd) {
  const file = path.join(cwd, '.dockerignore');
  const existed = fs.existsSync(file);
  const original = existed ? fs.readFileSync(file, 'utf8') : null;
  const required = ['node_modules', '.git', 'dist', 'build', '.next', '.cache'];
  const current = original || '';
  const additions = required.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (additions.length) fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
  return () => {
    if (existed) fs.writeFileSync(file, original);
    else fs.rmSync(file, { force: true });
  };
}

function run(command, args, { cwd, env, onLine, stderrLevel = 'error' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const consume = (stream, level) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.filter(Boolean).forEach((line) => onLine?.(level, line));
      });
      stream.on('end', () => buffer && onLine?.(level, buffer));
    };
    consume(child.stdout, 'info');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    consume(child.stderr, stderrLevel);
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

// Railpack CLI and its BuildKit frontend image must be the same version.
const RAILPACK_FRONTEND = process.env.RAILPACK_FRONTEND_IMAGE
  || `ghcr.io/railwayapp/railpack-frontend:v${process.env.RAILPACK_VERSION || '0.37.0'}`;

export class ContainerSupervisor {
  constructor() {
    this.processes = new Map();
  }

  async ensureNetwork() {
    try { await run('docker', ['network', 'inspect', NETWORK]); }
    catch { await run('docker', ['network', 'create', NETWORK]); }
  }

  endpoint(serviceId, port) {
    return { host: containerName(serviceId), port: Number(port || 3000) };
  }

  endpointForService(serviceId) {
    const info = this.processes.get(serviceId);
    return info ? this.endpoint(serviceId, info.port) : null;
  }

  async build(serviceId, deploymentId, { cwd, strategy, dockerfilePath, installCommand, startCommand, runtime, variables = {}, onLog }) {
    const image = imageName(serviceId, deploymentId);
    const log = (level, line) => onLog?.(level, line);
    // The service's variables are available while building too (VITE_*, NEXT_PUBLIC_*, build scripts).
    const buildVars = Object.fromEntries(Object.entries(variables).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)));
    if (strategy === 'dockerfile') {
      const file = dockerfilePath || 'Dockerfile';
      // `--build-arg KEY` (no value) reads the value from the environment, so it never appears in a command line.
      // A Dockerfile receives a variable only if it declares `ARG KEY`.
      const buildArgs = Object.keys(buildVars).flatMap((key) => ['--build-arg', key]);
      if (buildArgs.length) log('info', `[Docker] Offering ${Object.keys(buildVars).length} variables as build arguments (declare ARG NAME in the Dockerfile to use one)`);
      await run('docker', ['build', '--pull', ...buildArgs, '--tag', image, '--file', file, '.'], { cwd, env: buildVars, onLine: log, stderrLevel: 'info' });
    } else {
      // Railpack: `prepare` analyses the source and writes a build plan, then the
      // Railpack BuildKit frontend builds that plan through the mounted Docker daemon.
      // (This is the production path recommended in the Railpack docs.)
      const restoreIgnore = prepareBuildIgnore(cwd);
      const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'railpack-'));
      try {
        const planFile = path.join(planDir, 'railpack-plan.json');
        const infoFile = path.join(planDir, 'railpack-info.json');

        // The service's variables come first so Settings can still override a RAILPACK_* value.
        // Blank Settings fields => Railpack auto-detects.
        const cfg = { ...buildVars };
        if (installCommand) cfg.RAILPACK_INSTALL_CMD = installCommand;
        if (startCommand) cfg.RAILPACK_START_CMD = startCommand;
        if (runtime?.runtime === 'node' && runtime.version) cfg.RAILPACK_NODE_VERSION = String(runtime.version);
        const envArgs = Object.entries(cfg).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

        log('info', `[Railpack] Planning build${Object.keys(buildVars).length ? ` with ${Object.keys(buildVars).length} service variable(s) available to the build` : ''}`);
        await run('railpack', ['prepare', cwd, '--plan-out', planFile, '--info-out', infoFile, ...envArgs],
          { cwd, env: cfg, onLine: log, stderrLevel: 'info' });

        log('info', `[Railpack] Building with ${RAILPACK_FRONTEND}`);
        // Everything passed to `prepare --env` becomes a BuildKit *secret* referenced
        // by the plan, so each one must be supplied again here (values come from the
        // process env, never the command line) plus a hash so BuildKit invalidates
        // cached layers when a value changes.
        const secretKeys = Object.keys(cfg).sort();
        const secretsHash = crypto.createHash('sha256')
          .update(secretKeys.map((k) => `${k}=${cfg[k]}`).join('\n')).digest('hex');
        const secretArgs = secretKeys.flatMap((k) => ['--secret', `id=${k},env=${k}`]);

        await run('docker', [
          'buildx', 'build',
          '--build-arg', `BUILDKIT_SYNTAX=${RAILPACK_FRONTEND}`,
          '--build-arg', `secrets-hash=${secretsHash}`,
          ...secretArgs,
          '-f', planFile,
          '--load', '--tag', image,
          cwd
        ], { cwd, env: { DOCKER_BUILDKIT: '1', ...cfg }, onLine: log, stderrLevel: 'info' });

        // Post-build sanity check: what actually ended up in the image.
        if (runtime?.runtime === 'node') {
          try {
            const verifyScript = ['node --version', 'npm --version', `node -p "process.platform + '/' + process.arch"`, 'echo "[/app]" && ls -1p /app | head -40', 'test -d /app/dist && echo "[/app/dist]" && ls -1p /app/dist | head -20 || true'].join(' && ');
            await run('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', verifyScript],
              { onLine: (_, line) => log('info', `[Container verify] ${line}`) });
          } catch {
            // Non-fatal: minimal images may not have sh on PATH
          }
        }
      } finally {
        fs.rmSync(planDir, { recursive: true, force: true });
        restoreIgnore();
      }
    }
    return image;
  }

  async startService(serviceId, deploymentId, options = {}) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) throw new Error(`Service ${serviceId} not found`);
    const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', serviceId) || {};
    const networking = queryOne('SELECT * FROM service_networking WHERE service_id = ?', serviceId) || {};
    const deployment = queryOne('SELECT * FROM deployments WHERE id = ?', deploymentId);
    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
    const image = options.image || deployment.image;
    if (!image) throw new Error('No built container image is available for this deployment');

    await this.ensureNetwork();
    await this.stopService(serviceId, false);
    const targetPort = Number(networking.target_port || service.port || 3000);
    const variables = this.variables(service.environment_id, serviceId);
    const envFile = this.writeEnvFile(serviceId, { ...variables, ...udpEnv(serviceId), PORT: String(targetPort), NODE_ENV: 'production' });
    const name = containerName(serviceId);
    const args = ['run', '-d', '--name', name, '--network', NETWORK, '--network-alias', name,
      '--label', `morline.service_id=${serviceId}`, '--label', `morline.deployment_id=${deploymentId}`,
      '--env-file', envFile, '--restart', settings.restart_policy === 'always' ? 'always' : 'on-failure:5'];

    const volumes = queryAll('SELECT * FROM volumes WHERE service_id = ?', serviceId);
    for (const volume of volumes) {
      const hostDir = path.join(DATA_DIR, 'service-volumes', serviceId, volume.id);
      fs.mkdirSync(hostDir, { recursive: true });
      args.push('--volume', `${hostDir}:${volume.mount_path}`);
    }
    args.push(...hardeningArgs(settings));
    // Public TCP access: Docker publishes the service's port on the host under its own public port.
    if (networking.tcp_proxy_port) args.push('--publish', `${networking.tcp_proxy_port}:${targetPort}`);
    // Public UDP access: one published port per mapping, e.g. 31000:1812/udp.
    for (const spec of udpPublishSpecs(serviceId)) args.push('--publish', spec);
    args.push(image);

    await run('docker', args);
    execute('UPDATE services SET port = ? WHERE id = ?', targetPort, serviceId);
    const info = { serviceId, deploymentId, image, name, port: targetPort, environmentId: service.environment_id };
    this.processes.set(serviceId, info);
    this.followLogs(service, info);
    await this.attachPrivate(service, info, () => attachToPrivateNetwork(service, name));
    this.pollHealthCheck(serviceId, deploymentId, this.endpoint(serviceId, targetPort), settings.healthcheck_path || '/', settings.healthcheck_timeout_sec || 30);
    return info;
  }

  // Joining the private network is what makes <name>.morline.internal resolve. A failure is reported
  // in the service's logs but does not stop the service from running.
  async attachPrivate(service, info, attach) {
    try {
      const { alias } = await attach();
      this.log(service, info, 'info', `[Network] Reachable inside the environment as ${alias}`);
    } catch (err) {
      this.log(service, info, 'warn', `[Network] Private networking is unavailable: ${err.message}`);
    }
  }

  /** `docker pull`, streaming progress lines to `onLog`. Throws a message a user can act on. */
  async pullImage(image, onLog = () => {}) {
    try {
      await run('docker', ['pull', image], { onLine: (level, line) => { if (line.trim()) onLog('info', line); } });
    } catch (err) {
      const detail = String(err.message || '');
      if (/unauthorized|denied|authentication required/i.test(detail)) {
        throw new Error(`Could not pull ${image}: the registry refused access. Only public images are supported right now.`);
      }
      if (/not found|manifest unknown|no such|repository does not exist/i.test(detail)) {
        throw new Error(`Could not pull ${image}: that image or tag does not exist. Check the name and tag.`);
      }
      throw new Error(`Could not pull ${image}: ${detail.split('\n').pop() || 'unknown error'}`);
    }
  }

  /** Apply a service's current CPU/memory limits to its running container (`docker update`). */
  async applyResourceLimits(serviceId) {
    const info = this.processes.get(serviceId);
    if (!info?.name || info.kind === 'compose') return;
    const settings = queryOne('SELECT cpu_limit, memory_limit_mb FROM service_settings WHERE service_id = ?', serviceId) || {};
    const { cpus, memoryMb } = effectiveLimits(settings);
    // Memory and swap are set together so the new ceiling is a real one.
    await run('docker', ['update', '--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`, '--cpus', String(cpus), info.name]);
  }

  async refreshPrivateAlias(serviceId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    const info = this.processes.get(serviceId);
    if (!service || !info) return;
    await this.attachPrivate(service, info, () => (info.kind === 'compose' ? attachByLabel(service, info.composeService) : attachToPrivateNetwork(service, info.name)));
  }

  async startComposeService(serviceId, deploymentId, { cwd, composePath, onLog } = {}) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', serviceId) || {};
    const networking = queryOne('SELECT * FROM service_networking WHERE service_id = ?', serviceId) || {};
    if (!service || !composePath) throw new Error('Compose deployment is missing its service or YAML file');
    const doc = parseDocument(fs.readFileSync(composePath, 'utf8'));
    if (doc.errors.length) throw new Error(`Invalid Compose YAML: ${doc.errors[0].message}`);
    const definition = doc.toJS() || {};
    const entries = Object.entries(definition.services || {});
    if (!entries.length) throw new Error('Compose YAML must define at least one service');
    const requested = definition['x-morline']?.service;
    const selected = requested && definition.services[requested] ? requested
      : entries.length === 1 ? entries[0][0]
      : entries.find(([, item]) => item?.labels?.['morline.public'] === 'true' || item?.labels?.['morline.public'] === true)?.[0]
        || entries.find(([, item]) => item?.ports)?.[0];
    if (!selected) throw new Error('Compose YAML needs x-morline.service, a morline.public label, or a published-port service');

    await this.ensureNetwork();
    await this.stopService(serviceId, false);
    const targetPort = Number(networking.target_port || service.port || 3000);
    const envFile = this.writeEnvFile(serviceId, { ...this.variables(service.environment_id, serviceId), ...udpEnv(serviceId), PORT: String(targetPort), NODE_ENV: 'production' });
    const alias = containerName(serviceId);
    const project = `morline-${safeName(serviceId)}`;
    const overridePath = path.join(APPS_DIR, serviceId, '.morline', 'compose.runtime.yml');
    const publishedPorts = [...(networking.tcp_proxy_port ? [`${networking.tcp_proxy_port}:${targetPort}`] : []), ...udpPublishSpecs(serviceId)];
    const override = {
      services: Object.fromEntries(entries.map(([name]) => [name, {
        env_file: [hostWorkspacePath(envFile)],
        networks: { [NETWORK]: { aliases: name === selected ? [alias] : [] } },
        ...(name === selected && publishedPorts.length ? { ports: publishedPorts } : {}),
        labels: { 'morline.service_id': serviceId, 'morline.deployment_id': deploymentId }
      }])),
      networks: { [NETWORK]: { external: true, name: NETWORK } }
    };
    fs.writeFileSync(overridePath, JSON.stringify(override, null, 2), { mode: 0o600 });
    const hostCompose = hostWorkspacePath(composePath);
    const hostOverride = hostWorkspacePath(overridePath);
    const log = (level, line) => onLog?.(level, line);
    await run('docker', ['compose', '--project-name', project, '-f', hostCompose, '-f', hostOverride, 'up', '--build', '-d'], { cwd, onLine: log });
    execute('UPDATE services SET port = ? WHERE id = ?', targetPort, serviceId);
    const info = { serviceId, deploymentId, name: alias, port: targetPort, environmentId: service.environment_id, kind: 'compose', project, hostCompose, hostOverride, composeService: selected };
    this.processes.set(serviceId, info);
    await this.attachPrivate(service, info, () => attachByLabel(service, selected));
    this.pollHealthCheck(serviceId, deploymentId, this.endpoint(serviceId, targetPort), settings.healthcheck_path || '/', settings.healthcheck_timeout_sec || 30);
    return info;
  }

  variables(environmentId, serviceId) {
    const environmentRows = queryAll("SELECT key, value FROM variables WHERE scope_type = 'environment' AND scope_id = ?", environmentId);
    const serviceRows = queryAll("SELECT key, value FROM variables WHERE scope_type = 'service' AND scope_id = ?", serviceId);
    return Object.fromEntries([...environmentRows, ...serviceRows].map((row) => [row.key, String(row.value ?? '')]));
  }

  writeEnvFile(serviceId, variables) {
    const dir = path.join(APPS_DIR, serviceId, '.morline');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'container.env');
    const encode = (value) => String(value).replace(/\n/g, '\\n');
    fs.writeFileSync(file, Object.entries(variables).map(([key, value]) => `${key}=${encode(value)}`).join('\n') + '\n', { mode: 0o600 });
    return file;
  }

  followLogs(service, info) {
    const child = spawn('docker', ['logs', '--follow', '--tail', '0', info.name], { stdio: ['ignore', 'pipe', 'pipe'] });
    info.logChild = child;
    const capture = (stream, streamName) => {
      const classify = makeLevelClassifier();
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const message of lines.filter(Boolean)) this.log(service, info, classify(message), message, { source: 'container', stream: streamName });
      });
    };
    capture(child.stdout, 'stdout'); capture(child.stderr, 'stderr');
  }

  log(service, info, level, message, extra = {}) {
    logManager.appendLog({
      deploymentId: info.deploymentId, serviceId: service.id, serviceName: service.name, environmentId: service.environment_id,
      level, message, phase: 'deploy',
      source: 'platform', container: info.name || null, replicaId: `${service.id}-0`,
      ...extra
    });
  }

  // 'http' = answered HTTP, 'tcp' = port open but not speaking HTTP (databases etc.), 'down' = nothing there.
  probe(endpoint, healthPath) {
    return new Promise((resolve) => {
      const req = http.get({ host: endpoint.host, port: endpoint.port, path: healthPath, timeout: 1500 }, (res) => {
        res.resume();
        resolve({ state: 'http', status: res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); resolve({ state: 'down' }); });
      req.on('error', (err) => resolve(
        ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT'].includes(err.code)
          ? { state: 'down' } : { state: 'tcp' }
      ));
    });
  }

  tcpOpen(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  // Ports the image declares with EXPOSE (e.g. 5432 for Postgres images).
  async exposedPorts(image) {
    if (!image) return [];
    try {
      let out = '';
      await run('docker', ['image', 'inspect', '-f', '{{json .Config.ExposedPorts}}', image], { onLine: (_, line) => { out += line; } });
      return Object.keys(JSON.parse(out.trim() || 'null') || {}).map((k) => parseInt(k, 10)).filter(Boolean);
    } catch {
      return [];
    }
  }

  async containerState(name) {
    try {
      let out = '';
      await run('docker', ['inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}', name], { onLine: (_, line) => { out += line; } });
      const [status, exitCode] = out.trim().split('|');
      return { status, exitCode };
    } catch {
      return null;
    }
  }

  // Every deployment that reaches 'deploying' now ends in 'active' or 'failed'. It can no
  // longer sit there silently when the app is non-HTTP, slow, or never listens.
  pollHealthCheck(serviceId, deploymentId, endpoint, healthPath, timeoutSec) {
    const seconds = Math.max(Number(timeoutSec) || 30, 30);
    const deadline = Date.now() + seconds * 1000;
    let lastStatus = null;
    // A newer deployment of the same service cancels this loop.
    const current = () => {
      const info = this.processes.get(serviceId);
      return info && info.deploymentId === deploymentId ? info : null;
    };
    const check = async () => {
      const info = current();
      if (!info) return;
      if (info.kind !== 'compose') {
        const state = await this.containerState(info.name);
        if (!current()) return;
        if (state && (state.status === 'exited' || state.status === 'dead')) {
          return this.markFailed(serviceId, deploymentId, `Container exited with code ${state.exitCode} before becoming healthy. Check the logs above for the cause.`);
        }
      }
      const result = await this.probe(endpoint, healthPath);
      if (!current()) return;
      if (result.state === 'tcp') {
        return this.markHealthy(serviceId, deploymentId, `Port ${endpoint.port} is accepting connections (non-HTTP service)`);
      }
      if (result.state === 'http') {
        if (result.status < 500) return this.markHealthy(serviceId, deploymentId);
        lastStatus = result.status;
      }
      if (Date.now() < deadline) return void setTimeout(check, 800);
      if (lastStatus) {
        return this.markHealthy(serviceId, deploymentId,
          `Healthcheck ${healthPath} kept returning ${lastStatus}; marked online because the port is serving traffic`, 'warn');
      }
      // The configured port may simply be wrong (it defaults to 3000 for every service).
      // If the image declares a port that is accepting connections, use that instead of
      // failing a service that is actually running fine.
      for (const port of await this.exposedPorts(info.image)) {
        if (port === endpoint.port || !(await this.tcpOpen(endpoint.host, port))) continue;
        if (!current()) return;
        execute('UPDATE service_networking SET target_port = ? WHERE service_id = ?', port, serviceId);
        execute('UPDATE services SET port = ? WHERE id = ?', port, serviceId);
        info.port = port;
        return this.markHealthy(serviceId, deploymentId,
          `Nothing answered on port ${endpoint.port}, but the image exposes port ${port} and it is accepting connections. Target port updated to ${port}.`, 'warn');
      }
      this.markFailed(serviceId, deploymentId,
        `Nothing started listening on port ${endpoint.port} within ${seconds}s. Make sure the app listens on 0.0.0.0 and uses the PORT env var, or set the target port in Settings.`);
    };
    setTimeout(check, 500);
  }

  // After a service is up, notice when its container later dies (and when it comes back).
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkRunning().catch((err) => console.warn('[Watchdog]', err.message)), 30_000);
    this.watchdog.unref();
  }

  async checkRunning() {
    for (const [serviceId, info] of this.processes) {
      if (info.kind === 'compose') continue;
      const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
      if (!service) continue;
      const state = await this.containerState(info.name);
      if (!state) continue;
      const at = new Date().toISOString();
      const emit = (type, data) => eventBus.emitEnvironmentEvent(service.environment_id, { type, at, actorId: null, canvasRevision: null, data });

      if ((state.status === 'exited' || state.status === 'dead') && service.status === 'online') {
        execute("UPDATE services SET status = 'crashed' WHERE id = ?", serviceId);
        execute("UPDATE deployments SET state = 'crashed' WHERE id = ? AND state = 'active'", info.deploymentId);
        this.log(service, info, 'error', `[Deploy] The container stopped unexpectedly (exit code ${state.exitCode})`);
        emit('deployment.updated', { id: info.deploymentId, state: 'crashed' });
        emit('service.status', { id: serviceId, status: 'crashed' });
        const projectId = projectOfEnvironment(service.environment_id);
        notify(projectId ? adminsOfProject(projectId) : [], {
          type: 'service_crashed', title: `${service.name} crashed`,
          body: `The service stopped unexpectedly (exit code ${state.exitCode}). Open it to see the logs.`,
          projectId, targetUrl: projectLink(projectId), dedupeKey: new Date(Date.now() - 3600_000).toISOString()
        });
      } else if (state.status === 'running' && service.status === 'crashed' && service.active_deployment_id === info.deploymentId) {
        execute("UPDATE services SET status = 'online' WHERE id = ?", serviceId);
        execute("UPDATE deployments SET state = 'active' WHERE id = ? AND state = 'crashed'", info.deploymentId);
        emit('deployment.updated', { id: info.deploymentId, state: 'active' });
        emit('service.status', { id: serviceId, status: 'online' });
      }
    }
  }

  markHealthy(serviceId, deploymentId, note = null, level = 'info') {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    const deployment = queryOne('SELECT state FROM deployments WHERE id = ?', deploymentId);
    if (!service || !deployment || !['deploying', 'active'].includes(deployment.state)) return;
    const firstTime = deployment.state === 'deploying';
    const at = new Date().toISOString();
    execute('UPDATE services SET status = ?, active_deployment_id = ?, building_deployment_id = NULL WHERE id = ?', 'online', deploymentId, serviceId);
    execute('UPDATE deployments SET state = ?, finished_at = ? WHERE id = ?', 'active', at, deploymentId);
    // The deployment this one replaces is now retired.
    const replaced = queryAll("SELECT id FROM deployments WHERE service_id = ? AND state = 'active' AND id != ?", serviceId, deploymentId);
    for (const old of replaced) {
      execute('UPDATE deployments SET state = ? WHERE id = ?', 'removed', old.id);
      eventBus.emitEnvironmentEvent(service.environment_id, { type: 'deployment.updated', at, actorId: null, canvasRevision: null, data: { id: old.id, state: 'removed' } });
    }
    const info = this.processes.get(serviceId);
    if (note && info) this.log(service, info, level, `[Deploy] ${note}`);
    if (firstTime) {
      // Only the person who triggered it hears about a success; automatic redeploys stay quiet.
      const creator = queryOne('SELECT created_by FROM deployments WHERE id = ?', deploymentId)?.created_by;
      const projectId = projectOfEnvironment(service.environment_id);
      if (creator) notify(creator, { type: 'deploy_succeeded', title: `${service.name} is live`, body: 'Your deployment finished and is serving traffic.', projectId, targetUrl: projectLink(projectId) });
    }
    // The UI tracks deployment progress from deployment.updated events. Emitting only
    // service.status left the deployment card on "deploying" until a manual refresh.
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'deployment.updated', at, actorId: null, canvasRevision: null, data: { id: deploymentId, state: 'active' } });
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'service.status', at, actorId: null, canvasRevision: null, data: { id: serviceId, status: 'online' } });
  }

  markFailed(serviceId, deploymentId, summary) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    const deployment = queryOne('SELECT state FROM deployments WHERE id = ?', deploymentId);
    if (!service || !deployment || deployment.state !== 'deploying') return;
    const at = new Date().toISOString();
    execute('UPDATE deployments SET state = ?, finished_at = ?, error_summary = ? WHERE id = ?', 'failed', at, summary, deploymentId);
    execute('UPDATE services SET status = ?, building_deployment_id = NULL WHERE id = ?', 'crashed', serviceId);
    const info = this.processes.get(serviceId);
    if (info) this.log(service, info, 'error', `[Deploy] ${summary}`);
    const { users, projectId } = recipientsForDeployment(deploymentId);
    notify(users, { type: 'deploy_failed', title: `Deployment of ${service.name} failed`, body: summary.slice(0, 300), projectId, targetUrl: projectLink(projectId) });
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'deployment.updated', at, actorId: null, canvasRevision: null, data: { id: deploymentId, state: 'failed', errorSummary: summary } });
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'service.status', at, actorId: null, canvasRevision: null, data: { id: serviceId, status: 'crashed' } });
  }

  async stopService(serviceId, releasePort = true) {
    const info = this.processes.get(serviceId);
    info?.logChild?.kill('SIGTERM');
    if (info?.kind === 'compose' && info.hostCompose) {
      try { await run('docker', ['compose', '--project-name', info.project, '-f', info.hostCompose, '-f', info.hostOverride, 'down']); } catch {}
    } else if (info?.kind === 'compose') {
      // Adopted after a Morline restart: the compose files are not remembered, so remove by label.
      try {
        let ids = '';
        await run('docker', ['ps', '-aq', '--filter', `label=morline.service_id=${serviceId}`], { onLine: (_, line) => { ids += `${line} `; } });
        if (ids.trim()) await run('docker', ['rm', '--force', ...ids.trim().split(/\s+/)]);
      } catch {}
    } else {
      try { await run('docker', ['rm', '--force', containerName(serviceId)]); } catch {}
    }
    this.processes.delete(serviceId);
    if (releasePort) execute('UPDATE services SET port = NULL WHERE id = ?', serviceId);
  }

  /**
   * After Morline restarts it knows nothing about the containers it started. Walk the services that should be
   * running: adopt a container that is still up (reconnecting logs and private DNS), and start one that is gone
   * from its already-built image. Without this, every Morline deploy left all customer services offline.
   */
  async restoreServices() {
    const found = new Map();
    let listing = '';
    try {
      await run('docker', ['ps', '-a', '--filter', 'label=morline.service_id', '--format',
        '{{.Names}}|{{.State}}|{{.Label "morline.service_id"}}|{{.Label "morline.deployment_id"}}|{{.Label "com.docker.compose.service"}}'],
      { onLine: (_, line) => { listing += `${line}\n`; } });
    } catch (err) {
      console.warn('[Restore] Docker is not reachable, skipping:', err.message);
      return { adopted: 0, started: 0, failed: 0 };
    }
    for (const line of listing.split('\n').filter(Boolean)) {
      const [name, state, serviceId, deploymentId, composeService] = line.split('|');
      const previous = found.get(serviceId);
      if (!previous || (state === 'running' && previous.state !== 'running')) found.set(serviceId, { name, state, deploymentId, composeService });
    }

    const result = { adopted: 0, started: 0, failed: 0 };
    const wanted = queryAll("SELECT * FROM services WHERE status IN ('online', 'crashed') AND active_deployment_id IS NOT NULL");
    for (const service of wanted) {
      if (this.processes.has(service.id)) continue;
      const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', service.id) || {};
      const networking = queryOne('SELECT * FROM service_networking WHERE service_id = ?', service.id) || {};
      const targetPort = Number(networking.target_port || service.port || 3000);
      const container = found.get(service.id);
      try {
        if (container?.state === 'running') {
          const compose = Boolean(container.composeService);
          const info = {
            serviceId: service.id, deploymentId: container.deploymentId || service.active_deployment_id,
            name: compose ? containerName(service.id) : container.name, port: targetPort,
            environmentId: service.environment_id, ...(compose ? { kind: 'compose', project: `morline-${safeName(service.id)}`, composeService: container.composeService } : {})
          };
          this.processes.set(service.id, info);
          if (!compose) this.followLogs(service, info);
          await this.attachPrivate(service, info, () => (compose ? attachByLabel(service, container.composeService) : attachToPrivateNetwork(service, container.name)));
          result.adopted += 1;
        } else {
          await this.startService(service.id, service.active_deployment_id);
          result.started += 1;
        }
      } catch (err) {
        result.failed += 1;
        console.warn(`[Restore] ${service.name} (${service.id}): ${err.message}`);
        execute("UPDATE services SET status = 'crashed' WHERE id = ?", service.id);
        eventBus.emitEnvironmentEvent(service.environment_id, { type: 'service.status', at: new Date().toISOString(), actorId: null, canvasRevision: null, data: { id: service.id, status: 'crashed' } });
      }
    }
    console.log(`[Restore] ${result.adopted} adopted, ${result.started} started, ${result.failed} failed`);
    return result;
  }

  async restartService(serviceId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    const deploymentId = service?.active_deployment_id || service?.building_deployment_id;
    if (!deploymentId) throw new Error('Service has no active deployment to restart');
    return this.startService(serviceId, deploymentId);
  }

  isServiceRunning(serviceId) {
    return this.processes.has(serviceId);
  }
}

export const containerSupervisor = new ContainerSupervisor();
