import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { parseDocument } from 'yaml';
import { APPS_DIR, DATA_DIR } from '../config.js';
import { execute, queryAll, queryOne } from '../db/index.js';
import { logManager } from './log-manager.js';
import { eventBus } from './event-bus.js';

const NETWORK = 'morline-runtime';
const safeName = (value) => String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
const containerName = (serviceId) => `morline-${safeName(serviceId)}`;
const imageName = (serviceId, deploymentId) => `morline/${safeName(serviceId)}:${safeName(deploymentId)}`;

function hostWorkspacePath(cwd) {
  const hostData = process.env.HOST_DATA_DIR;
  if (!hostData || !cwd.startsWith(DATA_DIR + path.sep)) return cwd;
  return path.join(hostData, path.relative(DATA_DIR, cwd));
}

function prepareNixpacksDockerignore(cwd) {
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

function prepareNixpacksRuntime(cwd, runtime) {
  if (!runtime?.version || runtime.runtime !== 'node') return () => {};
  const file = path.join(cwd, 'nixpacks.toml');

  // ARCHITECTURAL CONTRACT — do NOT write nodejs_XX to nixpacks.toml.
  //
  // Nixpacks v1.41 maps each Node major to a DIFFERENT nixpkgs archive:
  //   Node 18/20 → ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7
  //   Node 22    → e6f23dc08d3624daab7094b701aa3954923c6bbb
  //   Node 24    → 23f9169c4ccce521379e602cc82ed873a1f1b52b
  //
  // Custom nixPkgs entries in nixpacks.toml are evaluated against the
  // DEFAULT nixpkgs archive (Node 18/20 archive). That archive does NOT
  // contain nodejs_24, nodejs_22_x, etc. Writing nodejs_24 there produces:
  //   "error: undefined variable 'nodejs_24'"
  //
  // The correct mechanism is NIXPACKS_NODE_VERSION (passed as an env var to
  // the nixpacks CLI). Nixpacks then selects the correct per-version archive
  // and adds the right nodejs_XX package entirely internally.
  //
  // For projects whose nixpacks.toml already declares nodejs_XX:
  //   Strip those tokens so Nixpacks' own Node selection takes over via
  //   NIXPACKS_NODE_VERSION. All other nixPkgs entries are left intact.
  //   The original file is restored after the build completes.
  if (!fs.existsSync(file)) {
    // No nixpacks.toml — NIXPACKS_NODE_VERSION env var alone is sufficient.
    return () => {};
  }

  const original = fs.readFileSync(file, 'utf8');
  // Strip nodejs_XX tokens from any nixPkgs array. Order matters:
  //   1. Remove "nodejs_XX", (when nodejs is not the last entry)
  //   2. Remove , "nodejs_XX"  (when nodejs is not the first entry)
  //   3. Remove "nodejs_XX"    (isolated — only entry in the array)
  let stripped = original
    .replace(/"nodejs[_-]\d[^"]*"\s*,\s*/g, '')
    .replace(/,\s*"nodejs[_-]\d[^"]*"/g, '')
    .replace(/"nodejs[_-]\d[^"]*"/g, '');
  if (stripped === original) return () => {};
  fs.writeFileSync(file, stripped);
  return () => fs.writeFileSync(file, original);
}

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

  async build(serviceId, deploymentId, { cwd, strategy, dockerfilePath, installCommand, startCommand, runtime, onLog }) {
    const image = imageName(serviceId, deploymentId);
    const log = (level, line) => onLog?.(level, line);
    if (strategy === 'dockerfile') {
      const file = dockerfilePath || 'Dockerfile';
      await run('docker', ['build', '--pull', '--tag', image, '--file', file, '.'], { cwd, onLine: log, stderrLevel: 'info' });
    } else {
      // The Nixpacks build image is a base image for generated Dockerfiles, not the
      // Nixpacks CLI. Run the packaged CLI directly against the mounted Docker daemon.
      // A workspace can retain ignored local dependencies after an earlier build.
      // Never copy those host-specific binaries into an OCI image.
      const restoreIgnore = prepareNixpacksDockerignore(cwd);
      const restoreRuntime = prepareNixpacksRuntime(cwd, runtime);
      try {
        const args = ['build', cwd, '--name', image];
        if (installCommand) args.push('--install-cmd', installCommand);
        // Settings is the one source of truth for an explicit start command.
        // Nixpacks' own config remains in effect when the field is blank.
        if (startCommand) args.push('--start-cmd', startCommand);
        // NIXPACKS_NODE_VERSION is the documented Nixpacks env var for selecting
        // the Node major. NODE_VERSION is a runtime variable inside the container
        // and has no effect on build-time package selection.
        const env = runtime?.runtime === 'node' && runtime.version ? { NIXPACKS_NODE_VERSION: runtime.version } : undefined;
        await run('nixpacks', args, { cwd, env, onLine: log, stderrLevel: 'info' });

        // Post-build verification: log actual Node version and platform inside
        // the built image. This confirms that NIXPACKS_NODE_VERSION propagated
        // correctly through the build toolchain. Uses a transient container that
        // is removed immediately after the check.
        if (runtime?.runtime === 'node') {
          try {
            const verifyScript = [
              `node --version`,
              `npm --version`,
              `node -p "process.platform + '/' + process.arch"`,
            ].join(' && ');
            const verifyArgs = ['run', '--rm', '--entrypoint', 'sh', image, '-c', verifyScript];
            await run('docker', verifyArgs, { onLine: (_, line) => log('info', `[Container verify] ${line}`) });
          } catch {
            // Non-fatal: some minimal images may not have sh in the default PATH
          }
        }
      } finally {
        restoreRuntime();
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
    const envFile = this.writeEnvFile(serviceId, { ...variables, PORT: String(targetPort), NODE_ENV: 'production' });
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
    if (settings.memory_limit_mb) args.push('--memory', `${settings.memory_limit_mb}m`);
    if (settings.cpu_limit) args.push('--cpus', String(settings.cpu_limit));
    args.push(image);

    await run('docker', args);
    execute('UPDATE services SET port = ? WHERE id = ?', targetPort, serviceId);
    const info = { serviceId, deploymentId, image, name, port: targetPort, environmentId: service.environment_id };
    this.processes.set(serviceId, info);
    this.followLogs(service, info);
    this.pollHealthCheck(serviceId, deploymentId, this.endpoint(serviceId, targetPort), settings.healthcheck_path || '/', settings.healthcheck_timeout_sec || 30);
    return info;
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
    const envFile = this.writeEnvFile(serviceId, { ...this.variables(service.environment_id, serviceId), PORT: String(targetPort), NODE_ENV: 'production' });
    const alias = containerName(serviceId);
    const project = `morline-${safeName(serviceId)}`;
    const overridePath = path.join(APPS_DIR, serviceId, '.morline', 'compose.runtime.yml');
    const override = {
      services: Object.fromEntries(entries.map(([name]) => [name, {
        env_file: [hostWorkspacePath(envFile)],
        networks: { [NETWORK]: { aliases: name === selected ? [alias] : [] } },
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
    const info = { serviceId, deploymentId, name: alias, port: targetPort, environmentId: service.environment_id, kind: 'compose', project, hostCompose, hostOverride };
    this.processes.set(serviceId, info);
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
    const capture = (stream, level) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const message of lines.filter(Boolean)) this.log(service, info, level, message);
      });
    };
    capture(child.stdout, 'info'); capture(child.stderr, 'error');
  }

  log(service, info, level, message) {
    logManager.appendLog({ deploymentId: info.deploymentId, serviceId: service.id, serviceName: service.name, environmentId: service.environment_id, level, message });
  }

  pollHealthCheck(serviceId, deploymentId, endpoint, healthPath, timeoutSec) {
    const deadline = Date.now() + Number(timeoutSec) * 1000;
    const check = () => {
      const info = this.processes.get(serviceId);
      if (!info) return;
      const req = http.get({ host: endpoint.host, port: endpoint.port, path: healthPath, timeout: 1500 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 500) return this.markHealthy(serviceId, deploymentId);
        if (Date.now() < deadline) setTimeout(check, 800);
      });
      req.on('error', () => Date.now() < deadline && setTimeout(check, 800));
      req.on('timeout', () => req.destroy());
    };
    setTimeout(check, 500);
  }

  markHealthy(serviceId, deploymentId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) return;
    execute('UPDATE services SET status = ?, active_deployment_id = ?, building_deployment_id = NULL WHERE id = ?', 'online', deploymentId, serviceId);
    execute('UPDATE deployments SET state = ?, finished_at = ? WHERE id = ?', 'active', new Date().toISOString(), deploymentId);
    eventBus.emitEnvironmentEvent(service.environment_id, { type: 'service.status', at: new Date().toISOString(), actorId: null, canvasRevision: null, data: { id: serviceId, status: 'online' } });
  }

  async stopService(serviceId, releasePort = true) {
    const info = this.processes.get(serviceId);
    info?.logChild?.kill('SIGTERM');
    if (info?.kind === 'compose') {
      try { await run('docker', ['compose', '--project-name', info.project, '-f', info.hostCompose, '-f', info.hostOverride, 'down']); } catch {}
    } else {
      try { await run('docker', ['rm', '--force', containerName(serviceId)]); } catch {}
    }
    this.processes.delete(serviceId);
    if (releasePort) execute('UPDATE services SET port = NULL WHERE id = ?', serviceId);
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
