import { spawn, exec } from 'node:child_process';
import http from 'node:http';
import { execute, queryOne, queryAll } from '../db/index.js';
import { portManager } from './port-manager.js';
import { logManager } from './log-manager.js';
import { eventBus } from './event-bus.js';

class ProcessSupervisor {
  constructor() {
    this.processes = new Map(); // serviceId -> { child, pid, port, deploymentId, serviceId, environmentId, restartCount, intentionalStop }
    this.restartTimers = new Map();
  }

  async startService(serviceId, deploymentId, options = {}) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) throw new Error(`Service ${serviceId} not found`);

    const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', serviceId) || {};
    const deployment = queryOne('SELECT * FROM deployments WHERE id = ?', deploymentId);
    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);

    // Stop existing process if running
    await this.stopService(serviceId, false);

    const port = await portManager.allocatePort(serviceId);
    execute('UPDATE services SET port = ? WHERE id = ?', port, serviceId);

    // Fetch variables for service and environment
    const vars = queryAllVariables(service.environment_id, serviceId);
    const env = {
      ...process.env,
      ...vars,
      PORT: String(port),
      NODE_ENV: 'production'
    };

    const cwd = options.cwd || process.cwd();
    const command = options.command || settings.start_command || 'node server.js';

    logManager.appendLog({
      deploymentId,
      serviceId,
      serviceName: service.name,
      environmentId: service.environment_id,
      level: 'info',
      message: `Starting process on port ${port}: ${command}`
    });

    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true
    });

    const procInfo = {
      child,
      pid: child.pid,
      port,
      serviceId,
      deploymentId,
      environmentId: service.environment_id,
      serviceName: service.name,
      restartCount: options.restartCount || 0,
      intentionalStop: false,
      startTime: Date.now()
    };
    this.processes.set(serviceId, procInfo);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'info',
          message: line
        });
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        logManager.appendLog({
          deploymentId,
          serviceId,
          serviceName: service.name,
          environmentId: service.environment_id,
          level: 'error',
          message: line
        });
      }
    });

    child.on('close', async (code, signal) => {
      const info = this.processes.get(serviceId);
      this.processes.delete(serviceId);

      const msg = `Process exited with code ${code}, signal ${signal}`;
      logManager.appendLog({
        deploymentId,
        serviceId,
        serviceName: service.name,
        environmentId: service.environment_id,
        level: code === 0 ? 'info' : 'error',
        message: msg
      });

      if (info && !info.intentionalStop) {
        // Unexpected exit -> crash
        execute('UPDATE services SET status = ? WHERE id = ?', 'crashed', serviceId);
        execute('UPDATE deployments SET state = ?, finished_at = ? WHERE id = ?', 'crashed', new Date().toISOString(), deploymentId);

        eventBus.emitEnvironmentEvent(service.environment_id, {
          type: 'service.status',
          at: new Date().toISOString(),
          actorId: null,
          canvasRevision: null,
          data: { id: serviceId, status: 'crashed' }
        });

        // Restart policy check
        const policy = settings.restart_policy || 'on-failure';
        const shouldRestart = policy === 'always' || (policy === 'on-failure' && code !== 0);

        if (shouldRestart && (info.restartCount || 0) < 5) {
          const nextCount = (info.restartCount || 0) + 1;
          const backoffMs = Math.min(1000 * Math.pow(2, nextCount), 15000);
          logManager.appendLog({
            deploymentId,
            serviceId,
            serviceName: service.name,
            environmentId: service.environment_id,
            level: 'warn',
            message: `Restarting in ${backoffMs}ms (attempt ${nextCount}/5)...`
          });

          const timer = setTimeout(() => {
            this.startService(serviceId, deploymentId, { ...options, restartCount: nextCount });
          }, backoffMs);
          this.restartTimers.set(serviceId, timer);
        } else {
          portManager.releasePort(serviceId);
        }
      } else {
        portManager.releasePort(serviceId);
      }
    });

    // Start health check polling
    const healthPath = settings.healthcheck_path || '/';
    const timeoutSec = settings.healthcheck_timeout_sec || 30;
    this.pollHealthCheck(serviceId, deploymentId, port, healthPath, timeoutSec);

    return procInfo;
  }

  async pollHealthCheck(serviceId, deploymentId, port, path, timeoutSec) {
    const startTime = Date.now();
    const maxTime = startTime + timeoutSec * 1000;

    const check = () => {
      const procInfo = this.processes.get(serviceId);
      if (!procInfo || procInfo.intentionalStop) return;

      const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 500) {
          // Healthy!
          this.markServiceHealthy(serviceId, deploymentId);
        } else if (Date.now() < maxTime) {
          setTimeout(check, 800);
        } else {
          // Timeout
          this.markServiceHealthy(serviceId, deploymentId); // fallback mark online
        }
      });

      req.on('error', () => {
        if (Date.now() < maxTime) {
          setTimeout(check, 800);
        } else {
          // Fallback after timeout: if process is still alive, mark online
          const alive = this.processes.has(serviceId);
          if (alive) {
            this.markServiceHealthy(serviceId, deploymentId);
          }
        }
      });

      req.setTimeout(1500, () => {
        req.destroy();
      });
    };

    setTimeout(check, 500);
  }

  markServiceHealthy(serviceId, deploymentId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) return;

    execute('UPDATE services SET status = ?, active_deployment_id = ?, building_deployment_id = NULL WHERE id = ?', 'online', deploymentId, serviceId);
    execute('UPDATE deployments SET state = ?, finished_at = ? WHERE id = ?', 'active', new Date().toISOString(), deploymentId);

    logManager.appendLog({
      deploymentId,
      serviceId,
      serviceName: service.name,
      environmentId: service.environment_id,
      level: 'info',
      message: `Health check passed. Service is online on port ${service.port || ''}.`
    });

    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'service.status',
      at: new Date().toISOString(),
      actorId: null,
      canvasRevision: null,
      data: { id: serviceId, status: 'online' }
    });
    eventBus.emitEnvironmentEvent(service.environment_id, {
      type: 'deployment.updated',
      at: new Date().toISOString(),
      actorId: null,
      canvasRevision: null,
      data: { id: deploymentId, state: 'active' }
    });
  }

  async stopService(serviceId, releasePort = true) {
    if (this.restartTimers.has(serviceId)) {
      clearTimeout(this.restartTimers.get(serviceId));
      this.restartTimers.delete(serviceId);
    }

    const proc = this.processes.get(serviceId);
    if (!proc) {
      if (releasePort) portManager.releasePort(serviceId);
      return;
    }

    proc.intentionalStop = true;
    const pid = proc.pid;

    await new Promise((resolve) => {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${pid} /T /F`, () => {
          resolve();
        });
      } else {
        try {
          proc.child.kill('SIGTERM');
        } catch (e) {}
        setTimeout(() => {
          try {
            proc.child.kill('SIGKILL');
          } catch (e) {}
          resolve();
        }, 1000);
      }
    });

    this.processes.delete(serviceId);
    if (releasePort) {
      portManager.releasePort(serviceId);
    }
  }

  async restartService(serviceId) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) throw new Error(`Service ${serviceId} not found`);

    const deploymentId = service.active_deployment_id || service.building_deployment_id;
    if (!deploymentId) {
      throw new Error(`Service ${serviceId} has no active deployment to restart`);
    }

    await this.stopService(serviceId, false);
    return this.startService(serviceId, deploymentId);
  }

  isServiceRunning(serviceId) {
    return this.processes.has(serviceId);
  }

  getRunningInfo(serviceId) {
    return this.processes.get(serviceId) || null;
  }
}

function queryAllVariables(environmentId, serviceId) {
  const envVars = queryAll('SELECT key, value FROM variables WHERE scope_type = ? AND scope_id = ?', 'environment', environmentId);
  const srvVars = queryAll('SELECT key, value FROM variables WHERE scope_type = ? AND scope_id = ?', 'service', serviceId);

  const map = {};
  for (const v of envVars) {
    map[v.key] = v.value;
  }
  for (const v of srvVars) {
    map[v.key] = v.value;
  }
  return map;
}

export const processSupervisor = new ProcessSupervisor();
