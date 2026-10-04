import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { execute, queryOne, queryAll } from '../db/index.js';
import { APPS_DIR } from '../config.js';
import { completeText } from '../services/llm.js';
import { AppError, notFound, conflict } from '../middleware/error-handler.js';
import { buildManager } from './build-manager.js';

const STALE_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 12 * 1024;
const MAX_CONTEXT_BYTES = 60 * 1024;
const MAX_FIX_FILE_BYTES = 200 * 1024;
const ACTIVE = ['pending', 'running'];

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- shape

export function mapDiagnosis(row) {
  if (!row) return null;
  let files = [];
  try { files = row.fix_files ? JSON.parse(row.fix_files) : []; } catch { files = []; }
  const hasFix = row.status === 'completed' && files.length > 0;
  return {
    status: row.status,
    summary: row.summary || null,
    rootCause: row.root_cause || null,
    suggestedFix: row.suggested_fix || null,
    canAutoFix: Boolean(row.can_auto_fix),
    // `content` and `baseHash` stay server-side; the app only needs the diff to display.
    fix: hasFix ? { title: row.fix_title || 'Suggested fix', files: files.map((f) => ({ path: f.path, diff: f.diff })) } : null,
    pullRequest: row.pr_url ? { url: row.pr_url, number: row.pr_number } : null,
    dismissed: Boolean(row.dismissed),
    ...(row.status === 'failed' && row.error ? { error: row.error } : {})
  };
}

function loadRow(deploymentId) {
  return queryOne('SELECT * FROM deployment_diagnoses WHERE deployment_id = ?', deploymentId);
}

function setFailed(deploymentId, message) {
  execute(
    "UPDATE deployment_diagnoses SET status = 'failed', summary = ?, error = ?, updated_at = ? WHERE deployment_id = ?",
    `Analysis failed: ${message}`, message, now(), deploymentId);
}

// ---------------------------------------------------------------- public api

export function getDiagnosis(deploymentId) {
  let row = loadRow(deploymentId);
  if (!row) return null;
  // A server restart mid-analysis would otherwise leave the app polling forever.
  if (ACTIVE.includes(row.status) && Date.now() - Date.parse(row.updated_at) > STALE_MS) {
    setFailed(deploymentId, 'The analysis timed out. Try again.');
    row = loadRow(deploymentId);
  }
  return mapDiagnosis(row);
}

export function startDiagnosis(dep) {
  if (['queued', 'building'].includes(dep.state)) {
    throw conflict('This deployment is still building', 'invalid_state');
  }
  const existing = getDiagnosis(dep.id);
  if (existing && ACTIVE.includes(existing.status)) return existing; // already in flight

  const at = now();
  execute(`
    INSERT INTO deployment_diagnoses (deployment_id, status, created_at, updated_at)
    VALUES (?, 'pending', ?, ?)
    ON CONFLICT(deployment_id) DO UPDATE SET
      status = 'pending', summary = NULL, root_cause = NULL, suggested_fix = NULL,
      can_auto_fix = 0, fix_title = NULL, fix_files = NULL, pr_url = NULL, pr_number = NULL,
      dismissed = 0, error = NULL, updated_at = excluded.updated_at
  `, dep.id, at, at);

  setImmediate(() => {
    runDiagnosis(dep.id).catch((err) => {
      console.error('[Diagnosis] Unexpected failure:', err);
      try { setFailed(dep.id, err.message || 'Unexpected error'); } catch { /* ignore */ }
    });
  });
  return getDiagnosis(dep.id);
}

export function dismissDiagnosis(deploymentId) {
  if (!loadRow(deploymentId)) throw notFound('No diagnosis for this deployment', 'diagnosis_not_found');
  execute('UPDATE deployment_diagnoses SET dismissed = 1, updated_at = ? WHERE deployment_id = ?', now(), deploymentId);
  return getDiagnosis(deploymentId);
}

// ---------------------------------------------------------------- context gathering

const LOG_NOISE = /^\[Container build\] #\d+ (sha256:|extracting|exporting|resolve |DONE|CACHED|\.\.\.|transferring|\[internal\]|load )/;

