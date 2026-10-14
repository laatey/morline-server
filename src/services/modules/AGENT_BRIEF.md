# Brief for the backend agent: wire in the module engine

You are integrating `morline-module-engine`, a self-contained folder. It changes **how the AI
builder produces server projects**: instead of the model writing every file from scratch, the
model picks modules from a catalog and writes only the app's own logic; the engine renders the
rest deterministically. Everything else in the app (actions, approval, diffs, GitHub commits,
revert) stays as it is.

Read `README.md` (2 min) and skim `lib/compose.js` and `lib/project.js`. Do not rewrite the
engine; it is tested. Wire it in.

## Ground rules (from the repo's own AGENTS.md; the engine already follows them)

- Plain Node 22 ESM, no build step, no new dependencies. The engine has none.
- **The AI only proposes.** The engine never executes anything, never calls the network, never
  writes to disk or GitHub. It returns data (`files`, `changes`, `envVars`, `addons`, ...). Your
  existing `create_app` / `modify_code` actions apply it after the user approves.
- Generated repos are the user's: no Morline imports, plain `npm start`, Dockerfile with
  `/health`, `PORT`, non-root user. Do not post-process the generated files.
- Add a kill switch: `MODULE_ENGINE=off` falls back to today's builder.

## 0. Install and verify (do this first)

1. Copy the folder to `src/services/modules/` (whole folder; the engine reads `catalog/` at
   runtime relative to its own files, so make sure your Docker image / deploy copies it).
2. `cd src/services/modules && npm test`. Expect **42 passing, 0 failing**. If anything fails,
   stop and report it.
3. `node scripts/demo.js` prints what the engine renders versus what the model writes.

## 1. New apps: `generateNewApp` (src/services/builder/generate.js)

```js
import { getCatalog, createModuleBuilder } from '../modules/index.js';

const modular = createModuleBuilder({ catalog: await getCatalog(), completeLong });

export async function generateNewApp(args) {            // same signature as today
  if (process.env.MODULE_ENGINE !== 'off') {
    const out = await modular.generateNewApp(args);     // args: { prompt, history, onStep }
    if (!out.fallback) return out;                      // fallback = not a Node server
  }
  return generateNewAppFromScratch(args);               // today's implementation, renamed
}
```

The returned object is a superset of what `proposeNewApp` (routes/assistant.js:373) already
consumes: `name, description, port, envVars, volume, files, notes`, plus
`modules[]`, `addons[]`, `services[]`, `warnings[]`, `steps[]`. `files` already passes
`validateNewFiles` (19 to 41 files depending on modules; the limit is 60). Keep calling it anyway.

Behaviour you must preserve or add in `proposeNewApp`:
- `envVars` keep today's meaning (`generate: true` means the platform generates the value, for
  example `JWT_SECRET`). Only variables the user must supply are listed; optional ones are in
  `.env.example` and README.
- Mention the chosen modules in the reply text, for example "Includes rate limiting, Resend
  email and PostgreSQL."
- If `warnings.length`, show them in the proposal.

### Addons (the one piece that needs your knowledge of the platform)

`addons` looks like `[{ kind: 'postgres', env: 'DATABASE_URL' }, { kind: 'redis', env: 'REDIS_URL' }]`.
Generated code expects the app to receive that env var. When the `create_app` action is
**applied** (never at proposal time):
1. after creating the service, provision a database of each `kind` in the same environment
   (see `src/engine/database-manager.js` and `src/routes/connections.js` for how a service gets
   connected to a database and which variable names are injected);
2. make sure the service gets the variable named in `env`. If your connections inject different
   names, change the one map in `catalog/node-fastify/catalog.json` (`"addons"`) instead of
   touching templates, then run `npm test`;
3. record what was created in the action's revert data so **revert** removes it too.
Supported kinds: `postgres`, `mongodb`, `redis`.

`services` (for example `{ name: 'worker', start: 'node src/worker.js' }` when background jobs are
added) is informational for now. Mention it in the reply text. Creating the second service is a
later, optional step.

## 2. Existing repos: `proposeCodeChange` / `generateChange` (routes/assistant.js:404)

Only for repos that contain `.morline/modules.json` (check the tree). Others use today's flow.

