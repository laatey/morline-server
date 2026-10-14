import { EngineError, stableJson } from './util.js';

/** Where the engine records what it generated. Deleting this file just turns the repo into a normal project. */
export const MANIFEST_PATH = '.morline/modules.json';

export function emptyManifest(runtime, project) {
  return { engine: 1, runtime, project, modules: {}, resources: {}, files: {}, deps: {}, extraDeps: {} };
}

export function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { throw new EngineError('.morline/modules.json is not valid JSON', 'not_modular'); }
  if (!m || m.engine !== 1 || typeof m.modules !== 'object') throw new EngineError('.morline/modules.json is not a Morline modules file', 'not_modular');
  return { resources: {}, files: {}, deps: {}, extraDeps: {}, ...m };
}

export const serializeManifest = (m) => stableJson(m);
