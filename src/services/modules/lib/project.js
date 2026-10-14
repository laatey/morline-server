import { EngineError, renderTemplate, sha, slugify, sortedObject } from './util.js';
import { resolveOptions, optionsMatch } from './options.js';
import { viewOf, contributions } from './catalog.js';
import { MANIFEST_PATH, emptyManifest, parseManifest, serializeManifest } from './manifest.js';
import * as patch from './patch.js';
import { buildResource } from './resources.js';

const PKG = 'package.json';
const APP = 'src/app.js';
const ENV = '.env.example';
const README = 'README.md';
const FEATURES = '## Features';
const ENV_TABLE = '## Environment variables';

const unknownModule = (catalog, id) => {
  const near = [...catalog.modules.keys()].filter((k) => !catalog.modules.get(k).internal && (k.includes(String(id).split('-')[0]) || String(id).includes(k.split('-')[0])));
  return new EngineError(`Unknown module "${id}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`, 'unknown_module');
};

/**
 * An in-memory project. Every operation edits `files` (a Map of path -> text) and the manifest;
 * `finish()` diffs against where we started. Nothing here touches disk, the network or GitHub.
 */
export class Project {
  constructor(catalog, files, manifest, { initial = new Map(files), onStep = () => {} } = {}) {
    this.catalog = catalog;
    this.files = files;
    this.manifest = manifest;
    this.initial = initial;
    this.onStep = onStep;
    this.steps = [];
    this.added = new Set();
    this.removed = new Set();
    this.warnings = [];
    this.replaced = [];
  }

  // --- construction ---------------------------------------------------------------------

  static create(catalog, { name, description = '' }, hooks = {}) {
    const slug = slugify(name);
    const vars = { name, slug, description: String(description).replace(/[\r\n]+/g, ' ').slice(0, 200) };
    const files = new Map();
    for (const [p, content] of catalog.base) files.set(p, renderTemplate(content, vars, `base/${p}`));
    files.set(PKG, patch.normalizePackage(files.get(PKG)));
    const manifest = emptyManifest(catalog.meta.runtime, { name, slug, description: vars.description });
    const project = new Project(catalog, files, manifest, { initial: new Map(), ...hooks });
    project.writeManifest();
    return project;
  }

  /** Load an existing repo. `read(path)` returns text or null; `paths` is every path in the repo. */
  static async load(catalog, { paths, read }, hooks = {}) {
    const text = await read(MANIFEST_PATH);
    if (text == null) throw new EngineError('This repository was not generated with Morline modules, so modules cannot be added or removed automatically.', 'not_modular');
    const manifest = parseManifest(text);
    if (manifest.runtime !== catalog.meta.runtime) throw new EngineError(`This repository uses runtime "${manifest.runtime}", which this engine build does not handle.`, 'not_modular');
    const wanted = new Set([PKG, APP, ENV, README, MANIFEST_PATH, ...Object.keys(manifest.files)]);
    const files = new Map();
    for (const p of wanted) {
      if (!paths.has(p)) continue;
      const content = await read(p);
      if (content != null) files.set(p, content);
    }
    const project = new Project(catalog, files, manifest, hooks);
    project.paths = paths;
    return project;
  }

  // --- queries --------------------------------------------------------------------------

  has(id) { return Object.prototype.hasOwnProperty.call(this.manifest.modules, id); }
  get installed() { return Object.keys(this.manifest.modules); }
  get db() { return this.has('postgres') ? 'postgres' : this.has('mongodb') ? 'mongodb' : null; }
  allPaths() { return new Set([...(this.paths ?? []), ...this.files.keys()]); }