1. In the code-change system prompt append `changeAddendum(catalog, installedModuleIds)`
   (installed ids come from the manifest's `modules` keys).
2. After the model replies, run `parseModuleOps(text)`. If it returns ops or resources:
   ```js
   const result = await planModuleChange(catalog, {
     paths: new Set(tree.map((e) => e.path)),              // adapt to your tree entries
     read: async (p) => (paths.has(p) ? readFile(entryFor(p)) : null),
     ops, resources,
     hooks: { onStep: progress },                          // gives the icon + label steps
   });
   ```
   `result.changes` is `[{ path, action: 'create'|'update'|'delete', before, after }]`, the shape
   `resolveChanges` produces, so feed it to your existing `describeChanges` / `modify_code`
   action unchanged. Apply engine changes first, then the model's own `<change>` blocks; reject a
   model change that touches a path the engine changed.
3. `EngineError` messages are user-safe. Codes to handle:
   `not_modular` (use the normal flow), `patch_conflict` (the user restructured a wired file: tell
   them the module change needs a manual edit, then fall back to the normal flow),
   `has_dependents`, `unknown_module`, `bad_option`, `bad_resource`, `file_collision`.
   Show the message; do not retry silently.
4. Treat a change that deletes files as higher risk in the action (module removal deletes the
   module's files; `result.warnings` lists hand-edited files that were deleted or kept).
5. `result.envVars` / `result.addons` apply exactly as in section 1 when the action is applied.

## 3. Progress lines, so "Adding Resend email" can show the Resend logo

The engine reports steps through `onStep(text, { icon, module, op })`. Texts never say "Writing"
for module work: `Adding Resend email`, `Adding rate limiting`, `Connecting PostgreSQL`,
`Generating Orders API`, `Running security checks`. Only model-authored files get `Writing <path>`.

Backend change, `routes/assistant.js:562`:

```js
const textOf = (s) => (typeof s === 'string' ? s : s.text);
progress: (text, meta) => {
  if (!text || (steps.length && textOf(steps.at(-1)) === text)) return;
  steps.push(meta?.icon ? { text, icon: meta.icon } : text);
  send('status', meta?.icon ? { text, icon: meta.icon } : { text });
},
```
- Steps are saved as JSON in `assistant_messages.tool_calls`, so objects are fine. Update the
  OpenAPI `toolCalls` schema (openapi.yaml around line 2815) so `steps` items are
  `oneOf: [string, { text, icon }]`, and anywhere `steps` is validated or typed.
- Pass `progress` straight through as `onStep`; both builders already call `onStep(text)` and the
  second argument is optional, so existing callers keep working.
- `icon` is either a brand key (`resend`, `stripe`, `postgresql`...) or `lucide:<name>`.
- Frontend: apply `frontend/FRONTEND_CHANGES.md` (one file, about 30 lines) and add the logos
  (section 4). Until a logo file exists the step simply shows today's bulb.

## 4. Logos

Put files in **`morline-main/src/assets/providers/<key>.svg`** (new folder). The three database
logos already exist in `src/assets/stack/` and are reused. Needed (10):
`resend, postmark, sendgrid, anthropic, openai, gemini, stripe, paystack, s3, twilio`.
Rules (square mark, not wordmark; shown at 14 px; monochrome ones: resend, openai, anthropic) are
in `frontend/assets/providers/README.md`. `node scripts/icons.js <providers dir> <stack dir>`
reports what is missing. **Do not invent logos**; if the person who owns the repo has not
supplied them, leave the folder empty and the fallback bulb is used.

## 5. Before turning it on for users

1. `npm test` in the engine (offline, fast).
2. In an environment with network and, ideally, throwaway Postgres/Redis/Mongo, run
   `node conformance/run-presets.mjs` (set `CONFORMANCE_DATABASE_URL`, `CONFORMANCE_REDIS_URL`,
   `CONFORMANCE_MONGODB_URL`). It renders every preset, runs `npm install` and the project's own
   tests, boots it in production mode and probes it. **This has not been run yet** (the build
   environment had no network), so treat the generated projects as untested until it is green.
   Fix catalog templates, not the runner, if something fails, then re-run `npm test`.
3. One real end to end: ask the assistant for an API with auth, a database and email. Check the
   GitHub commit contains only what was asked for, the diff view reads well, and approve/revert
   works including the database addon.
4. Ship behind `MODULE_ENGINE`, default on in staging first.

## 6. Do not

- Edit generated files after rendering, or add Morline-specific imports to templates.
- Let model output reach a shell, `eval`, or the filesystem outside the engine's validated path.
- Loosen the option validation (`lib/options.js`), the model's file allow-list
  (`AI_DIRS` in `lib/compose.js`), or the resource name checks. Values from the model end up in
  generated source code, which is why they are strict.
- Change the catalog without running `npm test`: the add/remove round-trip tests check that any
  module added to or removed from any project equals generating that project from scratch.

## Known gaps (not bugs, not built yet)

- Node/Fastify only. The manifest, module format and conformance probes are runtime-neutral so
  Python and Go can be added as sibling catalogs (`catalog/<runtime>/`).
- No Sentry/OpenTelemetry module yet; no "upgrade this module" pull requests (the manifest
  already records file hashes to make that possible).
- LLM modules default to model names that will age; they are overridable with `LLM_MODEL`.
- Creating the extra worker service for background jobs is left to you (`services` tells you
  what to create).
