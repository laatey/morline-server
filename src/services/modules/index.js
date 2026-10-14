// Morline module engine. Pure string-in, string-out: it never touches the network, the disk
// (outside loading its own catalog) or a shell, and it never runs anything the model wrote.

export { getCatalog, loadCatalog, presetModules } from './lib/catalog.js';
export { Project } from './lib/project.js';
export { createModuleBuilder } from './lib/builder.js';
export { buildFromCompose, planModuleChange, parseComposeOutput, parseModuleOps, normalizeCompose } from './lib/compose.js';
export { buildSystemPrompt, changeAddendum, catalogCards } from './lib/prompt.js';
export { runChecks } from './lib/checks.js';
export { MANIFEST_PATH } from './lib/manifest.js';
export { EngineError } from './lib/util.js';
