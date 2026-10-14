import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { execute, queryAll, queryOne } from '../db/index.js';
import { notify, adminsOfProject, projectLink } from '../services/notifications.js';
import { DATA_DIR } from '../config.js';
import { containerName } from './container-supervisor.js';

/**
 * Usage-based pricing. Every minute this samples what each running container is actually using
 * (CPU, memory), how much data its volumes hold, and how many bytes the reverse proxy sent for it,
 * and adds that to the current month. Cost is then rate x measured usage, so an idle service costs
 * almost nothing and a stopped one costs nothing. (The old figure was a flat $2.50 per service.)
 */

const num = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== undefined ? Number(process.env[name]) : fallback);
export const RATES = {
  cpuPerVcpuHour: num('PRICE_CPU_VCPU_HOUR', 0.0278), // about $20 per vCPU-month
  memoryPerGbHour: num('PRICE_MEMORY_GB_HOUR', 0.0139), // about $10 per GB-month
  volumePerGbMonth: num('PRICE_VOLUME_GB_MONTH', 0.15),
  egressPerGb: num('PRICE_EGRESS_GB', 0.05)
};

const TICK_MS = 60_000;
const VOLUME_EVERY_TICKS = 5;
const HOURS_PER_MONTH = 730;
const GB = 1024 ** 3;

const live = new Map(); // serviceId -> latest sample, for the "current usage" shown on a service
const egress = new Map(); // serviceId -> { bytes, requests } waiting to be written
const volumeBytes = new Map(); // serviceId -> last measured size
let lastTick = Date.now();
let ticks = 0;
let timer = null;

export const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);

// ---------------------------------------------------------------- inputs

/** Called by the reverse proxy for every response it forwards. */
export function recordTraffic(serviceId, bytes) {
  const entry = egress.get(serviceId) || { bytes: 0, requests: 0 };
  entry.bytes += bytes;
  entry.requests += 1;
  egress.set(serviceId, entry);
}

export function liveUsage(serviceId) {
  const sample = live.get(serviceId);
  if (!sample || Date.now() - sample.at > 3 * TICK_MS) return null;
  return { cpuPercent: sample.cpuPercent, memoryMb: sample.memoryMb, memoryLimitMb: sample.memoryLimitMb, bandwidthMb24h: 0 };
}

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
export function parseBytes(text) {
  const m = /^([\d.]+)\s*([a-z]+)$/i.exec(String(text).trim());
  return m ? Number(m[1]) * (UNITS[m[2].toUpperCase()] || 1) : 0;
}

function dockerStats() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timeout); resolve([]); });
    child.on('close', () => {
      clearTimeout(timeout);
      resolve(out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    });
  });
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? Number.parseInt(r.stdout, 10) * 1024 || 0 : 0;
}

// ---------------------------------------------------------------- the tick

function add(serviceId, month, columns) {
  execute(`
    INSERT INTO usage_monthly (service_id, month, cpu_seconds, memory_gb_seconds, volume_gb_seconds, egress_bytes, requests)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(service_id, month) DO UPDATE SET
      cpu_seconds = cpu_seconds + excluded.cpu_seconds,
      memory_gb_seconds = memory_gb_seconds + excluded.memory_gb_seconds,
      volume_gb_seconds = volume_gb_seconds + excluded.volume_gb_seconds,
      egress_bytes = egress_bytes + excluded.egress_bytes,
      requests = requests + excluded.requests
  `, serviceId, month, columns.cpu || 0, columns.mem || 0, columns.vol || 0, columns.bytes || 0, columns.requests || 0);
}

