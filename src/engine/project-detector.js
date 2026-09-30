// project-detector.js
// Works out how to install, build and start an arbitrary project.
// Pure filesystem inspection: no DB, no side effects. Easy to unit test.
//
// Two-phase on purpose:
//   detectProject(cwd)    -> BEFORE build: language, install + build commands
//   resolveStart(cwd, d)  -> AFTER build:  start command (depends on build output)

import fs from 'node:fs';
import path from 'node:path';

const P = (cwd, ...p) => path.join(cwd, ...p);
const exists = (cwd, ...p) => fs.existsSync(P(cwd, ...p));
const isFile = (cwd, ...p) => { try { return fs.statSync(P(cwd, ...p)).isFile(); } catch { return false; } };
const isDir = (cwd, ...p) => { try { return fs.statSync(P(cwd, ...p)).isDirectory(); } catch { return false; } };
const readText = (cwd, ...p) => { try { return fs.readFileSync(P(cwd, ...p), 'utf-8'); } catch { return null; } };
export const readJsonSafe = (cwd, ...p) => {
  const t = readText(cwd, ...p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
};
const listDir = (cwd, ...p) => { try { return fs.readdirSync(P(cwd, ...p), { withFileTypes: true }); } catch { return []; } };

// Shell-expanded by the process supervisor. Every server must bind to this port on 0.0.0.0.
const PORT = '${PORT:-3000}';
const VENV_SETUP = 'python3 -m venv .venv && . .venv/bin/activate && python -m pip install --upgrade pip';
const VENV_ACTIVATE = '. .venv/bin/activate && ';

// "start" scripts that are really dev servers / watchers / localhost-only previews
const DEV_SCRIPT = /(react-scripts\s+start|\bnext\s+dev|\bnodemon\b|webpack(-dev-server|\s+serve)|\bng\s+serve|vue-cli-service\s+serve|\bastro\s+dev|\bnuxti?\s+dev|gatsby\s+develop|ts-node-dev|tsx\s+watch|\bparcel(\s|$)|\bvite(\s+(dev|serve|--\S+))*\s*$)/;
const PREVIEW_SCRIPT = /\b(vite|astro|nuxti?)\s+preview/;

const SERVER_DEPS = ['express', 'fastify', 'koa', 'hono', 'restify', 'polka', 'socket.io', '@hapi/hapi', '@nestjs/core'];

// ---------------------------------------------------------------- static server

// Tiny dependency-free static file server, written into <workdir>/.morline/ at deploy time.
// Safe against path traversal, hides dotfiles, SPA fallback for extension-less routes.
export const STATIC_SERVER_SOURCE = String.raw`'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const port = parseInt(process.env.PORT || '3000', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json'
};

function fileIfExists(p) {
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

function locate(pathname) {
  const target = path.join(root, path.normalize(pathname));
  if (target !== root && !target.startsWith(root + path.sep)) return { forbidden: true };
  const segs = pathname.split('/').filter(Boolean);
  if (segs.some((s) => s.startsWith('.') && s !== '.well-known')) return { file: null };
  let f = fileIfExists(target) || fileIfExists(path.join(target, 'index.html')) || fileIfExists(target + '.html');
  if (f) return { file: f };
  if (!path.extname(pathname)) {
    f = fileIfExists(path.join(root, 'index.html'));
    if (f) return { file: f };
  }
  return { file: null };
}

function cacheControl(pathname, ext) {
  if (ext === '.html' || ext === '.htm') return 'no-cache';
  if (/-[A-Za-z0-9_-]{8,}\.\w+$/.test(pathname) || pathname.includes('/assets/') || pathname.includes('/_next/static/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }

  const { forbidden, file } = locate(pathname);
  if (forbidden) { res.writeHead(403); return res.end('Forbidden'); }

  let status = 200;
  let target = file;
  if (!target) {
    status = 404;
    target = fileIfExists(path.join(root, '404.html'));
    if (!target) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  }
  const ext = path.extname(target).toLowerCase();
  let size = 0;
  try { size = fs.statSync(target).size; } catch {}
  res.writeHead(status, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': status === 200 ? cacheControl(pathname, ext) : 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log('[morline-static] serving ' + root + ' on http://0.0.0.0:' + port);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`;

function staticResult(dir) {
  return { command: `node .morline/static-server.cjs '${dir}'`, staticDir: dir };
}

// ---------------------------------------------------------------- top-level detection

export function parseProcfile(cwd) {
  const text = readText(cwd, 'Procfile');
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*web\s*:\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

export function detectProject(cwd) {
  const base = {
    language: 'unknown', framework: null, packageManager: null,
    install: null, build: null, start: null,
    tools: [], env: {}, runtimeEnv: {}, notes: [], startFromProcfile: false
  };

  let found;
  if (isFile(cwd, 'package.json')) found = detectNode(cwd);
  else if (isFile(cwd, 'deno.json') || isFile(cwd, 'deno.jsonc')) found = detectDeno(cwd);
  else if (isFile(cwd, 'go.mod')) found = detectGo(cwd);
  else if (isFile(cwd, 'Cargo.toml')) found = detectRust(cwd);
  else if (isFile(cwd, 'pom.xml') || isFile(cwd, 'build.gradle') || isFile(cwd, 'build.gradle.kts')) found = detectJava(cwd);
  else if (findDotnetProject(cwd)) found = detectDotnet(cwd);
  else if (isFile(cwd, 'Gemfile')) found = detectRuby(cwd);
  else if (isFile(cwd, 'composer.json') || isFile(cwd, 'index.php')) found = detectPhp(cwd);
  else if (isPython(cwd)) found = detectPython(cwd);
  else if (isFile(cwd, 'index.html')) found = { language: 'static', framework: 'html' };

  const d = { ...base, ...(found || {}) };

  const procWeb = parseProcfile(cwd);
  if (procWeb) {
    d.start = procWeb;
    d.startFromProcfile = true;
    d.notes.push('Using the "web" process from Procfile as the start command');
  }
  return d;
}

// ---------------------------------------------------------------- Node / Bun

function detectNode(cwd) {
  const pkg = readJsonSafe(cwd, 'package.json') || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (n) => n in deps;

  let pm = 'npm';
  if (exists(cwd, 'bun.lockb') || exists(cwd, 'bun.lock')) pm = 'bun';
  else if (exists(cwd, 'pnpm-lock.yaml')) pm = 'pnpm';
  else if (exists(cwd, 'yarn.lock')) pm = 'yarn';
  else {
    const field = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager || '');
    if (field) pm = field[1];
  }

  const framework =
    has('next') ? 'next'
    : has('nuxt') || has('nuxt3') ? 'nuxt'
    : has('@sveltejs/kit') ? 'sveltekit'
    : has('astro') ? 'astro'
    : Object.keys(deps).some((k) => k.startsWith('@remix-run/')) ? 'remix'
    : has('@nestjs/core') ? 'nest'
    : has('react-scripts') ? 'cra'
    : has('@angular/core') ? 'angular'
    : has('gatsby') ? 'gatsby'
    : has('vite') ? 'vite'
    : has('express') ? 'express'
    : has('fastify') ? 'fastify'
    : null;

  const INSTALL = {
    npm: `${exists(cwd, 'package-lock.json') || exists(cwd, 'npm-shrinkwrap.json') ? 'npm ci --no-audit --no-fund --include=dev || ' : ''}npm install --no-audit --no-fund --include=dev`,
    pnpm: 'corepack enable >/dev/null 2>&1; command -v pnpm >/dev/null 2>&1 || npm install -g pnpm; pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile',
    yarn: 'corepack enable >/dev/null 2>&1; command -v yarn >/dev/null 2>&1 || npm install -g yarn; yarn install --frozen-lockfile || yarn install',
    bun: 'bun install'
  };

  const hasDeps = Object.keys(deps).length > 0;
  return {
    language: 'node',
    framework,
    packageManager: pm,
    install: hasDeps ? INSTALL[pm] : null,
    build: pkg.scripts?.build ? `${pm} run build` : null,
    tools: pm === 'bun' ? ['bun'] : ['node', 'npm'],
    // CRA turns every lint warning into a build error when CI=true
    env: framework === 'cra' ? { CI: 'false' } : {},
    runtimeEnv: { HOST: '0.0.0.0' }
  };
}

function tsOutDir(cwd) {
  const t = readText(cwd, 'tsconfig.json') || '';
  const m = t.match(/"outDir"\s*:\s*"([^"]+)"/);
  return m ? m[1].replace(/^\.\//, '').replace(/\/$/, '') : null;
}

const COMPILED_ENTRIES = [
  'index.js', 'server.js', 'app.js', 'main.js', 'index.mjs', 'server.mjs', 'main.mjs',
  'src/index.js', 'src/main.js', 'src/server.js', 'src/app.js', 'server/index.js'
];
const ROOT_ENTRIES = [
  'server.js', 'index.js', 'app.js', 'main.js', 'server.mjs', 'index.mjs', 'app.mjs', 'main.mjs',
  'src/index.js', 'src/server.js', 'src/app.js', 'src/main.js'
];

function findCompiledEntry(cwd) {
  const dirs = [...new Set([tsOutDir(cwd), 'dist', 'build'].filter(Boolean))];
  for (const dir of dirs) {
    for (const entry of COMPILED_ENTRIES) {
      if (isFile(cwd, dir, entry)) return `${dir}/${entry}`;
    }
  }
  return null;
}

function findRootEntry(cwd, pkg) {
  if (pkg.main && typeof pkg.main === 'string' && isFile(cwd, pkg.main)) return pkg.main;
  return ROOT_ENTRIES.find((f) => isFile(cwd, f)) || null;
}

function staticCandidates(cwd) {
  const list = ['dist', 'build', 'out', '.output/public', 'public'];
  // Angular & friends: dist/<project>/browser or dist/<project>
  for (const ent of listDir(cwd, 'dist')) {
    if (ent.isDirectory()) list.push(`dist/${ent.name}/browser`, `dist/${ent.name}`);
  }
  return list;
}

function resolveNodeStart(cwd, d) {
  const pkg = readJsonSafe(cwd, 'package.json') || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = d.packageManager;
  const startScript = typeof pkg.scripts?.start === 'string' ? pkg.scripts.start : null;
  const scriptIsDev = startScript && DEV_SCRIPT.test(startScript);
  const scriptIsPreview = startScript && PREVIEW_SCRIPT.test(startScript);

  // 1. A real production start script always wins
  if (startScript && !scriptIsDev && !scriptIsPreview) return { command: `${pm} run start` };

  // 2. Framework build outputs
  if (isFile(cwd, '.output/server/index.mjs')) return { command: 'node .output/server/index.mjs' };
  if (isFile(cwd, 'dist/server/entry.mjs')) return { command: 'node dist/server/entry.mjs' };
  if (d.framework === 'next') {
    if (isFile(cwd, 'out/index.html')) return staticResult('out');
    if (isDir(cwd, '.next')) return { command: `npx --yes next start -H 0.0.0.0 -p ${PORT}` };
  }

  // 3. Static sites (Vite, CRA, Vue, Svelte, Astro static, Angular, plain HTML build output)
  const compiled = findCompiledEntry(cwd);
  const rootEntry = findRootEntry(cwd, pkg);
  const backend = compiled || rootEntry;
  const serverish = Object.keys(deps).some((n) => SERVER_DEPS.includes(n)) && backend;
  if (!serverish) {
    const dir = staticCandidates(cwd).find((c) => isFile(cwd, c, 'index.html') && !(c === 'public' && backend));
    if (dir) return staticResult(dir);
  }

  // 4. Compiled / plain JS backends
  if (compiled) return { command: `node ${compiled}` };
  if (rootEntry) return { command: `node ${rootEntry}` };

  // 5. TypeScript run directly
  const tsEntry = ['src/index.ts', 'src/main.ts', 'src/server.ts', 'src/app.ts', 'index.ts', 'server.ts', 'app.ts', 'main.ts']
    .find((f) => isFile(cwd, f));
  if (tsEntry) {
    if (pm === 'bun') return { command: `bun run ${tsEntry}` };
    if (deps.tsx) return { command: `npx --yes tsx ${tsEntry}` };
    if (deps['ts-node']) return { command: `npx --yes ts-node ${tsEntry}` };
  }

  // 6. Last resorts: use the dev-ish start script anyway rather than fail outright
  if (startScript) {
    return { command: `${pm} run start`, warn: 'Start script looks like a dev server; no production entry point was found' };
  }
  return null;
}

// ---------------------------------------------------------------- Deno

function detectDeno(cwd) {
  const cfg = readJsonSafe(cwd, 'deno.json') || {};
  let start = null;
  if (cfg.tasks?.start) start = 'deno task start';
  else {
    const entry = ['main.ts', 'mod.ts', 'main.js', 'index.ts', 'server.ts'].find((f) => isFile(cwd, f));
    if (entry) start = `deno run --allow-all ${entry}`;
  }
  return { language: 'deno', tools: ['deno'], start, runtimeEnv: { HOST: '0.0.0.0' } };
}

// ---------------------------------------------------------------- Python

function isPython(cwd) {
  return ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'manage.py', 'main.py', 'app.py', 'server.py']
    .some((f) => isFile(cwd, f));
}

