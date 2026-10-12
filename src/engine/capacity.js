import os from 'node:os';
import { queryAll, queryOne } from '../db/index.js';
import { defaultLimits } from './container-hardening.js';

export const MIN_CPU = 0.1;
export const MIN_MEMORY_MB = 128;

const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** What the host can hand out to services: total capacity minus what Morline and the OS keep. */
export function hostCapacity(env = process.env) {
  const totalCpus = positive(env.MORLINE_CAPACITY_CPUS) ?? os.cpus().length;
  const totalMemoryMb = positive(env.MORLINE_CAPACITY_MEMORY_MB) ?? Math.floor(os.totalmem() / 1024 / 1024);
  const reservedCpus = positive(env.MORLINE_RESERVED_CPUS) ?? Math.min(0.5, totalCpus / 4);
  const reservedMemoryMb = positive(env.MORLINE_RESERVED_MEMORY_MB) ?? Math.min(Math.max(768, Math.round(totalMemoryMb * 0.12)), Math.round(totalMemoryMb / 2));
  return { totalCpus, totalMemoryMb, reservedCpus, reservedMemoryMb };
}

/** The limits a service actually runs with (its own, else the platform default). */
export function effectiveLimits(settings = {}, env = process.env) {
  const d = defaultLimits(env);
  return { cpus: positive(settings.cpu_limit) ?? d.cpus, memoryMb: positive(settings.memory_limit_mb) ?? d.memoryMb };
}

/**
 * Remaining infrastructure. `serviceId` is excluded from "allocated" so a slider can offer
 * that service's current allocation back to itself.
 */
export function capacityReport({ serviceId = null, env = process.env } = {}) {
  const host = hostCapacity(env);
  const rows = queryAll(`
    SELECT s.id, ss.cpu_limit, ss.memory_limit_mb
    FROM services s LEFT JOIN service_settings ss ON ss.service_id = s.id
    WHERE s.status NOT IN ('stopped')
  `);
  let cpu = 0;
  let memory = 0;
  for (const r of rows) {
    if (r.id === serviceId) continue;
    const l = effectiveLimits(r, env);
    cpu += l.cpus;
    memory += l.memoryMb;
  }
  const usableCpus = Math.max(0, host.totalCpus - host.reservedCpus);
  const usableMemoryMb = Math.max(0, host.totalMemoryMb - host.reservedMemoryMb);

  const report = {
    cpu: {
      total: round(host.totalCpus), reserved: round(host.reservedCpus),
      allocated: round(cpu), available: round(Math.max(0, usableCpus - cpu)), min: MIN_CPU, step: 0.1
    },
    memory: {
      totalMb: host.totalMemoryMb, reservedMb: host.reservedMemoryMb,
      allocatedMb: Math.round(memory), availableMb: Math.max(0, Math.floor(usableMemoryMb - memory)), minMb: MIN_MEMORY_MB, stepMb: 64
    },
    defaults: defaultLimits(env)
  };
  if (serviceId) {
    const current = queryOne('SELECT cpu_limit, memory_limit_mb FROM service_settings WHERE service_id = ?', serviceId) || {};
    const eff = effectiveLimits(current, env);
    report.service = {
      cpuLimit: positive(current.cpu_limit), memoryLimitMb: positive(current.memory_limit_mb),
      effectiveCpus: eff.cpus, effectiveMemoryMb: eff.memoryMb,
      maxCpus: round(report.cpu.available), maxMemoryMb: report.memory.availableMb
    };
  }
  return report;
}

/** Returns an error message when the requested limits don't fit, else null. */
export function validateLimits({ serviceId, cpus, memoryMb, env = process.env }) {
  const report = capacityReport({ serviceId, env });
  if (cpus != null) {
    if (!Number.isFinite(cpus) || cpus < MIN_CPU) return `CPU must be at least ${MIN_CPU} vCPU`;
    if (cpus > report.cpu.available + 1e-9) return `Only ${report.cpu.available} vCPU left on this host for this service`;
  }
  if (memoryMb != null) {
    if (!Number.isInteger(memoryMb) || memoryMb < MIN_MEMORY_MB) return `Memory must be at least ${MIN_MEMORY_MB} MB`;
    if (memoryMb > report.memory.availableMb) return `Only ${report.memory.availableMb} MB of memory left on this host for this service`;
  }
  return null;
}