  #def(id) {
    const def = this.catalog.modules.get(id);
    if (!def) throw unknownModule(this.catalog, id);
    return def;
  }

  #view(id) {
    const entry = this.manifest.modules[id];
    return viewOf(this.#def(id), entry.options, entry.variant);
  }

  #dependents(id, ignore = new Set()) {
    const out = this.installed.filter((m) => m !== id && !ignore.has(m) && this.#view(m).requires.includes(id)).map((m) => this.#def(m).name);
    for (const [name, r] of Object.entries(this.manifest.resources)) if (r.db === id) out.push(`resource "${name}"`);
    return out;
  }

  // --- low-level edits ------------------------------------------------------------------

  #edit(path, fn) {
    const text = this.files.get(path);
    if (text === undefined) throw patch.conflict(path, 'the file is missing');
    this.files.set(path, fn(text));
  }

  writeManifest() { this.files.set(MANIFEST_PATH, serializeManifest(this.manifest)); }

  #step(def, op, extra = {}) {
    if (def.internal) return;
    const text = def.label[op === 'remove' ? 'remove' : 'add'];
    const step = { text: op === 'update' ? `Updating ${def.name}` : text, icon: def.icon, module: def.id, op, ...extra };
    this.steps.push(step);
    this.onStep(step.text, { icon: step.icon, module: step.module, op });
  }

  #wanted() {
    const deps = { ...this.manifest.extraDeps };
    for (const id of this.installed) Object.assign(deps, this.#view(id).deps);
    return sortedObject(deps);
  }

  #syncDeps() {
    const wanted = this.#wanted();
    this.#edit(PKG, (t) => patch.syncDependencies(t, { previous: this.manifest.deps, wanted, protectedNames: Object.keys(this.manifest.extraDeps) }));
    this.manifest.deps = wanted;
  }

  // --- modules --------------------------------------------------------------------------

  addModule(id, given = {}, ctx = {}) {
    const def = this.#def(id);
    const stack = ctx.stack ?? [];
    if (stack.includes(id)) throw new EngineError(`Circular module requirement: ${[...stack, id].join(' -> ')}`, 'catalog_invalid');
    if (def.internal && !ctx.reason) throw new EngineError(`"${id}" is added automatically when a module needs it.`, 'internal_module');

    const current = this.manifest.modules[id];
    if (current) {
      const next = resolveOptions(id, def.options, { ...current.options, ...given });
      if (JSON.stringify(next) === JSON.stringify(current.options)) return false;
      this.removeModule(id, { reconfigure: true });
      this.#step(def, 'update');
      return this.#install(def, { ...next }, ctx, { quiet: true });
    }
    for (const other of def.conflicts) {
      if (this.has(other)) throw new EngineError(`${def.name} cannot be combined with ${this.#def(other).name}. Remove one of them first.`, 'module_conflict');
    }
    if (def.capability) {
      const holder = this.installed.find((m) => m !== id && this.#def(m).capability === def.capability);
      if (holder) {
        this.replaced.push({ from: holder, to: id, capability: def.capability });
        this.removeModule(holder, { replacedBy: id });
      }
    }
    return this.#install(def, given, ctx);
  }

  #install(def, given, ctx, { quiet = false } = {}) {
    const id = def.id;
    const options = resolveOptions(id, def.options, given);
    let variant = null;
    if (def.variantBy) {
      if (options[def.variantBy] === 'auto') options[def.variantBy] = this.has('mongodb') && !this.has('postgres') ? 'mongodb' : 'postgres';
      variant = options[def.variantBy];
    }
    const view = viewOf(def, options, variant);
    for (const req of view.requires) {
      if (!this.has(req)) this.addModule(req, {}, { reason: id, stack: [...(ctx.stack ?? []), id] });
    }
    if (!quiet) this.#step(def, 'add');

    const vars = { name: this.manifest.project.name, slug: this.manifest.project.slug, description: this.manifest.project.description, ...options };
    for (const f of view.files) {
      if (f.when && !optionsMatch(f.when, options)) continue;
      const content = renderTemplate(def.templates.get(f.from), vars, `${id}/${f.from}`);
      const existing = this.files.get(f.to);
      if (existing !== undefined && existing !== content && !f.userOwned) {
        throw new EngineError(`Cannot add ${def.name}: ${f.to} already exists with different content.`, 'file_collision', { path: f.to });
      }
      if (existing === undefined) this.files.set(f.to, content);
      this.manifest.files[f.to] = { owner: id, sha: sha(content), ...(f.userOwned ? { userOwned: true } : {}) };
    }
    this.manifest.modules[id] = { options, variant };
    this.#syncDeps();

    const rank = this.catalog.rank.get(id);
    const c = contributions(def);
    if (c.wiring) {
      if (c.wiring.imports.length) this.#edit(APP, (t) => patch.addImports(t, c.wiring.imports, rank, this.catalog.lineRank));
      if (c.wiring.register.length) this.#edit(APP, (t) => patch.addRegistrations(t, c.wiring.phase, c.wiring.register, rank, this.catalog.lineRank, this.catalog.meta.phases));
    }
    if (c.envBlock) this.#edit(ENV, (t) => patch.addEnvBlock(t, c.envBlock, rank, this.catalog.lineRank));
    if (c.features.length) this.#edit(README, (t) => patch.addReadmeLines(t, FEATURES, c.features, rank, this.catalog.lineRank));
    if (c.envRows.length) this.#edit(README, (t) => patch.addReadmeLines(t, ENV_TABLE, c.envRows, rank, this.catalog.lineRank));

    this.removed.delete(id);
    this.added.add(id);
    this.writeManifest();
    return true;
  }

  removeModule(id, { reconfigure = false, replacedBy = null, cascade = false } = {}) {
    const def = this.#def(id);
    if (!this.has(id)) return false;
    if (!reconfigure && !replacedBy) {
      const dependents = this.#dependents(id);
      if (dependents.length && !cascade) throw new EngineError(`Cannot remove ${def.name}: ${dependents.join(', ')} depend${dependents.length === 1 ? 's' : ''} on it. Remove those first.`, 'has_dependents', { dependents });
    }
    if (!reconfigure) this.#step(def, 'remove', replacedBy ? { replacedBy } : {});

    for (const [path, meta] of Object.entries(this.manifest.files)) {
      if (meta.owner !== id) continue;
      const current = this.files.get(path);
      delete this.manifest.files[path];
      if (current === undefined) continue;
      const pristine = sha(current) === meta.sha;
      if (meta.userOwned && !pristine) { this.warnings.push(`Kept ${path} because it contains your own code.`); continue; }
      if (!pristine) this.warnings.push(`${path} had been edited by hand and was deleted along with ${def.name}.`);
      this.files.delete(path);
    }
    const c = contributions(def);
    if (c.wiring) {
      this.#edit(APP, (t) => patch.removeRegistrations(patch.removeLines(t, c.wiring.imports), c.wiring.register));
    }
    if (c.envHeader) this.#edit(ENV, (t) => patch.removeEnvBlock(t, c.envHeader));
    if (c.features.length) this.#edit(README, (t) => patch.removeLines(t, c.features));
    if (c.envRows.length) this.#edit(README, (t) => patch.removeLines(t, c.envRows));
    delete this.manifest.modules[id];
    this.#syncDeps();
    this.added.delete(id);
    if (!reconfigure) this.removed.add(id);

    if (!reconfigure) this.#collectOrphans();
    this.writeManifest();
    return true;
  }

  /** Internal helpers (like the HTTP client) go away when nothing needs them any more. */
  #collectOrphans() {
    for (const m of this.installed) {
      if (this.#def(m).internal && !this.#dependents(m).length) this.removeModule(m, { cascade: true });
    }
  }

  // --- resources ------------------------------------------------------------------------

  addResource(spec, { db } = {}) {
    let target = db ?? this.db;
    if (!target) { this.addModule('postgres'); target = 'postgres'; }
    if (!this.has(target)) this.addModule(target);
    const { res, files } = buildResource(spec, target, this.allPaths());
    if (this.manifest.resources[res.name]) throw new EngineError(`Resource "${res.name}" already exists.`, 'bad_resource');
    for (const f of files) {
      if (this.allPaths().has(f.path)) throw new EngineError(`Cannot generate "${res.name}": ${f.path} already exists.`, 'file_collision', { path: f.path });
    }
    for (const f of files) {
      this.files.set(f.path, f.content);
      this.manifest.files[f.path] = { owner: `resource:${res.name}`, sha: sha(f.content), ...(f.path.startsWith('migrations/') ? { keep: true } : {}) };
    }
    this.manifest.resources[res.name] = { db: target, fields: res.fields };
    const label = res.name.charAt(0).toUpperCase() + res.name.slice(1);
    const step = { text: `Generating ${label} API`, icon: 'lucide:database', module: `resource:${res.name}`, op: 'add' };
    this.steps.push(step);
    this.onStep(step.text, { icon: step.icon, module: step.module, op: 'add' });
    this.writeManifest();
  }

  removeResource(name) {
    if (!this.manifest.resources[name]) throw new EngineError(`There is no generated resource "${name}".`, 'bad_resource');
    for (const [path, meta] of Object.entries(this.manifest.files)) {
      if (meta.owner !== `resource:${name}`) continue;
      delete this.manifest.files[path];
      if (meta.keep) { this.warnings.push(`Kept ${path}: removing a resource never drops its database table.`); continue; }
      this.files.delete(path);
    }
    delete this.manifest.resources[name];
    this.steps.push({ text: `Removing ${name} API`, icon: 'lucide:database', module: `resource:${name}`, op: 'remove' });
    this.writeManifest();
  }

  /** Dependencies the model asked for beyond the catalog. Exact names and caret versions only. */
  addExtraDependencies(deps = {}) {
    const entries = Object.entries(deps);
    if (entries.length > 8) throw new EngineError('Too many extra dependencies (limit 8).', 'bad_dependency');
    for (const [name, version] of entries) {
      if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name) || name.length > 100) throw new EngineError(`"${name}" is not a valid package name.`, 'bad_dependency');
      if (!/^\^\d+\.\d+\.\d+$/.test(String(version))) throw new EngineError(`Use a caret version like ^1.2.3 for ${name}.`, 'bad_dependency');
      this.manifest.extraDeps[name] = version;
    }
    this.#syncDeps();
    this.writeManifest();
  }

  // --- results --------------------------------------------------------------------------

  finish() {
    const changes = [];
    for (const [path, after] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const before = this.initial.get(path);
      if (before === undefined) changes.push({ path, action: 'create', before: null, after });
      else if (before !== after) changes.push({ path, action: 'update', before, after });
    }
    for (const [path, before] of this.initial) if (!this.files.has(path)) changes.push({ path, action: 'delete', before, after: null });

    const envVars = [];
    const addons = [];
    const services = [];
    for (const id of this.added) {
      const def = this.#def(id);
      const entry = this.manifest.modules[id];
      const view = viewOf(def, entry.options, entry.variant);
      for (const v of def.env) {
        if (v.provisioned) continue;
        if (v.required || v.generate) envVars.push({ key: v.key, description: v.description, generate: v.generate === true });
      }
      for (const kind of view.addons) addons.push({ kind, env: this.catalog.meta.addons[kind] });
      for (const s of def.services) services.push({ ...s, module: id });
    }
    const named = (ids) => [...ids].map((i) => this.#def(i)).filter((d) => !d.internal).map((d) => d.name);
    const parts = [];
    if (this.added.size) parts.push(`Added ${named(this.added).join(', ')}`);
    if (this.removed.size) parts.push(`Removed ${named(this.removed).join(', ')}`);
    return {
      files: [...this.files].map(([path, content]) => ({ path, content })),
      changes,
      steps: this.steps,
      envVars,
      addons: [...new Map(addons.map((a) => [a.kind, a])).values()],
      services,
      warnings: this.warnings,
      replaced: this.replaced,
      modules: this.installed.filter((m) => !this.#def(m).internal),
      summary: parts.join('. ')
    };
  }
}