function collectLogs(deploymentId) {
  const tail = queryAll('SELECT id, level, phase, message, timestamp FROM deployment_logs WHERE deployment_id = ? ORDER BY timestamp DESC LIMIT 150', deploymentId);
  const problems = queryAll("SELECT id, level, phase, message, timestamp FROM deployment_logs WHERE deployment_id = ? AND level IN ('error', 'warn') ORDER BY timestamp DESC LIMIT 80", deploymentId);
  const byId = new Map();
  for (const r of [...tail, ...problems]) byId.set(r.id, r);
  const lines = [...byId.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .filter((r) => !LOG_NOISE.test(r.message))
    .map((r) => `${String(r.level).toUpperCase()} [${r.phase || '?'}] ${r.message.slice(0, 400)}`);
  let text = lines.join('\n');
  if (text.length > 14000) text = '...(earlier lines omitted)\n' + text.slice(-14000);
  return text;
}

function safeResolve(root, rel) {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (abs.split(path.sep).includes('.git')) return null;
  return abs;
}

function readRepoFile(root, rel, limit = MAX_FIX_FILE_BYTES) {
  const abs = safeResolve(root, rel);
  if (!abs) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > limit) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

const KEY_FILES = [
  'package.json', 'Dockerfile', 'railpack.json', 'morline.json', 'railway.json', 'Procfile',
  'requirements.txt', 'pyproject.toml', 'runtime.txt', 'go.mod', 'Cargo.toml', 'tsconfig.json',
  'vite.config.js', 'vite.config.ts', 'next.config.js', 'docker-compose.yml', '.env.example'
];

function collectFiles(root, rootDirectory, logText) {
  const bases = ['', ...(rootDirectory && rootDirectory !== '.' ? [rootDirectory.replace(/^\/+|\/+$/g, '')] : [])];
  const wanted = [];
  for (const base of bases) for (const name of KEY_FILES) wanted.push(path.posix.join(base, name));

  // Files the logs point at, e.g. "/app/src/server.js:42".
  const mentioned = new Set();
  const re = /([\w@./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rb|rs|json|toml|ya?ml))(?::\d+)?/g;
  for (const m of logText.matchAll(re)) {
    const rel = m[1].replace(/^\.?\/?(?:app\/)?/, '');
    if (rel && !rel.includes('node_modules') && readRepoFile(root, rel) !== null) mentioned.add(rel);
    if (mentioned.size >= 6) break;
  }
  wanted.push(...mentioned);

  const files = [];
  let total = 0;
  for (const rel of [...new Set(wanted)]) {
    const content = readRepoFile(root, rel);
    if (content === null) continue;
    const clipped = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) + '\n...(truncated)' : content;
    if (total + clipped.length > MAX_CONTEXT_BYTES) break;
    total += clipped.length;
    files.push({ path: rel, content: clipped });
  }

  let tree = '';
  try {
    const out = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', timeout: 5000 });
    tree = (out.stdout || '').split('\n').filter(Boolean).slice(0, 200).join('\n');
  } catch { /* tree is optional */ }
  return { files, tree };
}

// ---------------------------------------------------------------- model call

const SYSTEM_PROMPT = `You are Morline's deployment crash analyst. You are given the logs, configuration and key source files of a deployment that failed to build, failed to start, or crashed. Work out the single most likely root cause.

Respond with ONE JSON object and nothing else (no markdown fences) in exactly this shape:
{
  "summary": "one or two plain sentences saying what went wrong",
  "rootCause": "the specific cause, referencing the evidence in the logs or files",
  "suggestedFix": "what the developer should do, as short numbered steps",
  "canAutoFix": true or false,
  "fix": null | { "title": "short imperative PR title", "files": [ { "path": "path/from/repo/root", "content": "the COMPLETE new contents of the file" } ] }
}

Rules:
- Only set canAutoFix to true when the fix is a change to files in the repository that you are confident resolves the failure. Otherwise set it false and fix to null.
- Problems that live outside the repo (a missing or wrong environment variable, a wrong port or setting in the platform, an unavailable service, or a platform fault) are NOT auto-fixable. Explain them in suggestedFix instead. Never guess at secret values.
- For every file in fix.files, give the complete new file content, not a diff and not a fragment. Paths are relative to the repository root, using the paths in the file list. Change as little as possible. Only edit or create files that are necessary.
- Do not invent facts. If the evidence is thin, say so in rootCause and keep canAutoFix false.`;

