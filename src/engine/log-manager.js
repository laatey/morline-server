import crypto from 'node:crypto';
import { execute, queryAll } from '../db/index.js';
import { mapLogLine } from '../db/mappers.js';
import { eventBus } from './event-bus.js';

class LogManager {
  appendLog({ deploymentId, serviceId, serviceName, environmentId, replica = 0, level = 'info', message, attributes = null, phase = null, source = null, container = null, replicaId = null, stream = null }) {
    const id = `log_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const timestamp = new Date().toISOString();
    const merged = { ...(attributes || {}) };
    if (source) merged.source = source;
    if (container) merged.container = container;
    if (replicaId) merged.replicaId = replicaId;
    if (stream) merged.stream = stream;
    const attrsJson = Object.keys(merged).length ? JSON.stringify(merged) : null;

    try {
      execute(`
        INSERT INTO deployment_logs (id, deployment_id, service_id, service_name, environment_id, replica, level, message, attributes, phase, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, deploymentId, serviceId, serviceName, environmentId, replica, level, message, attrsJson, phase, timestamp);

      const logLine = mapLogLine({
        id, timestamp, service_id: serviceId, service_name: serviceName, deployment_id: deploymentId,
        replica, level, phase, message, attributes: attrsJson
      });

      eventBus.emitDeploymentLog(deploymentId, logLine);
      if (environmentId) {
        eventBus.emitEnvironmentLog(environmentId, logLine);
      }

      return logLine;
    } catch (err) {
      console.error('[LogManager] Error persisting log:', err.message);
      return null;
    }
  }

  /** The newest `limit` log lines for a service across its deployments, oldest first. */
  getServiceLogs(serviceId, { limit = 15 } = {}) {
    return queryAll(
      'SELECT level, message, timestamp FROM deployment_logs WHERE service_id = ? ORDER BY timestamp DESC LIMIT ?',
      serviceId, limit
    ).reverse();
  }

  getDeploymentLogs(deploymentId, { limit = 100, cursor = null, level = null, q = null, phase = null } = {}) {
    let sql = 'SELECT * FROM deployment_logs WHERE deployment_id = ?';
    const params = [deploymentId];

    if (phase) {
      sql += ' AND phase = ?';
      params.push(phase);
    }

    if (level && level.length > 0) {
      const placeholders = level.map(() => '?').join(',');
      sql += ` AND level IN (${placeholders})`;
      params.push(...level);
    }

    if (q) {
      sql += ' AND message LIKE ?';
      params.push(`%${q}%`);
    }

    if (cursor) {
      sql += ' AND timestamp < ?';
      params.push(cursor);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit + 1);

    const rows = queryAll(sql, ...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].timestamp : null;

    return {
      data: items.map(mapLogLine).reverse(),
      nextCursor,
      truncated: false
    };
  }

  getEnvironmentLogs(environmentId, { limit = 100, cursor = null, serviceId = null, level = null, q = null } = {}) {
    let sql = 'SELECT * FROM deployment_logs WHERE environment_id = ?';
    const params = [environmentId];

    if (serviceId && serviceId.length > 0) {
      const placeholders = serviceId.map(() => '?').join(',');
      sql += ` AND service_id IN (${placeholders})`;
      params.push(...serviceId);
    }

    if (level && level.length > 0) {
      const placeholders = level.map(() => '?').join(',');
      sql += ` AND level IN (${placeholders})`;
      params.push(...level);
    }

    if (q) {
      sql += ' AND message LIKE ?';
      params.push(`%${q}%`);
    }

    if (cursor) {
      sql += ' AND timestamp < ?';
      params.push(cursor);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit + 1);

    const rows = queryAll(sql, ...params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].timestamp : null;

    return {
      data: items.map(mapLogLine).reverse(),
      nextCursor,
      truncated: false
    };
  }
}

export const logManager = new LogManager();
