import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError, safePath, templateVars } from './util.js';

export const DEFAULT_CATALOG_DIR = new URL('../catalog/node-fastify/', import.meta.url);

const ID = /^[a-z][a-z0-9-]*$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const VERSION = /^\^\d+\.\d+\.\d+$/;
const ICON = /^(lucide:[a-z0-9-]+|[a-z0-9-]+)$/;
const BUILTIN_VARS = ['name', 'slug', 'description'];

async function readTree(dirUrl) {
  const root = fileURLToPath(dirUrl);
  const out = new Map();
  let entries;
  try { entries = await readdir(root, { recursive: true, withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    // Templates are LF: a Windows checkout can turn them into CRLF, which breaks the exact-line patch anchors.
    out.set(path.relative(root, full).split(path.sep).join('/'), (await readFile(full, 'utf8')).replace(/\r\n?/g, '\n'));
  }
  return out;
}

const normalizeModule = (raw, templates) => ({
  internal: false, capability: null, provider: null, requires: [], requiresWhen: {}, conflicts: [], addons: [],
  options: {}, deps: {}, env: [], files: [], wiring: null, readme: { features: [] }, services: [], variantBy: null, variants: {},
  ...raw, templates
});

/** The static lines a module contributes to shared files. Static on purpose: removal must find them again. */
export function contributions(def) {
  const wiring = def.wiring ? { imports: def.wiring.imports ?? [], register: (def.wiring.register ?? []).map((l) => `  ${l}`), phase: def.wiring.phase } : null;
  const envRows = def.env.map((v) => `| \`${v.key}\` | ${v.required ? 'yes' : 'no'} | ${v.description} |`);
  const envHeader = def.env.length ? `# ${def.envTitle ?? def.name}` : null;
  const envBlock = def.env.length
    ? [envHeader, ...def.env.flatMap((v) => [`# ${v.description}`, `${v.key}=${v.example ?? ''}`])]
    : null;
  return { wiring, features: def.readme.features, envRows, envHeader, envBlock };
}

export function viewOf(def, options, variantKey) {
  const variant = variantKey ? def.variants[variantKey] ?? {} : {};
  const requires = [...def.requires, ...(variant.requires ?? [])];
  for (const [cond, ids] of Object.entries(def.requiresWhen)) {
    const [k, v] = cond.split('=');
    if (String(options[k]) === v) requires.push(...ids);
  }
  return {
    files: [...def.files, ...(variant.files ?? [])],
    deps: { ...def.deps, ...(variant.deps ?? {}) },
    requires: [...new Set(requires)],
    addons: [...new Set([...def.addons, ...(variant.addons ?? [])])]
  };
}

function validate(cat) {
  const errors = [];
  const err = (m) => errors.push(m);
  const { meta, modules } = cat;
  const lineOwners = new Map();
  const pathOwners = new Map();
  const depVersions = new Map();

  for (const [id, def] of modules) {
    const at = `module ${id}`;
    if (!ID.test(id)) err(`${at}: bad id`);
    if (def.id !== id) err(`${at}: id does not match folder name`);
    for (const k of ['name', 'category', 'summary', 'icon', 'label']) if (!def[k]) err(`${at}: missing ${k}`);
    if (def.summary && def.summary.length > 220) err(`${at}: summary too long for an AI card`);
    if (def.icon && !ICON.test(def.icon)) err(`${at}: bad icon "${def.icon}"`);
    if (!def.label?.add || !def.label?.remove) err(`${at}: label.add and label.remove are required`);
    if (!Number.isInteger(def.order)) err(`${at}: order must be an integer`);
    if (def.wiring && !meta.phases.includes(def.wiring.phase)) err(`${at}: wiring.phase must be one of ${meta.phases.join(', ')}`);
    for (const r of [...def.requires, ...Object.values(def.requiresWhen).flat(), ...Object.values(def.variants).flatMap((v) => v.requires ?? []), ...def.conflicts]) {
      if (!modules.has(r)) err(`${at}: references unknown module "${r}"`);
    }
    for (const a of [...def.addons, ...Object.values(def.variants).flatMap((v) => v.addons ?? [])]) if (!meta.addons[a]) err(`${at}: unknown addon "${a}"`);
    for (const v of def.env) {
      if (!ENV_KEY.test(v.key)) err(`${at}: bad env key ${v.key}`);
      if (!v.description || /[|\n]/.test(v.description)) err(`${at}: env ${v.key} needs a one-line description without "|"`);
    }
    const allDeps = { ...def.deps, ...Object.assign({}, ...Object.values(def.variants).map((v) => v.deps ?? {})) };
    for (const [name, version] of Object.entries(allDeps)) {
      if (!VERSION.test(version)) err(`${at}: dependency ${name} must be a caret range like ^1.2.3`);
      if (depVersions.has(name) && depVersions.get(name) !== version) err(`${at}: dependency ${name} is ${version} here but ${depVersions.get(name)} elsewhere`);
      depVersions.set(name, version);
    }
    const allowedVars = new Set([...BUILTIN_VARS, ...Object.keys(def.options), ...(def.variantBy ? [def.variantBy] : [])]);
    for (const f of [...def.files, ...Object.values(def.variants).flatMap((v) => v.files ?? [])]) {
      const tpl = def.templates.get(f.from);
      if (tpl === undefined) { err(`${at}: template files/${f.from} does not exist`); continue; }
      if (!safePath(f.to)) err(`${at}: unsafe target path ${f.to}`);
      for (const v of templateVars(tpl)) if (!allowedVars.has(v)) err(`${at}: template ${f.from} uses undeclared variable {{${v}}}`);
      const when = JSON.stringify(f.when ?? null);
      const owners = pathOwners.get(f.to) ?? [];
      for (const o of owners) {
        const sameGroup = o.id !== id && def.capability && modules.get(o.id).capability === def.capability;
        if (o.id !== id && !sameGroup) err(`${at}: target ${f.to} is also written by ${o.id}`);
        if (o.id === id && o.when === when && o.when !== 'null') err(`${at}: target ${f.to} listed twice`);
      }
      owners.push({ id, when });
      pathOwners.set(f.to, owners);
    }
    const c = contributions(def);
    const lines = [...(c.wiring?.imports ?? []), ...(c.wiring?.register ?? []), ...c.features, ...c.envRows, ...(c.envHeader ? [c.envHeader] : [])];
    for (const l of lines) {
      const prev = lineOwners.get(l);
      if (prev && prev !== id && !(def.capability && modules.get(prev).capability === def.capability)) err(`${at}: contributes a line that ${prev} also contributes: ${l.slice(0, 60)}`);
      lineOwners.set(l, id);
    }
    for (const l of c.features) if (!l.startsWith('- ')) err(`${at}: readme feature lines must start with "- "`);
    if (def.variantBy && !def.options[def.variantBy]) err(`${at}: variantBy "${def.variantBy}" must also be a declared option`);
  }
  for (const [name, p] of Object.entries(meta.presets)) {
    for (const entry of p.modules) {
      const id = typeof entry === 'string' ? entry : entry.id;
      if (!modules.has(id)) err(`preset ${name}: unknown module "${id}"`);
    }
  }
  return errors;
}

export async function loadCatalog(dirUrl = DEFAULT_CATALOG_DIR) {
  const meta = JSON.parse(await readFile(new URL('catalog.json', dirUrl), 'utf8'));
  const base = new Map([...(await readTree(new URL('base/', dirUrl)))].map(([p, c]) => [p.replace(/\.tpl$/, ''), c]));
  const modules = new Map();
  const root = fileURLToPath(new URL('modules/', dirUrl));
  for (const dir of (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const folder = new URL(`modules/${dir.name}/`, dirUrl);
    const raw = JSON.parse(await readFile(new URL('module.json', folder), 'utf8'));
    modules.set(raw.id ?? dir.name, normalizeModule({ ...raw, id: raw.id ?? dir.name }, await readTree(new URL('files/', folder))));
  }
  const ordered = [...modules.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  const rank = new Map(ordered.map((m, i) => [m.id, i]));
  const lineRank = new Map();
  for (const m of ordered) {
    const c = contributions(m);
    for (const l of [...(c.wiring?.imports ?? []), ...(c.wiring?.register ?? []), ...c.features, ...c.envRows, ...(c.envHeader ? [c.envHeader] : [])]) lineRank.set(l, rank.get(m.id));
  }
  const cat = { dir: dirUrl, meta, base, modules, rank, lineRank, ordered };
  const errors = validate(cat);
  if (errors.length) throw new EngineError(`Catalog is invalid:\n- ${errors.join('\n- ')}`, 'catalog_invalid', { errors });
  return cat;
}

let cached;
/** The shipped catalog, loaded once per process. */
export const getCatalog = () => (cached ??= loadCatalog());

export function presetModules(cat, name) {
  const p = cat.meta.presets[name];
  if (!p) throw new EngineError(`Unknown preset "${name}". Presets: ${Object.keys(cat.meta.presets).join(', ')}`, 'unknown_preset');
  return p.modules.map((e) => (typeof e === 'string' ? { id: e, options: {} } : { id: e.id, options: e.options ?? {} }));
}