const PY_CANDIDATES = [
  'main.py', 'app.py', 'server.py', 'wsgi.py', 'asgi.py', 'api.py', 'run.py',
  'src/main.py', 'src/app.py', 'app/main.py', 'app/__init__.py', 'api/main.py', 'api/index.py'
];

function findPyApp(cwd, re) {
  for (const rel of PY_CANDIDATES) {
    const text = readText(cwd, rel);
    if (!text) continue;
    const m = text.match(re);
    if (m) {
      const module = rel.replace(/\.py$/, '').split('/').join('.').replace(/\.__init__$/, '');
      return { module, variable: m[1] };
    }
  }
  return null;
}

function detectPython(cwd) {
  const deps = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']
    .map((f) => readText(cwd, f) || '').join('\n').toLowerCase();

  let manager = null;
  let base = null;
  if (exists(cwd, 'uv.lock')) {
    manager = 'uv';
    base = 'pip install uv && (uv sync --frozen || uv sync)';
  } else if (exists(cwd, 'poetry.lock') || /\[tool\.poetry\]/.test(deps)) {
    manager = 'poetry';
    base = 'pip install poetry && POETRY_VIRTUALENVS_CREATE=false poetry install --no-interaction --no-root';
  } else if (isFile(cwd, 'Pipfile')) {
    manager = 'pipenv';
    base = 'pip install pipenv && (pipenv install --system --deploy || pipenv install --system)';
  } else if (isFile(cwd, 'requirements.txt')) {
    manager = 'pip';
    base = 'pip install -r requirements.txt';
  } else if (isFile(cwd, 'pyproject.toml') || isFile(cwd, 'setup.py')) {
    manager = 'pip';
    base = 'pip install .';
  }

  const extras = [];
  let framework = null;
  let build = null;
  let startBody = null; // command without venv prefix

  if (isFile(cwd, 'manage.py') && deps.includes('django')) {
    framework = 'django';
    const wsgiDir = listDir(cwd).find((e) => e.isDirectory() && isFile(cwd, e.name, 'wsgi.py'));
    if (wsgiDir) {
      if (!deps.includes('gunicorn')) extras.push('gunicorn');
      startBody = `gunicorn ${wsgiDir.name}.wsgi:application --bind 0.0.0.0:${PORT}`;
    } else {
      startBody = `python manage.py runserver 0.0.0.0:${PORT}`;
    }
    build = 'python manage.py collectstatic --noinput || true';
  } else {
    const fast = findPyApp(cwd, /^(\w+)\s*=\s*(?:FastAPI|Starlette)\(/m);
    const flask = !fast && findPyApp(cwd, /^(\w+)\s*=\s*Flask\(/m);
    if (fast) {
      framework = 'fastapi';
      if (!deps.includes('uvicorn')) extras.push('uvicorn');
      startBody = `uvicorn ${fast.module}:${fast.variable} --host 0.0.0.0 --port ${PORT}`;
    } else if (flask) {
      framework = 'flask';
      if (!deps.includes('gunicorn')) extras.push('gunicorn');
      startBody = `gunicorn ${flask.module}:${flask.variable} --bind 0.0.0.0:${PORT}`;
    } else {
      const script = ['main.py', 'app.py', 'server.py', 'run.py', 'bot.py', 'src/main.py'].find((f) => isFile(cwd, f));
      if (script) startBody = `python -u ${script}`;
    }
  }

  const usesVenv = Boolean(base || extras.length);
  const pipExtras = extras.length
    ? (manager === 'uv' ? `uv pip install ${extras.join(' ')}` : `pip install ${extras.join(' ')}`)
    : null;
  const install = usesVenv ? [VENV_SETUP, base, pipExtras].filter(Boolean).join(' && ') : null;
  const prefix = usesVenv ? VENV_ACTIVATE : '';

  return {
    language: 'python',
    framework,
    packageManager: manager,
    install,
    build: build ? `${prefix}${build}` : null,
    start: startBody ? `${prefix}${startBody}` : null,
    tools: ['python3'],
    env: {},
    runtimeEnv: { PYTHONUNBUFFERED: '1' }
  };
}

// ---------------------------------------------------------------- Go

function detectGo(cwd) {
  let target = '.';
  if (!isFile(cwd, 'main.go')) {
    const cmd = listDir(cwd, 'cmd').find((e) => e.isDirectory() && isFile(cwd, 'cmd', e.name, 'main.go'));
    if (cmd) target = `./cmd/${cmd.name}`;
  }
  return {
    language: 'go',
    install: 'go mod download',
    build: `mkdir -p .morline && go build -o .morline/app ${target}`,
    start: './.morline/app',
    tools: ['go']
  };
}

// ---------------------------------------------------------------- Rust

function detectRust(cwd) {
  const toml = readText(cwd, 'Cargo.toml') || '';
  const section = toml.match(/\[package\]([\s\S]*?)(?=\n\[|$)/);
  const name = section?.[1].match(/\bname\s*=\s*"([^"]+)"/)?.[1] || null;
  return {
    language: 'rust',
    build: 'cargo build --release',
    binaryName: name,
    tools: ['cargo']
  };
}

function findExecutable(dir) {
  try {
    return fs.readdirSync(dir).sort().find((f) => {
      if (f.includes('.')) return false;
      const st = fs.statSync(path.join(dir, f));
      return st.isFile() && (st.mode & 0o111);
    }) || null;
  } catch { return null; }
}

// ---------------------------------------------------------------- Java

function detectJava(cwd) {
  const jarPick = (dir) => `"$(ls ${dir}/*.jar | grep -v -E 'original|sources|javadoc|plain' | head -n1)"`;
  const javaRun = (dir) => `java -Dserver.port=${PORT} -jar ${jarPick(dir)}`;

  if (isFile(cwd, 'pom.xml')) {
    const wrapper = isFile(cwd, 'mvnw');
    return {
      language: 'java', framework: 'maven',
      build: wrapper ? 'chmod +x ./mvnw && ./mvnw -B -DskipTests package' : 'mvn -B -DskipTests package',
      start: javaRun('target'),
      tools: wrapper ? ['java'] : ['java', 'mvn']
    };
  }
  const wrapper = isFile(cwd, 'gradlew');
  return {
    language: 'java', framework: 'gradle',
    build: wrapper ? 'chmod +x ./gradlew && ./gradlew build -x test --no-daemon' : 'gradle build -x test --no-daemon',
    start: javaRun('build/libs'),
    tools: wrapper ? ['java'] : ['java', 'gradle']
  };
}

// ---------------------------------------------------------------- .NET

function findDotnetProject(cwd) {
  const roots = [cwd, ...listDir(cwd).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => P(cwd, e.name))];
  for (const dir of roots) {
    try {
      const f = fs.readdirSync(dir).find((n) => n.endsWith('.csproj') || n.endsWith('.fsproj'));
      if (f) return path.relative(cwd, path.join(dir, f));
    } catch {}
  }
  return null;
}

function detectDotnet(cwd) {
  const sln = listDir(cwd).find((e) => e.isFile() && e.name.endsWith('.sln'));
  const proj = sln ? sln.name : findDotnetProject(cwd);
  return {
    language: 'dotnet',
    build: `dotnet publish "${proj}" -c Release -o .morline/out`,
    tools: ['dotnet'],
    env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }
  };
}

