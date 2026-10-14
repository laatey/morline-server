# morline-module-engine

Composes production-ready Node.js (Fastify) server projects from a catalog of modules, so the AI
builder writes only the app's own logic instead of the whole server. Zero dependencies, no network,
no shell: string in, string out.

```
index.js                    public API
lib/                        engine (catalog, project state machine, patchers, CRUD generator, checks, prompts)
catalog/node-fastify/       base project + 24 modules + 5 presets
test/                       42 offline tests (npm test)
conformance/                end-to-end runner: needs network and real services
scripts/                    icons.js (logos needed), demo.js (tokens rendered vs written)
frontend/                   step-icon component, logo rules, the ~30-line UI change
AGENT_BRIEF.md             start here if you are wiring this into the backend
```

How it works in one paragraph: the model replies with a small `<compose>` block (preset, modules,
options, data models) plus the app's own route/service files. `buildFromCompose` renders the base
project and applies each module as a set of file additions and small edits to four shared files
(`package.json`, `src/app.js`, `.env.example`, `README.md`). Removal reverses the same edits, so a
repo only ever contains the code of the modules it uses. `.morline/modules.json` records what was
generated so later "add Resend" or "remove CORS" requests become reviewable diffs.
