import os from 'node:os';
import { queryAll, queryOne } from '../db/index.js';
import { defaultLimits } from './container-hardening.js';
import { AppError } from '../middleware/error-handler.js';

export const MIN_CPU = 0.1;
export const MIN_MEMORY_MB = 128;

/**
 * Only services that hold, or are about to take, a container count against the host. Stopped,
 * sleeping, crashed (exited) and never-deployed services give their share back; starting one of
 * them again has to fit in whatever is free at that moment.
 */
export const HOLDING_STATUSES = ['online', 'running', 'deploying', 'building'];

const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const nonNegative = (v) => { if (v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** What the host can hand out to services: total capacity minus what Morline and the OS keep. */
export function hostCapacity(env = process.env) {
  const totalCpus = positive(env.MORLINE_CAPACITY_CPUS) ?? os.cpus().length;
  const totalMemoryMb = positive(env.MORLINE_CAPACITY_MEMORY_MB) ?? Math.floor(os.totalmem() / 1024 / 1024);
  const reservedCpus = nonNegative(env.MORLINE_RESERVED_CPUS) ?? Math.min(0.5, totalCpus / 4);
  const reservedMemoryMb = nonNegative(env.MORLINE_RESERVED_MEMORY_MB) ?? Math.min(Math.max(768, Math.round(totalMemoryMb * 0.12)), Math.round(totalMemoryMb / 2));
  return { totalCpus, totalMemoryMb, reservedCpus, reservedMemoryMb };
}

/** The limits a service actually runs with (its own, else the platform default). */
export function effectiveLimits(settings = {}, env = process.env) {
  const d = defaultLimits(env);
  return { cpus: positive(settings.cpu_limit) ?? d.cpus, memoryMb: positive(settings.memory_limit_mb) ?? d.memoryMb };
}

/** Pure core: `rows` are `{ id, status, cpu_limit, memory_limit_mb }` for every service. */
export function computeCapacity(rows, { serviceId = null, env = process.env } = {}) {
  const host = hostCapacity(env);
  let cpu = 0;
  let memory = 0;
  for (const r of rows) {
    if (r.id === serviceId || !HOLDING_STATUSES.includes(r.status)) continue;
    const l = effectiveLimits(r, env);
    cpu += l.cpus;
    memory += l.memoryMb;
  }
  const usableCpus = Math.max(0, host.totalCpus - host.reservedCpus);
  const usableMemoryMb = Math.max(0, host.totalMemoryMb - host.reservedMemoryMb);
  return {
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
}

const allServiceRows = () => queryAll(`
  SELECT s.id, s.status, ss.cpu_limit, ss.memory_limit_mb
  FROM services s LEFT JOIN service_settings ss ON ss.service_id = s.id
`);

/**
 * Remaining infrastructure. `serviceId` is excluded from "allocated" so a slider can offer
 * that service's current allocation back to it.
 */
export function capacityReport({ serviceId = null, env = process.env } = {}) {
  const report = computeCapacity(allServiceRows(), { serviceId, env });
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

const fmtMem = (mb) => (mb >= 1024 ? `${Number((mb / 1024).toFixed(2))} GB` : `${Math.round(mb)} MB`);

/** Why this service can't be started right now, or null when it fits. Pure. */
export function startProblem(rows, service, { env = process.env } = {}) {
  const need = effectiveLimits(service, env);
  const free = computeCapacity(rows, { serviceId: service.id, env });
  const short = [];
  if (need.cpus > free.cpu.available + 1e-9) short.push(`${round(need.cpus)} vCPU (${free.cpu.available} free)`);
  if (need.memoryMb > free.memory.availableMb) short.push(`${fmtMem(need.memoryMb)} of memory (${fmtMem(free.memory.availableMb)} free)`);
  return short.length ? `Not enough capacity on this host to start this service: it needs ${short.join(' and ')}. Stop another service or lower a CPU or memory limit, then try again.` : null;
}

/** Throws a 409 `insufficient_capacity` when starting `serviceId` would oversubscribe the host. */
export function assertCanRun(serviceId, env = process.env) {
  const row = allServiceRows().find((r) => r.id === serviceId);
  if (!row) return;
  const problem = startProblem(allServiceRows(), row, { env });
  if (problem) throw new AppError(problem, 409, 'insufficient_capacity');
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
