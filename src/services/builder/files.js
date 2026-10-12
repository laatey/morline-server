// Validation for files the AI proposes. Nothing here trusts model output: paths are normalised,
// secrets and junk are refused, and sizes are capped before anything is stored or committed.

export const LIMITS = { maxFiles: 60, maxFileBytes: 200_000, maxTotalBytes: 600_000 };

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '__pycache__', 'venv', '.venv', 'vendor', 'target', 'coverage', '.cache']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'poetry.lock', 'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|eot|mp[34]|mov|wasm|so|dll|exe|bin|db|sqlite3?)$/i;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i;

/** Clean a repo-relative path, or return null when it isn't acceptable. */
export function normalizePath(input) {
  if (typeof input !== 'string') return null;
  const p = input.trim().replace(/^\.\//, '');
  if (!p || p.length > 200 || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return null;
  if (parts.some((s) => SKIP_DIRS.has(s))) return null;
  return p;
}

export function isSecretPath(p) {
  return SECRET_FILE.test(p) && !/\.env\.(example|sample|template)$/i.test(p);
}

/** Should the assistant read this existing file? Source and config only, nothing huge or generated. */
export function isReadable(path, size) {
  const name = path.split('/').pop();
  if (LOCKFILES.has(name) || BINARY_EXT.test(name) || isSecretPath(path) || /\.min\.(js|css)$/.test(name)) return false;
  if (path.split('/').some((s) => SKIP_DIRS.has(s))) return false;
  return size <= 100_000;
}

/** Validate a complete set of new files (a brand-new app). Throws a readable Error. */
export function validateNewFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('The model returned no files');
  if (files.length > LIMITS.maxFiles) throw new Error(`Too many files (${files.length}, limit ${LIMITS.maxFiles})`);
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const f of files) {
    const path = normalizePath(f?.path);
    if (!path) throw new Error(`Unsafe or invalid file path: ${JSON.stringify(f?.path)}`);
    if (isSecretPath(path)) throw new Error(`Refusing to write a secrets file: ${path}`);
    if (seen.has(path.toLowerCase())) throw new Error(`Duplicate file: ${path}`);
    if (typeof f.content !== 'string') throw new Error(`File has no text content: ${path}`);
    const bytes = Buffer.byteLength(f.content);
    if (bytes > LIMITS.maxFileBytes) throw new Error(`${path} is too large (${bytes} bytes)`);
    total += bytes;
    seen.add(path.toLowerCase());
    out.push({ path, content: f.content.endsWith('\n') || !f.content ? f.content : `${f.content}\n` });
  }
  if (total > LIMITS.maxTotalBytes) throw new Error('The generated project is too large');
  return out;
}

/** Apply `[{ find, replace }]` edits; each `find` must occur exactly once. */
export function applyEdits(content, edits, path = 'file') {
  if (!Array.isArray(edits) || !edits.length) throw new Error(`No edits given for ${path}`);
  let next = content;
  for (const [i, e] of edits.entries()) {
    if (typeof e?.find !== 'string' || !e.find || typeof e.replace !== 'string') throw new Error(`Edit ${i + 1} for ${path} is malformed`);
    const first = next.indexOf(e.find);
    if (first === -1) throw new Error(`Edit ${i + 1} for ${path}: the text to replace was not found`);
    if (next.indexOf(e.find, first + 1) !== -1) throw new Error(`Edit ${i + 1} for ${path}: the text to replace appears more than once`);
    next = next.slice(0, first) + e.replace + next.slice(first + e.find.length);
  }
  return next;
}

/**
 * Turn the model's proposed changes into concrete `{ path, action, before, after }` records
 * against the files that really exist. `existing` maps path -> current text.
 */
export function resolveChanges(proposed, existing, knownPaths = new Set(existing.keys())) {
  if (!Array.isArray(proposed) || !proposed.length) throw new Error('The model proposed no changes');
  if (proposed.length > LIMITS.maxFiles) throw new Error('The change touches too many files');
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const c of proposed) {
    const path = normalizePath(c?.path);
    if (!path) throw new Error(`Unsafe or invalid file path: ${JSON.stringify(c?.path)}`);
    if (isSecretPath(path)) throw new Error(`Refusing to touch a secrets file: ${path}`);
    if (seen.has(path)) throw new Error(`The same file was changed twice: ${path}`);
    seen.add(path);
    const before = existing.has(path) ? existing.get(path) : null;
    if (before === null && knownPaths.has(path)) throw new Error(`${path} exists but its contents were not provided, so it cannot be changed; only change the files you were shown or create new ones`);
    const action = c.action === 'delete' ? 'delete' : (before === null ? 'create' : 'update');

    if (action === 'delete') {
      if (before === null) throw new Error(`Cannot delete ${path}: it does not exist`);
      out.push({ path, action, before, after: null });
      continue;
    }
    let after;
    if (Array.isArray(c.edits) && c.edits.length) {
      if (before === null) throw new Error(`Cannot edit ${path}: it does not exist`);
      after = applyEdits(before, c.edits, path);
    } else if (typeof c.content === 'string') {
      after = c.content;
    } else {
      throw new Error(`No content or edits for ${path}`);
    }
    if (after === before) continue; // a no-op change isn't worth showing
    total += Buffer.byteLength(after);
    if (Buffer.byteLength(after) > LIMITS.maxFileBytes) throw new Error(`${path} is too large`);
    out.push({ path, action, before, after });
  }
  if (!out.length) throw new Error('The proposed change did not alter any file');
  if (total > LIMITS.maxTotalBytes) throw new Error('The change is too large');
  return out;
}

export function slugify(text, fallback = 'app') {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}
