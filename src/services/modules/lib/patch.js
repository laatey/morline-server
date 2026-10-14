// Small, dependency-free text patchers. Each one edits a file the engine generated in a way that
// leaves it looking hand-written, and throws a PatchConflict when the file no longer has the
// structure it expects (for example because the user rewrote it). Callers turn that into a
// "do this as a normal code change instead" answer.

import { EngineError, sortedObject } from './util.js';

export const conflict = (path, why) => new EngineError(`Could not update ${path} automatically: ${why}`, 'patch_conflict', { path });

/**
 * Insert `newLines` into ls[from, to) just before the first line whose catalog rank is greater than
 * `rank`; otherwise after the last non-blank line. Lines the catalog doesn't know about (the
 * base's own lines, anything the user added) are never moved and never block insertion.
 */
export function insertOrdered(ls, from, to, newLines, rank, lineRank) {
  let at = -1;
  for (let i = from; i < to; i++) {
    const r = lineRank.get(ls[i]);
    if (r !== undefined && r > rank) { at = i; break; }
  }
  if (at === -1) {
    at = to;
    while (at > from && ls[at - 1].trim() === '') at--;
  }
  ls.splice(at, 0, ...newLines);
}

/** Remove the first occurrence of each line. Missing lines are ignored (the user may have removed them). */
export function removeLines(text, toRemove) {
  const ls = text.split('\n');
  for (const line of toRemove) {
    const i = ls.indexOf(line);
    if (i !== -1) ls.splice(i, 1);
  }
  return ls.join('\n');
}

// --- package.json ----------------------------------------------------------------------------

export function readPackage(text, path = 'package.json') {
  try { return JSON.parse(text); } catch { throw conflict(path, 'it is not valid JSON'); }
}

export const writePackage = (pkg) => `${JSON.stringify(pkg, null, 2)}\n`;

export function normalizePackage(text) {
  const pkg = readPackage(text);
  if (pkg.dependencies) pkg.dependencies = sortedObject(pkg.dependencies);
  return writePackage(pkg);
}

export function syncDependencies(text, { previous, wanted, protectedNames = [] }) {
  const pkg = readPackage(text);
  pkg.dependencies ??= {};
  for (const name of Object.keys(previous)) {
    if (!(name in wanted) && !protectedNames.includes(name)) delete pkg.dependencies[name];
  }
  for (const [name, version] of Object.entries(wanted)) {
    if (!(name in pkg.dependencies)) pkg.dependencies[name] = version;
  }
  pkg.dependencies = sortedObject(pkg.dependencies);
  return writePackage(pkg);
}

// --- src/app.js wiring ----------------------------------------------------------------------

const HEADER = /^ {2}\/\/ -- ([a-z]+) --$/;
const phaseHeader = (phase) => `  // -- ${phase} --`;

export function addImports(text, importLines, rank, lineRank, path = 'src/app.js') {
  const ls = text.split('\n');
  const first = ls.findIndex((l) => l.startsWith('import '));
  if (first < 0) throw conflict(path, 'it has no import statements');
  let last = first;
  while (last + 1 < ls.length && ls[last + 1].startsWith('import ')) last++;
  insertOrdered(ls, first, last + 1, importLines, rank, lineRank);
  return ls.join('\n');
}

function parseRegion(text, path) {
  const ls = text.split('\n');
  const start = ls.findIndex((l) => HEADER.test(l));
  const end = ls.findIndex((l, i) => i > start && l === '  return app;');
  if (start < 0 || end < 0) throw conflict(path, 'the plugin registration section was changed');
  const blocks = [];
  for (const line of ls.slice(start, end)) {
    const m = HEADER.exec(line);
    if (m) blocks.push({ phase: m[1], lines: [] });
    else blocks.at(-1).lines.push(line);
  }
  for (const b of blocks) while (b.lines.length && b.lines.at(-1).trim() === '') b.lines.pop();
  return { ls, start, end, blocks };
}

function writeRegion({ ls, start, end, blocks }) {
  const body = blocks.flatMap((b) => [phaseHeader(b.phase), ...b.lines, '']);
  return [...ls.slice(0, start), ...body, ...ls.slice(end)].join('\n');
}

export function addRegistrations(text, phase, regLines, rank, lineRank, phases, path = 'src/app.js') {
  const region = parseRegion(text, path);
  let block = region.blocks.find((b) => b.phase === phase);
  if (!block) {
    block = { phase, lines: [] };
    const myIndex = phases.indexOf(phase);
    let at = region.blocks.findIndex((b) => phases.indexOf(b.phase) > myIndex);
    if (at === -1) at = region.blocks.length;
    region.blocks.splice(at, 0, block);
  }
  insertOrdered(block.lines, 0, block.lines.length, regLines, rank, lineRank);
  return writeRegion(region);
}

export function removeRegistrations(text, regLines, path = 'src/app.js') {
  const region = parseRegion(text, path);
  for (const b of region.blocks) {
    for (const line of regLines) {
      const i = b.lines.indexOf(line);
      if (i !== -1) b.lines.splice(i, 1);
    }
  }
  region.blocks = region.blocks.filter((b) => b.lines.length || b.phase === 'core');
  return writeRegion(region);
}

// --- .env.example ---------------------------------------------------------------------------

const splitBlocks = (text) => text.trimEnd().split(/\n\s*\n/).map((b) => b.split('\n'));
const joinBlocks = (blocks) => `${blocks.map((b) => b.join('\n')).join('\n\n')}\n`;

export function addEnvBlock(text, blockLines, rank, lineRank) {
  const blocks = splitBlocks(text);
  let at = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    const r = lineRank.get(blocks[i][0]);
    if (r !== undefined && r > rank) { at = i; break; }
  }
  blocks.splice(at, 0, blockLines);
  return joinBlocks(blocks);
}

export function removeEnvBlock(text, header) {
  return joinBlocks(splitBlocks(text).filter((b) => b[0] !== header));
}

// --- README.md ------------------------------------------------------------------------------

function sectionBounds(ls, heading, path) {
  const start = ls.indexOf(heading);
  if (start < 0) throw conflict(path, `the "${heading.replace(/^## /, '')}" section was removed`);
  let end = ls.length;
  for (let i = start + 1; i < ls.length; i++) if (ls[i].startsWith('## ')) { end = i; break; }
  return [start + 1, end];
}

export function addReadmeLines(text, heading, newLines, rank, lineRank, path = 'README.md') {
  const ls = text.split('\n');
  const [from, to] = sectionBounds(ls, heading, path);
  insertOrdered(ls, from, to, newLines, rank, lineRank);
  return ls.join('\n');
}