function buildUserPrompt({ dep, snapshot, logs, files, tree }) {
  const parts = [
    `Deployment state: ${dep.state}${dep.error_summary ? `\nPlatform error summary: ${dep.error_summary}` : ''}`,
    `Service: ${dep.service_name}`
  ];
  if (snapshot?.config) parts.push(`Deploy-time configuration:\n${JSON.stringify(snapshot.config, null, 2)}`);
  if (snapshot?.variables?.length) {
    // Names only; values may be sensitive and are not needed to diagnose.
    parts.push(`Environment variable names set: ${snapshot.variables.map((v) => v.key).join(', ')}`);
  } else {
    parts.push('Environment variable names set: (none recorded)');
  }
  parts.push(`Logs (build and runtime, oldest first):\n${logs || '(no logs recorded)'}`);
  if (tree) parts.push(`Repository files:\n${tree}`);
  for (const f of files) parts.push(`--- ${f.path} ---\n${f.content}`);
  return parts.join('\n\n');
}

function parseModelJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* try to extract */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fall through */ }
  }
  throw new Error('The model returned an unreadable response');
}

function unifiedDiff(relPath, oldText, newText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morline-diff-'));
  try {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.writeFileSync(a, oldText ?? '');
    fs.writeFileSync(b, newText);
    const out = spawnSync('diff', ['-u', '--label', oldText === null ? '/dev/null' : `a/${relPath}`, '--label', `b/${relPath}`, a, b], { encoding: 'utf8' });
    return out.stdout || '';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function buildFix(root, rawFix) {
  const out = [];
  for (const file of rawFix?.files || []) {
    const rel = String(file?.path || '').replace(/^\.?\/+/, '');
    if (!rel || typeof file.content !== 'string' || file.content.length > MAX_FIX_FILE_BYTES) continue;
    if (!safeResolve(root, rel)) continue;
    const original = readRepoFile(root, rel);
    if (original !== null && original === file.content) continue; // no-op change
    const diff = unifiedDiff(rel, original, file.content);
    if (!diff.trim()) continue;
    out.push({ path: rel, diff, content: file.content, baseHash: original === null ? null : sha256(original) });
  }
  return out;
}

async function runDiagnosis(deploymentId) {
  const dep = queryOne('SELECT * FROM deployments WHERE id = ?', deploymentId);
  if (!dep) return;
  execute("UPDATE deployment_diagnoses SET status = 'running', updated_at = ? WHERE deployment_id = ?", now(), deploymentId);

  try {
    const service = queryOne('SELECT * FROM services WHERE id = ?', dep.service_id) || {};
    const settings = queryOne('SELECT * FROM service_settings WHERE service_id = ?', dep.service_id) || {};
    let snapshot = null;
    try { snapshot = dep.snapshot ? JSON.parse(dep.snapshot) : null; } catch { /* old deployment */ }

    const root = path.join(APPS_DIR, dep.service_id);
    const logs = collectLogs(deploymentId);
    const { files, tree } = fs.existsSync(root) ? collectFiles(root, settings.root_directory || '', logs) : { files: [], tree: '' };

    const text = await completeText({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ dep, snapshot, logs, files, tree }),
      maxTokens: 8000
    });
    const result = parseModelJson(text);

    const isGithub = Boolean(service.source_repo) && ['github', 'repo'].includes(service.source_type);
    const fixFiles = result.canAutoFix && result.fix ? buildFix(root, result.fix) : [];
    // A PR is only possible for GitHub-sourced services with a real change to propose.
    const canAutoFix = Boolean(result.canAutoFix) && fixFiles.length > 0 && isGithub;

    execute(`
      UPDATE deployment_diagnoses SET
        status = 'completed', summary = ?, root_cause = ?, suggested_fix = ?, can_auto_fix = ?,
        fix_title = ?, fix_files = ?, error = NULL, updated_at = ?
      WHERE deployment_id = ?
    `,
    String(result.summary || '').slice(0, 2000),
    String(result.rootCause || '').slice(0, 4000),
    String(result.suggestedFix || '').slice(0, 4000),
    canAutoFix ? 1 : 0,
    fixFiles.length ? String(result.fix?.title || 'Suggested fix').slice(0, 200) : null,
    fixFiles.length ? JSON.stringify(fixFiles) : null,
    now(), deploymentId);
  } catch (err) {
    setFailed(deploymentId, err.message || 'Unknown error');
  }
}

// ---------------------------------------------------------------- pull request

