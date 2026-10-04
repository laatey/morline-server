import fs from 'node:fs';
import path from 'node:path';
import { APPS_DIR } from '../config.js';
import { queryAll, execute } from '../db/index.js';
import { detectProject, readJsonSafe } from './project-detector.js';

// Detector framework ids -> the names the app uses to pick a logo.
const FRAMEWORK_NAMES = {
  next: 'nextjs', nest: 'nestjs', cra: 'react', nuxt: 'nuxt', sveltekit: 'sveltekit', astro: 'astro',
  remix: 'remix', angular: 'angular', gatsby: 'gatsby', express: 'express', fastify: 'fastify',
  django: 'django', fastapi: 'fastapi', flask: 'flask', rails: 'rails', rack: 'rack',
  laravel: 'laravel', html: 'html'
};
const RUNTIMES = new Set(['deno', 'go', 'rust', 'java', 'dotnet', 'ruby', 'php', 'python', 'static']);

function nodeUiFramework(cwd) {
  const pkg = readJsonSafe(cwd, 'package.json') || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [dep, name] of [['react', 'react'], ['vue', 'vue'], ['svelte', 'svelte'], ['solid-js', 'solid'], ['preact', 'preact']]) {
    if (dep in deps) return name;
  }
  return 'vite' in deps ? 'vite' : null;
}

function javaFramework(cwd) {
  for (const file of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    try {
      if (fs.readFileSync(path.join(cwd, file), 'utf8').includes('spring-boot')) return 'spring';
    } catch { /* file not present */ }
  }
  return null;
}

/** What kind of app lives in this directory, e.g. { runtime: 'node', framework: 'nextjs' }. */
export function describeApp(workDir, detected = detectProject(workDir)) {
  let runtime = null;
  if (detected.language === 'node') runtime = detected.packageManager === 'bun' ? 'bun' : 'node';
  else if (RUNTIMES.has(detected.language)) runtime = detected.language;
  else if (fs.existsSync(path.join(workDir, 'Dockerfile'))) runtime = 'docker';

  let framework = FRAMEWORK_NAMES[detected.framework] || null;
  if (detected.language === 'node' && (!framework || detected.framework === 'vite')) {
    framework = nodeUiFramework(workDir) || framework;
  } else if (detected.language === 'java') {
    framework = javaFramework(workDir);
  }
  return { runtime, framework };
}

export function saveAppType(serviceId, workDir, detected) {
  const { runtime, framework } = describeApp(workDir, detected);
  execute('UPDATE services SET runtime = ?, framework = ? WHERE id = ?', runtime, framework, serviceId);
  return { runtime, framework };
}

/** One-off at startup: fill in the type of services that were deployed before detection was recorded. */
export function backfillAppTypes() {
  const rows = queryAll(`
    SELECT s.id, ss.root_directory FROM services s
    LEFT JOIN service_settings ss ON ss.service_id = s.id
    WHERE s.runtime IS NULL AND s.framework IS NULL`);
  for (const row of rows) {
    try {
      const ws = path.join(APPS_DIR, row.id);
      if (!fs.existsSync(ws)) continue;
      const rel = String(row.root_directory || '').trim().replace(/^\/+/, '');
      const dir = rel && rel !== '.' ? path.resolve(ws, rel) : ws;
      if ((dir !== ws && !dir.startsWith(ws + path.sep)) || !fs.existsSync(dir)) continue;
      const { runtime, framework } = describeApp(dir);
      if (runtime || framework) execute('UPDATE services SET runtime = ?, framework = ? WHERE id = ?', runtime, framework, row.id);
    } catch (err) {
      console.warn(`[AppType] Could not detect ${row.id}: ${err.message}`);
    }
  }
}
