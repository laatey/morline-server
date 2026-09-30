import { EventEmitter } from 'node:events';

class AppEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  emitEnvironmentEvent(environmentId, event) {
    this.emit(`environment:${environmentId}`, event);
  }

  emitDeploymentLog(deploymentId, logLine) {
    this.emit(`deployment:${deploymentId}:log`, logLine);
  }

  emitEnvironmentLog(environmentId, logLine) {
    this.emit(`environment:${environmentId}:log`, logLine);
  }

  emitNotification(userId, notification) {
    this.emit(`user:${userId}:notification`, notification);
  }
}

export const eventBus = new AppEventBus();
