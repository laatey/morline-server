import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getCatalog, Project } from '../index.js';
import { presetModules } from '../lib/catalog.js';

export const catalogPromise = getCatalog();

/** Build a project from a list of modules the way the compose path does (rank order). */
export function projectWith(catalog, modules, name = 'demo') {
  const p = Project.create(catalog, { name, description: 'Demo project' });
  const list = modules.map((m) => (typeof m === 'string' ? { id: m, options: {} } : m));
  list.sort((a, b) => catalog.rank.get(a.id) - catalog.rank.get(b.id));
  for (const m of list) p.addModule(m.id, m.options);
  return p;
}

export const presetList = (catalog, preset) => presetModules(catalog, preset);

/** Write files to a temp dir and run `node --check` on every .js file. Returns failures. */
export async function syntaxCheck(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'engine-'));
  const failures = [];
  try {
    for (const [p, content] of files) {
      const full = path.join(dir, p);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    for (const [p] of files) {
      if (!p.endsWith('.js')) continue;
      try { execFileSync(process.execPath, ['--check', path.join(dir, p)], { stdio: 'pipe' }); }
      catch (err) { failures.push(`${p}: ${String(err.stderr).split('\n').slice(0, 4).join(' ')}`); }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return failures;
}

export const filesOf = (project) => new Map(project.files);

/** A fake repo reader over an in-memory file map. */
export const reader = (files) => ({
  paths: new Set(files.keys()),
  read: async (p) => (files.has(p) ? files.get(p) : null)
});
