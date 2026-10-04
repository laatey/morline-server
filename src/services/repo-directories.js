import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL_MS = 60_000;
const TIMEOUT_MS = 60_000;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;
const SKIP = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', 'venv', 'coverage', 'tmp', 'bower_components'
]);
const cache = new Map();

function git(args, { cwd, authArgs = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', [...authArgs, ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// A nested folder is only worth offering as a root directory if it looks like an app.
const MANIFESTS = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'manage.py', 'go.mod', 'Cargo.toml', 'Dockerfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'mix.exs', 'deno.json', 'deno.jsonc',
  'railpack.json', 'morline.json', 'railway.json', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'index.html'
]);

/**
 * Takes the NUL-separated file list from `git ls-tree -r -z --name-only` and returns
 * ["/", "/api", "/packages", "/packages/ui", ...]: every top-level folder, plus nested
 * folders (up to MAX_DEPTH deep) that hold a project manifest such as package.json.
 */
export function toDirectoryList(fileList) {
  const dirs = new Set();
  for (const file of fileList.split('\0').filter(Boolean)) {
    const parts = file.split('/');
    const folders = parts.slice(0, -1);
    if (!folders.length || folders.some((s) => s.startsWith('.') || SKIP.has(s))) continue;
    dirs.add(folders[0]);
    if (folders.length <= MAX_DEPTH && MANIFESTS.has(parts[parts.length - 1])) dirs.add(folders.join('/'));
  }
  const sorted = [...dirs].sort((a, b) => a.localeCompare(b));
  return ['/', ...sorted.slice(0, MAX_ENTRIES).map((p) => `/${p}`)];
}

/**
 * Lists the folders of a GitHub repository for the Root directory picker.
 * Uses the existing checkout when there is one; otherwise fetches only the repository's
 * file tree (no file contents), so it works before the first deploy.
 */
export async function listRepoDirectories({ workspace, repo, branch, token, cacheKey }) {
  const key = `${cacheKey}:${branch || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.dirs;

  let tree = null;
  if (workspace && fs.existsSync(path.join(workspace, '.git'))) {
    const local = await git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: workspace });
    if (local.code === 0 && local.stdout) tree = local.stdout;
  }

  if (tree === null) {
    const authArgs = token
      ? ['-c', `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
      : [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morline-tree-'));
    try {
      await git(['init', '-q'], { cwd: dir });
      await git(['remote', 'add', 'origin', `https://github.com/${repo}.git`], { cwd: dir });

      const head = await git(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: dir, authArgs });
      const remoteDefault = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.stdout)?.[1] || null;
      // Same rule as the build: a stored main/master may just be a filled-in default.
      const filledIn = !branch || branch === 'main' || branch === 'master';
      const candidates = [...new Set([branch, ...(filledIn ? [remoteDefault, 'main', 'master'] : [])].filter(Boolean))];

      let lastError = head.code !== 0 ? head.stderr : '';
      for (const b of candidates) {
        const fetched = await git(['fetch', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`], { cwd: dir, authArgs });
        if (fetched.code !== 0) { lastError = fetched.stderr || lastError; continue; }
        const listed = await git(['ls-tree', '-r', '-z', '--name-only', `refs/remotes/origin/${b}`], { cwd: dir });
        if (listed.code === 0) { tree = listed.stdout; break; }
        lastError = listed.stderr;
      }
      if (tree === null) {
        const err = new Error(`Could not read ${repo}: ${lastError.trim().split('\n').pop() || 'unknown error'}`);
        err.unreachable = true;
        throw err;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const dirs = toDirectoryList(tree);
  cache.set(key, { at: Date.now(), dirs });
  return dirs;
}