async function gh(token, method, route, body, allow = []) {
  const res = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Morline-App',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok && !allow.includes(res.status)) {
    const hint = res.status === 403 || res.status === 404
      ? ' The GitHub connection may lack write access (Contents and Pull requests) to this repository.' : '';
    throw new AppError(`GitHub rejected the request: ${data?.message || res.status}.${hint}`, 502, 'github_error');
  }
  return { status: res.status, data };
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

export async function createDiagnosisPullRequest(dep) {
  const row = loadRow(dep.id);
  if (!row) throw notFound('No diagnosis for this deployment', 'diagnosis_not_found');
  if (row.pr_url) return { url: row.pr_url, number: row.pr_number, existing: true };

  let files = [];
  try { files = row.fix_files ? JSON.parse(row.fix_files) : []; } catch { files = []; }
  if (row.status !== 'completed' || !row.can_auto_fix || !files.length) {
    throw conflict('This diagnosis has no automatic fix to open a pull request for', 'no_fix_available');
  }

  const service = queryOne('SELECT * FROM services WHERE id = ?', dep.service_id) || {};
  const repo = service.source_repo;
  if (!repo || !repo.includes('/')) throw conflict('This service is not connected to a GitHub repository', 'no_repository');

  const token = await buildManager._resolveGithubToken({ serviceId: dep.service_id, log: () => {} }, repo);
  if (!token) throw conflict('No GitHub connection is available for this repository. Connect GitHub and try again.', 'github_not_connected');

  let snapshot = null;
  try { snapshot = dep.snapshot ? JSON.parse(dep.snapshot) : null; } catch { /* ignore */ }
  const settings = queryOne('SELECT branch FROM service_settings WHERE service_id = ?', dep.service_id) || {};
  const repoInfo = (await gh(token, 'GET', `/repos/${repo}`)).data;
  const base = (settings.branch || '').trim() || snapshot?.source?.branch || dep.commit_branch || repoInfo.default_branch;

  // Fixes are applied on top of the branch tip, which is also what the analysis read.
  const tip = (await gh(token, 'GET', `/repos/${repo}/git/ref/heads/${encodePath(base)}`)).data?.object?.sha;
  if (!tip) throw new AppError(`Could not find branch "${base}" on GitHub`, 502, 'github_error');

  // Refuse to overwrite files that changed since the analysis read them.
  for (const f of files) {
    const current = await gh(token, 'GET', `/repos/${repo}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(base)}`, null, [404]);
    const currentText = current.status === 404 ? null : Buffer.from(current.data?.content || '', 'base64').toString('utf8');
    const currentHash = currentText === null ? null : sha256(currentText);
    if (currentHash !== f.baseHash) {
      throw conflict(`${f.path} has changed on ${base} since this analysis. Run the analysis again.`, 'stale_fix');
    }
  }

  let branch = `morline/fix-${dep.id.slice(-8)}`;
  let ref = await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip }, [422]);
  if (ref.status === 422) { // name already taken by an earlier attempt
    branch = `${branch}-${Date.now().toString(36)}`;
    await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
  }

  const title = row.fix_title || 'Fix failed deployment';
  for (const f of files) {
    const existing = await gh(token, 'GET', `/repos/${repo}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(branch)}`, null, [404]);
    await gh(token, 'PUT', `/repos/${repo}/contents/${encodePath(f.path)}`, {
      message: `fix: ${title}`,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      branch,
      ...(existing.status === 404 ? {} : { sha: existing.data?.sha })
    });
  }

  const body = [
    `Opened by Morline after deployment \`${dep.id}\` of **${dep.service_name}** ${dep.state === 'failed' ? 'failed' : 'crashed'}.`,
    '',
    '### What went wrong', row.summary || '', '',
    '### Root cause', row.root_cause || '', '',
    '### Suggested fix', row.suggested_fix || '', '',
    '_This change was generated by an AI analysis. Please review it before merging._'
  ].join('\n');

  const pr = (await gh(token, 'POST', `/repos/${repo}/pulls`, { title: `[Morline] ${title}`, head: branch, base, body })).data;
  execute('UPDATE deployment_diagnoses SET pr_url = ?, pr_number = ?, updated_at = ? WHERE deployment_id = ?', pr.html_url, pr.number, now(), dep.id);
  return { url: pr.html_url, number: pr.number, existing: false };
}
