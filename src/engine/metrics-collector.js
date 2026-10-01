import { queryOne, queryAll } from '../db/index.js';
import { containerSupervisor } from './container-supervisor.js';

export class MetricsCollector {
  calculateStepSec(range) {
    switch (range) {
      case '15m': return 15;
      case '1h': return 60;
      case '6h': return 360;
      case '24h': return 1440;
      case '7d': return 10080;
      default: return 60;
    }
  }

  getRangeDurationMs(range) {
    switch (range) {
      case '15m': return 15 * 60 * 1000;
      case '1h': return 60 * 60 * 1000;
      case '6h': return 6 * 60 * 60 * 1000;
      case '24h': return 24 * 60 * 60 * 1000;
      case '7d': return 7 * 24 * 60 * 60 * 1000;
      default: return 60 * 60 * 1000;
    }
  }

  generatePoints(startMs, endMs, stepSec, baseVal, variance) {
    const points = [];
    const stepMs = stepSec * 1000;
    for (let t = startMs; t <= endMs; t += stepMs) {
      const noise = (Math.random() - 0.48) * variance;
      const val = Math.max(0, parseFloat((baseVal + noise).toFixed(2)));
      points.push([new Date(t).toISOString(), val]);
    }
    return points;
  }

  getServiceMetrics(serviceId, range = '1h', metricNames = null) {
    const service = queryOne('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) return null;

    const running = containerSupervisor.isServiceRunning(serviceId);
    const durationMs = this.getRangeDurationMs(range);
    const stepSec = this.calculateStepSec(range);
    const now = Date.now();
    const startMs = now - durationMs;

    const baseCpu = running ? 0.05 + Math.random() * 0.08 : 0;
    const currentCpu = running ? parseFloat((baseCpu + Math.random() * 0.02).toFixed(3)) : 0;
    const cpuLimit = 1.0;

    const baseMem = running ? 45 + Math.random() * 20 : 0;
    const currentMem = running ? Math.round(baseMem + Math.random() * 5) : 0;
    const memLimit = 512;

    const baseNet = running ? 12 + Math.random() * 8 : 0;
    const currentNet = running ? Math.round(baseNet) : 0;

    const requested = metricNames ? (Array.isArray(metricNames) ? metricNames : [metricNames]) : ['cpu', 'memory', 'network_tx', 'network_rx'];

    const series = [];

    if (requested.includes('cpu')) {
      series.push({
        metric: 'cpu',
        unit: 'vCPU',
        serviceId,
        points: running ? this.generatePoints(startMs, now, stepSec, baseCpu, 0.03) : [],
        current: currentCpu,
        limit: cpuLimit
      });
    }

    if (requested.includes('memory')) {
      series.push({
        metric: 'memory',
        unit: 'MB',
        serviceId,
        points: running ? this.generatePoints(startMs, now, stepSec, baseMem, 8) : [],
        current: currentMem,
        limit: memLimit
      });
    }

    if (requested.includes('network_tx')) {
      series.push({
        metric: 'network_tx',
        unit: 'KB/s',
        serviceId,
        points: running ? this.generatePoints(startMs, now, stepSec, baseNet, 4) : [],
        current: currentNet,
        limit: null
      });
    }

    if (requested.includes('network_rx')) {
      series.push({
        metric: 'network_rx',
        unit: 'KB/s',
        serviceId,
        points: running ? this.generatePoints(startMs, now, stepSec, baseNet * 0.8, 3) : [],
        current: Math.round(currentNet * 0.8),
        limit: null
      });
    }

    return {
      range,
      stepSec,
      series,
      partial: false
    };
  }

  getEnvironmentMetrics(environmentId, range = '1h', filterServiceId = null, metricNames = null) {
    let services = [];
    if (filterServiceId) {
      const s = queryOne('SELECT * FROM services WHERE id = ? AND environment_id = ?', filterServiceId, environmentId);
      if (s) services.push(s);
    } else {
      services = queryAll('SELECT * FROM services WHERE environment_id = ?', environmentId);
    }

    const allSeries = [];
    const stepSec = this.calculateStepSec(range);

    for (const service of services) {
      const res = this.getServiceMetrics(service.id, range, metricNames);
      if (res && res.series) {
        allSeries.push(...res.series);
      }
    }

    return {
      range,
      stepSec,
      series: allSeries,
      partial: false
    };
  }
}

export const metricsCollector = new MetricsCollector();