// ---------------------------------------------------------------- Ruby

function detectRuby(cwd) {
  const rails = isFile(cwd, 'config', 'application.rb') && isFile(cwd, 'bin', 'rails');
  const install = "bundle config set --local without 'development test' && bundle install --jobs 4";
  if (rails) {
    return {
      language: 'ruby', framework: 'rails', install,
      build: 'bundle exec rake assets:precompile || true',
      start: `bundle exec rails server -b 0.0.0.0 -p ${PORT} -e production`,
      tools: ['ruby', 'bundle'],
      env: { RAILS_ENV: 'production', SECRET_KEY_BASE_DUMMY: '1' },
      runtimeEnv: { RAILS_ENV: 'production', RAILS_SERVE_STATIC_FILES: 'true', RAILS_LOG_TO_STDOUT: 'true' }
    };
  }
  let start = null;
  if (isFile(cwd, 'config.ru')) start = `bundle exec rackup config.ru -o 0.0.0.0 -p ${PORT}`;
  else {
    const script = ['app.rb', 'main.rb', 'server.rb'].find((f) => isFile(cwd, f));
    if (script) start = `bundle exec ruby ${script}`;
  }
  return { language: 'ruby', framework: 'rack', install, start, tools: ['ruby', 'bundle'] };
}

// ---------------------------------------------------------------- PHP

