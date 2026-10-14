import { EngineError, safePath, slugify } from './util.js';
import { Project } from './project.js';
import { presetModules } from './catalog.js';
import { runChecks } from './checks.js';

// --- parsing the model's reply -----------------------------------------------------------
//
//   <compose>{"name":"orders-api", ...}</compose>
//   <file path="src/routes/orders.js">
//   raw contents
//   </file>
//   <done/>
//
// Same idea as the existing builder format: code travels as raw tagged blocks, only the small
// description of the project is JSON, so a cut-off reply can only damage the last block.

const trim = (s) => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
const unfence = (text) => text.replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n```\s*$/i, '');

export function parseComposeOutput(raw) {
  const text = unfence(raw);
  if (/^\s*<fallback\s*\/>\s*$/.test(text)) return { fallback: true, complete: true, files: [] };
  let compose = null;
  let composeError = null;
  const m = text.match(/<compose>([\s\S]*?)<\/compose>/);
  if (m) {
    try { compose = JSON.parse(m[1]); } catch (err) { composeError = `the <compose> block is not valid JSON (${err.message})`; }
  }
  const files = [...text.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)].map((f) => ({ path: f[1], content: trim(f[2]) }));
  const opened = (text.match(/<file path="/g) || []).length;
  return {
    fallback: false,
    compose,
    composeError,
    files,
    complete: Boolean(m) && opened === files.length && (text.includes('<done/>') || files.length > 0)
  };
}

const MODULE_TAG = /<module\s+op="(add|remove)"\s+id="([a-z0-9-]+)"\s*(?:\/>|>([\s\S]*?)<\/module>)/g;
const RESOURCE_TAG = /<resource\s+op="(add|remove)"(?:\s+name="([a-z0-9_]+)")?\s*(?:\/>|>([\s\S]*?)<\/resource>)/g;

/** Module and resource operations the model asked for while changing an existing repository. */
export function parseModuleOps(raw) {
  const text = unfence(raw);
  const ops = [];
  const resources = [];
  for (const m of text.matchAll(MODULE_TAG)) {
    let options = {};
    if (m[3]?.trim()) {
      try { options = JSON.parse(m[3]); } catch { throw new EngineError(`Options for module ${m[2]} are not valid JSON`, 'bad_compose'); }
    }
    ops.push({ op: m[1], id: m[2], options });
  }
  for (const m of text.matchAll(RESOURCE_TAG)) {
    if (m[1] === 'remove') { resources.push({ op: 'remove', name: m[2] }); continue; }
    try { resources.push({ op: 'add', spec: JSON.parse(m[3] ?? '') }); } catch { throw new EngineError('A <resource> block is not valid JSON', 'bad_compose'); }
  }
  return { ops, resources };
}

// --- turning a compose description into a project ----------------------------------------

export function normalizeCompose(catalog, raw) {
  const bad = (m) => new EngineError(`Invalid <compose> block: ${m}`, 'bad_compose');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('it must be a JSON object');
  const name = slugify(raw.name, 'app');
  const description = String(raw.description ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (raw.preset != null && !catalog.meta.presets[raw.preset]) throw bad(`unknown preset "${raw.preset}". Presets: ${Object.keys(catalog.meta.presets).join(', ')}`);
  const list = (v, what) => { if (v == null) return []; if (!Array.isArray(v)) throw bad(`${what} must be an array`); return v; };

  const modules = list(raw.modules, 'modules').map((m) => {
    const entry = typeof m === 'string' ? { id: m } : m;
    if (!entry || typeof entry.id !== 'string') throw bad('each module needs an "id"');
    return { id: entry.id, options: entry.options ?? {} };
  });
  const without = list(raw.without, 'without').map(String);
  const resources = list(raw.resources, 'resources');
  if (modules.length > 30) throw bad('too many modules');
  if (resources.length > 15) throw bad('too many resources');
  const extra = raw.extraDependencies ?? {};
  if (typeof extra !== 'object' || Array.isArray(extra)) throw bad('extraDependencies must be an object');
  return { name, description, preset: raw.preset ?? null, modules, without, resources, extraDependencies: extra, notes: String(raw.notes ?? '').slice(0, 600) };
}

function selectModules(catalog, compose) {
  const chosen = new Map();
  if (compose.preset) for (const m of presetModules(catalog, compose.preset)) chosen.set(m.id, m);
  for (const id of compose.without) chosen.delete(id);
  for (const m of compose.modules) {
    if (!catalog.modules.has(m.id)) continue; // reported by addModule with suggestions
    chosen.set(m.id, { id: m.id, options: { ...(chosen.get(m.id)?.options ?? {}), ...m.options } });
  }
  const seen = new Map();
  for (const m of chosen.values()) {
    const cap = catalog.modules.get(m.id).capability;
    if (!cap) continue;
    if (seen.has(cap)) throw new EngineError(`Choose one ${cap} provider: both ${seen.get(cap)} and ${m.id} were selected.`, 'module_conflict');
    seen.set(cap, m.id);
  }
  const unknown = compose.modules.filter((m) => !catalog.modules.has(m.id));
  return { list: [...chosen.values()].sort((a, b) => catalog.rank.get(a.id) - catalog.rank.get(b.id)), unknown };
}

const AI_DIRS = ['src/routes/', 'src/services/', 'src/domain/', 'src/jobs/', 'src/workers/', 'migrations/', 'test/'];
const PROTECTED = new Set(['src/routes/index.js', 'test/app.test.js']);
const MAX_AI_FILES = 25;

/** Place the model's own application code into the project, refusing to touch anything the engine owns. */
export function addAppFiles(project, files) {
  if (files.length > MAX_AI_FILES) throw new EngineError(`Too many application files (${files.length}, limit ${MAX_AI_FILES}).`, 'bad_files');
  for (const f of files) {
    const path = safePath(f.path);
    if (!path || !AI_DIRS.some((d) => path.startsWith(d))) {
      throw new EngineError(`${JSON.stringify(f.path)} is not allowed. Write application code only under ${AI_DIRS.join(', ')}.`, 'bad_files');
    }
    if (path.startsWith('migrations/') ? !/^migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path) : !path.endsWith('.js')) {
      throw new EngineError(`${path}: use .js files, and migrations named like migrations/0002_add_orders.sql.`, 'bad_files');
    }
    const owner = project.manifest.files[path];
    const exists = project.files.has(path);
    if (PROTECTED.has(path) || (exists && owner && !owner.userOwned)) {
      throw new EngineError(`${path} is managed by Morline modules and cannot be replaced.`, 'bad_files');
    }
    if (typeof f.content !== 'string' || !f.content.trim()) throw new EngineError(`${path} is empty.`, 'bad_files');
    project.files.set(path, f.content.endsWith('\n') ? f.content : `${f.content}\n`);
  }
}

/** Compose → full project. Throws EngineError (so the caller can ask the model to fix it). */
export function buildFromCompose(catalog, rawCompose, appFiles = [], hooks = {}) {
  const compose = normalizeCompose(catalog, rawCompose);
  const { list, unknown } = selectModules(catalog, compose);
  const project = Project.create(catalog, { name: compose.name, description: compose.description }, hooks);
  for (const u of unknown) project.addModule(u.id); // throws with "did you mean"
  for (const m of list) project.addModule(m.id, m.options);
  for (const r of compose.resources) project.addResource(r);
  if (Object.keys(compose.extraDependencies).length) project.addExtraDependencies(compose.extraDependencies);
  addAppFiles(project, appFiles);

  const checks = runChecks(project.files);
  if (checks.errors.length) throw new EngineError(`The generated project failed its checks:\n- ${checks.errors.join('\n- ')}`, 'checks_failed', checks);
  const result = project.finish();
  return { ...result, name: compose.name, description: compose.description, notes: compose.notes, warnings: [...result.warnings, ...checks.warnings] };
}

/** Change an existing, engine-generated repository. `read(path)` returns text or null. */
export async function planModuleChange(catalog, { paths, read, ops = [], resources = [], hooks = {} }) {
  const project = await Project.load(catalog, { paths, read }, hooks);
  for (const o of ops) {
    if (o.op === 'add') project.addModule(o.id, o.options ?? {});
    else if (o.op === 'remove') project.removeModule(o.id);
    else throw new EngineError(`Unknown module operation "${o.op}"`, 'bad_compose');
  }
  for (const r of resources) {
    if (r.op === 'add') project.addResource(r.spec);
    else project.removeResource(r.name);
  }
  return project.finish();
}
