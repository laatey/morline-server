# Adding or changing a module

A module is a folder: `catalog/node-fastify/modules/<id>/module.json` plus `files/` (templates).

```jsonc
{
  "id": "rate-limit", "name": "Rate limiting", "category": "security",
  "icon": "lucide:gauge",              // brand key (file in src/assets/providers) or lucide:<name>
  "order": 32,                         // wiring order; unique ranks come from (order, id)
  "summary": "...",                    // the AI card: what it gives and how to call it (<= 220 chars)
  "label": { "add": "Adding rate limiting", "remove": "Removing rate limiting" },
  "capability": "email",               // optional: only one module per capability at a time (swap)
  "internal": true,                    // optional: never shown to the model, added/removed automatically
  "requires": ["redis"],               // other modules; "requiresWhen": { "store=redis": ["redis"] }
  "addons": ["postgres"],              // platform databases the module needs
  "options": { "max": { "type": "int", "min": 1, "max": 10000, "default": 100 } },
                                       // types: int, bool, enum, duration, string (all strictly validated)
  "variantBy": "db", "variants": { "postgres": { "requires": [...], "files": [...] } },
  "wiring": { "phase": "security", "imports": ["import x from './plugins/x.js';"], "register": ["await app.register(x);"] },
  "readme": { "features": ["- **Feature**: one line"] },
  "env": [{ "key": "X_KEY", "required": true, "description": "one line, no | characters", "generate": false, "provisioned": false }],
  "deps": { "pkg": "^1.2.3" },         // caret ranges only; the same package must use the same version everywhere
  "services": [{ "name": "worker", "start": "node src/worker.js", "description": "..." }],
  "files": [{ "from": "x.js", "to": "src/plugins/x.js", "when": { "store": "memory" }, "userOwned": false }]
}
```

Rules the tests enforce:
- Templates may use `{{option}}` and `{{option|json}}` for declared options and `{{name}}`, `{{slug}}`, `{{description}}`.
- Contributed lines (imports, registrations, README rows, env blocks) are **static**: the engine has to find the exact same text again to remove them.
- Every plugin that adds hooks or decorators is wrapped in `fastify-plugin` (`fp`), otherwise it will not apply to later routes.
- Read configuration through `env` (`src/lib/env.js`), never `process.env`. Every variable must be in `env[]` (it becomes `.env.example` and the README table).
- `userOwned: true` files are scaffolding the user is expected to fill in (event handlers, job lists). They are never deleted if edited.
- Tests inside templates are named `*.test.js.tpl` so test runners do not pick them up here. Keep them self-contained: build a bare Fastify instance with only that plugin, no database.
- After any change run `npm test`. The key property tests: adding module M to project P equals generating P+M from scratch, and removing M restores P, byte for byte.