function detectPhp(cwd) {
  const composer = isFile(cwd, 'composer.json');
  let start;
  let framework = null;
  if (isFile(cwd, 'artisan')) {
    framework = 'laravel';
    start = `php artisan serve --host=0.0.0.0 --port=${PORT}`;
  } else {
    const docroot = isFile(cwd, 'public', 'index.php') ? 'public' : '.';
    start = `php -S 0.0.0.0:${PORT} -t ${docroot}`;
  }
  return {
    language: 'php', framework,
    install: composer ? 'composer install --no-dev --optimize-autoloader --no-interaction' : null,
    start,
    tools: composer ? ['php', 'composer'] : ['php']
  };
}

// ---------------------------------------------------------------- post-build start resolution

export function resolveStart(cwd, d) {
  if (d.start) return { command: d.start };

  switch (d.language) {
    case 'node':
      return resolveNodeStart(cwd, d);
    case 'static':
      return staticResult('.');
    case 'rust': {
      const guess = d.binaryName ? `target/release/${d.binaryName}` : null;
      if (guess && isFile(cwd, guess)) return { command: `./${guess}` };
      const bin = findExecutable(P(cwd, 'target', 'release'));
      return bin ? { command: `./target/release/${bin}` } : null;
    }
    case 'dotnet': {
      const rc = listDir(cwd, '.morline', 'out').find((e) => e.name.endsWith('.runtimeconfig.json'));
      if (!rc) return null;
      const dll = rc.name.replace('.runtimeconfig.json', '.dll');
      return { command: `ASPNETCORE_URLS=http://0.0.0.0:${PORT} dotnet .morline/out/${dll}` };
    }
    default:
      return null;
  }
}
