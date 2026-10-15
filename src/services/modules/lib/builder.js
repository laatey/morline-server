import { EngineError } from './util.js';
import { parseComposeOutput, buildFromCompose, normalizeCompose } from './compose.js';
import { presetModules } from './catalog.js';
import { buildSystemPrompt } from './prompt.js';

const asHistory = (history = []) => history
  .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
  .slice(-6)
  .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

/** Forward each step once, even if both the stream reporter and the build announce it. */
function dedupe(onStep) {
  const seen = new Set();
  return (text, meta) => {
    if (seen.has(text)) return;
    seen.add(text);
    onStep(text, meta);
  };
}

/**
 * Announces progress while the model is still writing: module steps as soon as the <compose>
 * block closes (it comes first), then one "Writing <file>" step per file block.
 */
function streamReporter(catalog, emit) {
  let announcedCompose = false;
  const files = new Set();
  return (soFar) => {
    if (!announcedCompose) {
      const m = soFar.match(/<compose>([\s\S]*?)<\/compose>/);
      if (m) {
        announcedCompose = true;
        try {
          const compose = normalizeCompose(catalog, JSON.parse(m[1]));
          const ids = new Map();
          if (compose.preset) for (const e of presetModules(catalog, compose.preset)) ids.set(e.id, true);
          for (const id of compose.without) ids.delete(id);
          for (const e of compose.modules) ids.set(e.id, true);
          for (const id of [...ids.keys()].sort((a, b) => (catalog.rank.get(a) ?? 0) - (catalog.rank.get(b) ?? 0))) {
            const def = catalog.modules.get(id);
            if (def && !def.internal) emit(def.label.add, { icon: def.icon, module: id, op: 'add' });
          }
          for (const r of compose.resources) {
            if (r?.name) emit(`Generating ${String(r.name).charAt(0).toUpperCase()}${String(r.name).slice(1)} API`, { icon: null, module: `resource:${r.name}`, op: 'add' });
          }
        } catch { /* the final parse reports any real problem */ }
      }
    }
    for (const f of soFar.matchAll(/<file path="([^"]+)">/g)) {
      if (!files.has(f[1])) { files.add(f[1]); emit(`Writing ${f[1]}`, { icon: null, op: 'write' }); }
    }
  };
}

/**
 * @param {object} deps
 * @param {object} deps.catalog         from getCatalog()
 * @param {Function} deps.completeLong  the platform's own completeLong from src/services/llm.js
 */
export function createModuleBuilder({ catalog, completeLong }) {
  const system = buildSystemPrompt(catalog);

  /**
   * Same contract as generateNewApp in src/services/builder/generate.js, plus `modules`, `addons`
   * and `services`. Returns { fallback: true } when the request is not a Node server, so the
   * caller can run the existing from-scratch builder instead.
   */
  async function generateNewApp({ prompt, history, onStep = () => {} }) {
    const emit = dedupe(onStep);
    const base = [...asHistory(history), { role: 'user', content: prompt }];

    const ask = (messages) => completeLong({
      system,
      messages,
      maxTokens: 12000,
      onText: (() => { const report = streamReporter(catalog, emit); return (_delta, soFar) => report(soFar); })(),
      isComplete: (t) => parseComposeOutput(t).complete
    });

    const assemble = (text) => {
      const out = parseComposeOutput(text);
      if (out.fallback) return { fallback: true };
      if (out.composeError) throw new EngineError(out.composeError, 'bad_compose');
      if (!out.compose) throw new EngineError('The reply had no <compose> block.', 'bad_compose');
      if (!out.complete) throw new EngineError('The reply was cut off before the project was finished.', 'truncated');
      const result = buildFromCompose(catalog, out.compose, out.files, { onStep: emit });
      emit('Running security checks', { icon: 'lucide:shield-check', op: 'check' });
      return {
        name: result.name,
        description: result.description,
        port: 3000,
        envVars: result.envVars,
        volume: null,
        files: result.files,
        notes: result.notes,
        modules: result.modules,
        addons: result.addons,
        services: result.services,
        warnings: result.warnings,
        steps: result.steps
      };
    };

    const text = await ask(base);
    try {
      return assemble(text);
    } catch (err) {
      if (!(err instanceof EngineError) || err.code === 'truncated') throw err;
      emit('Fixing a problem with the first attempt', { icon: null, op: 'fix' });
      const retry = await ask([...base, { role: 'assistant', content: text.slice(0, 8000) }, { role: 'user', content: `That could not be used: ${err.message}\nFix it and reply in the same format.` }]);
      return assemble(retry);
    }
  }

  return { generateNewApp };
}