export async function tick(now = Date.now()) {
  // A paused or slow server must not bill the gap as if everything ran flat out.
  const seconds = Math.min(Math.max((now - lastTick) / 1000, 0), 300);
  lastTick = now;
  ticks += 1;
  const month = monthKey(new Date(now));

  const byContainer = new Map(queryAll('SELECT id FROM services').map((s) => [containerName(s.id), s.id]));
  for (const stat of await dockerStats()) {
    const serviceId = byContainer.get(String(stat.Name || '').replace(/^\//, ''));
    if (!serviceId) continue;
    const cpuPercent = Number.parseFloat(stat.CPUPerc) || 0;
    const [used, limit] = String(stat.MemUsage || '').split('/');
    const memBytes = parseBytes(used || '0');
    live.set(serviceId, { at: now, cpuPercent, memoryMb: Math.round(memBytes / 1e6), memoryLimitMb: Math.round(parseBytes(limit || '0') / 1e6) || 512 });
    add(serviceId, month, { cpu: (cpuPercent / 100) * seconds, mem: (memBytes / GB) * seconds });
  }

  if (ticks % VOLUME_EVERY_TICKS === 1) {
    const withVolumes = queryAll('SELECT DISTINCT service_id FROM volumes');
    for (const { service_id: id } of withVolumes) volumeBytes.set(id, directoryBytes(path.join(DATA_DIR, 'service-volumes', id)));
  }
  for (const [id, bytes] of volumeBytes) if (bytes) add(id, month, { vol: (bytes / GB) * seconds });

  for (const [id, entry] of egress) add(id, month, { bytes: entry.bytes, requests: entry.requests });
  egress.clear();

  if (ticks % 10 === 0) checkSpendLimits(new Date(now));
}

/** Warn at 80% of a project's monthly limit and again when it is reached. (The limit is not enforced.) */
export function checkSpendLimits(now = new Date()) {
  const monthStart = `${monthKey(now)}-01T00:00:00.000Z`;
  for (const project of queryAll('SELECT id, name, settings_spend_limit_usd AS limit_usd FROM projects WHERE settings_spend_limit_usd > 0')) {
    const { spentUsd } = projectUsage(project.id, now);
    const share = spentUsd / project.limit_usd;
    if (share < 0.8) continue;
    const reached = share >= 1;
    notify(adminsOfProject(project.id), {
      type: 'spend_limit',
      title: reached ? `${project.name} reached its spend limit` : `${project.name} is at 80% of its spend limit`,
      body: `$${spentUsd.toFixed(2)} of the $${Number(project.limit_usd).toFixed(2)} monthly limit has been used.`,
      projectId: project.id, targetUrl: projectLink(project.id), item: project.name, dedupeKey: monthStart
    });
  }
}

export function startMetering() {
  if (timer) return;
  lastTick = Date.now();
  timer = setInterval(() => tick().catch((err) => console.warn('[Usage] Sample failed:', err.message)), TICK_MS);
  timer.unref();
}

export function flushMetering() {
  for (const [id, entry] of egress) add(id, monthKey(), { bytes: entry.bytes, requests: entry.requests });
  egress.clear();
}

// ---------------------------------------------------------------- pricing

export function priceOf(row) {
  const cpuUsd = (row.cpu_seconds / 3600) * RATES.cpuPerVcpuHour;
  const memoryUsd = (row.memory_gb_seconds / 3600) * RATES.memoryPerGbHour;
  const volumeUsd = (row.volume_gb_seconds / 3600 / HOURS_PER_MONTH) * RATES.volumePerGbMonth;
  const egressUsd = (row.egress_bytes / GB) * RATES.egressPerGb;
  return { cpuUsd, memoryUsd, volumeUsd, egressUsd, totalUsd: cpuUsd + memoryUsd + volumeUsd + egressUsd };
}

const round = (n) => Math.round(n * 100) / 100;

/** What a project has used this month, and a projection to the end of the month. */
export function projectUsage(projectId, now = new Date()) {
  const month = monthKey(now);
  const rows = queryAll(`
    SELECT s.id, s.name, COALESCE(u.cpu_seconds, 0) AS cpu_seconds, COALESCE(u.memory_gb_seconds, 0) AS memory_gb_seconds,
      COALESCE(u.volume_gb_seconds, 0) AS volume_gb_seconds, COALESCE(u.egress_bytes, 0) AS egress_bytes
    FROM services s
    JOIN environments e ON e.id = s.environment_id
    LEFT JOIN usage_monthly u ON u.service_id = s.id AND u.month = ?
    WHERE e.project_id = ?`, month, projectId);

  const totals = { cpuUsd: 0, memoryUsd: 0, volumeUsd: 0, egressUsd: 0 };
  let runRatePerHour = 0;
  const services = rows.map((r) => {
    const p = priceOf(r);
    for (const k of Object.keys(totals)) totals[k] += p[k];
    const sample = live.get(r.id);
    if (sample && now.getTime() - sample.at < 3 * TICK_MS) {
      runRatePerHour += (sample.cpuPercent / 100) * RATES.cpuPerVcpuHour + (sample.memoryMb / 1000) * RATES.memoryPerGbHour;
    }
    const gb = (volumeBytes.get(r.id) || 0) / GB;
    runRatePerHour += (gb * RATES.volumePerGbMonth) / HOURS_PER_MONTH;
    return { id: r.id, name: r.name, spentUsd: round(p.totalUsd) };
  });

  const spent = totals.cpuUsd + totals.memoryUsd + totals.volumeUsd + totals.egressUsd;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const hoursLeft = Math.max((end.getTime() - now.getTime()) / 3_600_000, 0);
  return {
    spentUsd: round(spent),
    estimatedUsd: round(spent + runRatePerHour * hoursLeft),
    breakdown: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round(v)])),
    services: services.sort((a, b) => b.spentUsd - a.spentUsd)
  };
}
