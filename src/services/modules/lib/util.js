import crypto from 'node:crypto';

export class EngineError extends Error {
  constructor(message, code = 'engine_error', details) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

export const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);

/**
 * Replace {{name}} and {{name|json}}. Only declared variables are allowed, so a typo in a
 * template fails loudly instead of leaking "{{x}}" into a user's repository.
 */
export function renderTemplate(text, vars, where = 'template') {
  return text.replace(/\{\{\s*([\w.]+)(?:\|(json))?\s*\}\}/g, (_m, key, filter) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new EngineError(`Unknown template variable "${key}" in ${where}`, 'template_var');
    const value = vars[key];
    return filter === 'json' ? JSON.stringify(value) : String(value);
  });
}

export const templateVars = (text) => [...text.matchAll(/\{\{\s*([\w.]+)(?:\|json)?\s*\}\}/g)].map((m) => m[1]);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));

/** Sort keys recursively; arrays keep their order. Gives byte-stable JSON. */
export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => [k, sortDeep(v)]));
  return value;
}

export const stableJson = (value) => `${JSON.stringify(sortDeep(value), null, 2)}\n`;

export function slugify(text, fallback = 'app') {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

/** Repo-relative path check, same rules the platform applies to model output. */
export function safePath(input) {
  if (typeof input !== 'string') return null;
  const p = input.trim().replace(/^\.\//, '');
  if (!p || p.length > 200 || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || s === 'node_modules' || s === '.git')) return null;
  return p;
}
