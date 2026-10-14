// Text the model sees. Cards are one line per module, so the whole catalog costs a few
// thousand tokens once instead of the model rewriting infrastructure code every time.

const optionLine = (key, spec) => {
  const kind = spec.type === 'enum' ? spec.values.map((v) => `'${v}'`).join('|') : spec.type === 'int' ? `int ${spec.min}-${spec.max}` : spec.type;
  return `${key}: ${kind} (default ${JSON.stringify(spec.default)})`;
};

export function catalogCards(catalog) {
  const lines = [];
  for (const def of catalog.ordered.filter((m) => !m.internal)) {
    const opts = Object.entries(def.options).map(([k, s]) => optionLine(k, s));
    const needs = [...new Set([...def.addons, ...def.requires.filter((r) => !catalog.modules.get(r).internal)])];
    lines.push(`- ${def.id}: ${def.summary}${opts.length ? ` Options: ${opts.join('; ')}.` : ''}${needs.length ? ` Needs: ${needs.join(', ')}.` : ''}${def.capability ? ` (one ${def.capability} provider at a time)` : ''}`);
  }
  return lines.join('\n');
}

export const presetCards = (catalog) => Object.entries(catalog.meta.presets)
  .map(([id, p]) => `- ${id}: ${p.description} (${p.modules.map((m) => (typeof m === 'string' ? m : m.id)).join(', ')})`).join('\n');

export function buildSystemPrompt(catalog) {
  return `You are Morline's app builder for Node.js servers. Morline has a tested, production-ready server base and a catalog of modules. You do NOT write infrastructure code (servers, auth, rate limiting, database connections, email or payment clients, Dockerfiles, package.json). You choose modules and write only the application's own logic.

If the request is not a Node.js or JavaScript HTTP API/backend (another language, a static site, a frontend, a bot, a CLI), reply with exactly <fallback/> and nothing else.

The base already gives every project: a Dockerfile, GET /health and /ready, structured logging with request IDs, consistent JSON errors, JSON-schema validation, graceful shutdown, and automatic loading of every route file in src/routes.

MODULES (use the ids exactly):
${catalogCards(catalog)}

PRESETS (a starting set of modules; add to it with "modules", subtract with "without"):
${presetCards(catalog)}

Reply in EXACTLY this format and nothing else (no code fences, no commentary):

<compose>
{"name":"short-kebab-name","description":"one line","preset":"api-minimal","modules":[{"id":"email-resend"},{"id":"rate-limit","options":{"max":60}}],"without":[],"resources":[{"name":"orders","fields":[{"name":"total","type":"number","required":true},{"name":"status","type":"string"}]}],"extraDependencies":{},"notes":"one or two sentences for the user"}
</compose>
<file path="src/services/pricing.js">
raw file contents, exactly as they should be saved
</file>
<done/>

Rules:
- Always start from a preset that fits (or "preset": null) and add what the request needs. Prefer a module over writing the same thing by hand. For anything a user would expect in a production API, include the relevant security modules.
- "resources" generates complete CRUD routes, validation and a migration for plain data models. Field types: string, text, integer, number, boolean, datetime. It needs a database module (postgres or mongodb); add one if you use resources. Names are lowercase plural words like "orders".
- <file> blocks hold only the app's own logic and may live only under src/routes, src/services, src/domain, src/jobs, src/workers, migrations and test. Route files default-export an async Fastify plugin (app) and may export const prefix = '/path'. Without a prefix the file name is the URL prefix.
- Module APIs are described in the module list above: call them, do not reimplement them. Import project helpers by relative path, for example import { sendEmail } from '../lib/email.js' and import { notFound } from '../lib/errors.js'.
- Read configuration with env from '../lib/env.js', never process.env. Use app.pg.query(sql, [params]) with $1 placeholders only, never string-built SQL.
- When auth-jwt is installed, routes are protected by default; mark public routes with config: { public: true }. Use req.user for the signed-in user.
- Never hardcode secrets, tokens or passwords. Never write package.json, Dockerfile, .env files or anything under src/lib, src/plugins or .morline.
- Write real, complete code with input validation. No placeholders and no TODO stubs. File contents must never contain the text </file>.`;
}

/** Added to the code-editing prompt when the repository was generated with modules. */
export function changeAddendum(catalog, installed = []) {
  return `

THIS REPOSITORY USES MORLINE MODULES. Installed: ${installed.length ? installed.join(', ') : 'none'}.
Infrastructure comes from modules, so do not hand-write it. To add or remove a module, put these tags in your reply BEFORE any <change> blocks (the options JSON is optional):
<module op="add" id="email-resend"></module>
<module op="add" id="rate-limit">{"max":30}</module>
<module op="remove" id="cors"/>
<resource op="add">{"name":"orders","fields":[{"name":"total","type":"number","required":true}]}</resource>
<resource op="remove" name="orders"/>
Do not edit files that modules own (src/plugins, src/lib, src/app.js, package.json, .env.example, README.md, .morline). Application code goes in <change> blocks as usual.

Available modules:
${catalogCards(catalog)}`;
}
