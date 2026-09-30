import net from 'node:net';
import { SERVICE_PORT_MIN, SERVICE_PORT_MAX } from '../config.js';

class PortManager {
  constructor() {
    this.servicePorts = new Map(); // serviceId -> port
    this.allocatedPorts = new Set();
  }

  async isPortFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => {
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
  }

  async allocatePort(serviceId) {
    if (this.servicePorts.has(serviceId)) {
      const existing = this.servicePorts.get(serviceId);
      if (await this.isPortFree(existing)) {
        return existing;
      }
      this.releasePort(serviceId);
    }

    for (let port = SERVICE_PORT_MIN; port <= SERVICE_PORT_MAX; port++) {
      if (this.allocatedPorts.has(port)) continue;
      const free = await this.isPortFree(port);
      if (free) {
        this.allocatedPorts.add(port);
        this.servicePorts.set(serviceId, port);
        return port;
      }
    }

    throw new Error('No available ports in range ' + SERVICE_PORT_MIN + '-' + SERVICE_PORT_MAX);
  }

  getPort(serviceId) {
    return this.servicePorts.get(serviceId) || null;
  }

  releasePort(serviceId) {
    const port = this.servicePorts.get(serviceId);
    if (port) {
      this.allocatedPorts.delete(port);
      this.servicePorts.delete(serviceId);
    }
  }
}

export const portManager = new PortManager();
