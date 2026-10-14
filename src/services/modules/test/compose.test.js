import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromise } from '../test-support/helpers.js';
import { buildFromCompose, parseComposeOutput, parseModuleOps, createModuleBuilder, buildSystemPrompt, changeAddendum, EngineError } from '../index.js';

const route = `export const prefix = '/quotes';

export default async function quotes(app) {
  app.get('/', { config: { public: true } }, async () => ({ items: [] }));
}
`;

test('parses the tagged reply and tolerates fences', () => {
  const raw = '```\n<compose>{"name":"a","preset":"api-minimal"}</compose>\n<file path="src/routes/a.js">\nexport default async function a() {}\n</file>\n<done/>\n```';
  const out = parseComposeOutput(raw);
  assert.equal(out.compose.name, 'a');
  assert.equal(out.files[0].content, 'export default async function a() {}');
  assert.equal(out.complete, true);
  assert.equal(parseComposeOutput('<fallback/>').fallback, true);
  assert.equal(parseComposeOutput('<compose>{"name":"a"}</compose>\n<file path="src/routes/a.js">\nhalf').complete, false, 'a cut-off file block is not complete');
  assert.match(parseComposeOutput('<compose>{nope}</compose>').composeError, /not valid JSON/);
});

test('builds a project from a compose block and the model\'s own files', async () => {
  const catalog = await catalogPromise;
  const r = buildFromCompose(catalog, {
    name: 'Quotes API', description: 'Quotes', preset: 'api-minimal',
    modules: [{ id: 'email-resend' }, { id: 'rate-limit', options: { max: 30 } }],
    without: ['cors'],
    resources: [{ name: 'quotes', fields: [{ name: 'text', type: 'text', required: true }] }]
  }, [{ path: 'src/routes/health-extra.js', content: route }]);

  assert.equal(r.name, 'quotes-api');
  assert.deepEqual(r.modules.sort(), ['email-resend', 'postgres', 'rate-limit', 'security-headers']);
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes('src/routes/health-extra.js') && paths.includes('src/routes/quotes.js'));
  assert.ok(!paths.includes('src/plugins/cors.js'));
  assert.match(r.files.find((f) => f.path === 'src/plugins/rate-limit.js').content, /max: 30,/);
  assert.deepEqual(r.envVars.map((v) => v.key), ['RESEND_API_KEY']);
});

test('the model cannot overwrite or smuggle files outside its area', async () => {
  const catalog = await catalogPromise;
  const attempt = (path) => () => buildFromCompose(catalog, { name: 'a', preset: 'api-minimal' }, [{ path, content: 'export default 1;\n' }]);
  for (const bad of ['package.json', 'Dockerfile', '.env', 'src/lib/env.js', 'src/plugins/rate-limit.js', 'src/app.js', 'src/routes/index.js', 'test/app.test.js', '../x.js', 'src/routes/../lib/env.js', '.morline/modules.json', 'src/routes/x.sh']) {
    assert.throws(attempt(bad), (e) => e instanceof EngineError && e.code === 'bad_files', bad);
  }
  assert.doesNotThrow(attempt('src/services/pricing.js'));
  assert.doesNotThrow(attempt('src/routes/root.js'), 'the sample root route can be replaced');
  assert.throws(() => buildFromCompose(catalog, { name: 'a', preset: 'api-minimal' }, [{ path: 'migrations/bad name.sql', content: 'x' }]), (e) => e.code === 'bad_files');
});

test('files the module hands to the user (jobs, event handlers) can be filled in by the model', async () => {
  const catalog = await catalogPromise;
  const jobs = "export const jobs = [{ name: 'tick', schedule: '* * * * *', run: async () => {} }];\n";
  const r = buildFromCompose(catalog, { name: 'a', modules: ['scheduler'] }, [{ path: 'src/jobs/index.js', content: jobs }]);
  assert.equal(r.files.find((f) => f.path === 'src/jobs/index.js').content, jobs);
});

test('bad compose blocks give the model something to fix', async () => {
  const catalog = await catalogPromise;
  const fails = (compose, code) => assert.throws(() => buildFromCompose(catalog, compose), (e) => e instanceof EngineError && (!code || e.code === code), JSON.stringify(compose));
  fails({ name: 'a', preset: 'nope' }, 'bad_compose');
  fails({ name: 'a', modules: [{ id: 'resend' }] }, 'unknown_module');
  fails({ name: 'a', modules: ['email-resend', 'email-postmark'] }, 'module_conflict');
  fails({ name: 'a', modules: [{ id: 'rate-limit', options: { max: 0 } }] }, 'bad_option');
  fails({ name: 'a', modules: 'rate-limit' }, 'bad_compose');
  fails(null, 'bad_compose');
});

test('the model can import what the project ships but not what it lacks', async () => {
  const catalog = await catalogPromise;
  const uses = (code) => () => buildFromCompose(catalog, { name: 'a', preset: 'api-minimal' }, [{ path: 'src/services/x.js', content: code }]);
  assert.doesNotThrow(uses("import { notFound } from '../lib/errors.js';\nexport const f = () => notFound();\n"));
  assert.throws(uses("import { sendEmail } from '../lib/email.js';\nexport const f = sendEmail;\n"), (e) => e.code === 'checks_failed' && /email\.js, which does not exist/.test(e.message));
  assert.throws(uses("import axios from 'axios';\nexport default axios;\n"), (e) => e.code === 'checks_failed' && /axios/.test(e.message));
  assert.throws(uses("import { env } from '../lib/env.js';\nexport const k = env.required('SECRET_THING');\n"), (e) => e.code === 'checks_failed' && /SECRET_THING/.test(e.message));
  const withDep = () => buildFromCompose(catalog, { name: 'a', preset: 'api-minimal', extraDependencies: { axios: '^1.7.0' } }, [{ path: 'src/services/x.js', content: "import axios from 'axios';\nexport default axios;\n" }]);
  assert.doesNotThrow(withDep);
});

test('parses module and resource operations for existing repositories', () => {
  const { ops, resources } = parseModuleOps(`<module op="add" id="email-resend"></module>
<module op="add" id="rate-limit">{"max":30}</module>
<module op="remove" id="cors"/>
<resource op="add">{"name":"orders","fields":[{"name":"total","type":"number"}]}</resource>
<resource op="remove" name="notes"/>`);
  assert.deepEqual(ops, [
    { op: 'add', id: 'email-resend', options: {} },
    { op: 'add', id: 'rate-limit', options: { max: 30 } },
    { op: 'remove', id: 'cors', options: {} }
  ]);
  assert.equal(resources[0].spec.name, 'orders');
  assert.deepEqual(resources[1], { op: 'remove', name: 'notes' });
  assert.throws(() => parseModuleOps('<module op="add" id="rate-limit">{bad}</module>'), (e) => e.code === 'bad_compose');
});

// --- the builder, with a scripted model ------------------------------------------------------

const scripted = (...replies) => {
  const calls = [];
  const completeLong = async ({ system, messages, onText, isComplete }) => {
    calls.push({ system, messages });
    const text = replies[calls.length - 1];
    for (let i = 20; i < text.length + 20; i += 20) onText?.('', text.slice(0, i)); // stream it in pieces
    assert.ok(isComplete(text) || text.includes('<fallback/>'), 'the scripted reply is complete');
    return text;
  };
  return { completeLong, calls };
};

const reply = `<compose>
{"name":"quotes","description":"Quotes API","preset":"api-minimal","modules":[{"id":"email-resend"},{"id":"llm-anthropic"}],"resources":[{"name":"quotes","fields":[{"name":"text","type":"text","required":true}]}],"notes":"Set your Resend key."}
</compose>
<file path="src/services/quotes.js">
export const pick = (items) => items[0];
</file>
<done/>`;

test('the builder returns the same shape as the existing generator and reports steps with icons', async () => {
  const catalog = await catalogPromise;
  const { completeLong, calls } = scripted(reply);
  const steps = [];
  const out = await createModuleBuilder({ catalog, completeLong }).generateNewApp({ prompt: 'a quotes api that emails me', history: [], onStep: (text, meta) => steps.push([text, meta?.icon]) });

  assert.equal(out.name, 'quotes');
  assert.equal(out.port, 3000);
  assert.equal(out.volume, null);
  assert.deepEqual(out.envVars.map((v) => v.key).sort(), ['ANTHROPIC_API_KEY', 'RESEND_API_KEY']);
  assert.ok(out.files.every((f) => typeof f.path === 'string' && typeof f.content === 'string'));
  assert.deepEqual(out.addons, [{ kind: 'postgres', env: 'DATABASE_URL' }]);

  const texts = steps.map(([t]) => t);
  assert.deepEqual(texts.filter((t, i) => texts.indexOf(t) !== i), [], 'no step is announced twice');
  assert.ok(steps.some(([t, icon]) => t === 'Adding Resend email' && icon === 'resend'));
  assert.ok(steps.some(([t, icon]) => t === 'Adding Claude (Anthropic)' && icon === 'anthropic'));
  assert.ok(steps.some(([t]) => t === 'Generating Quotes API'));
  assert.ok(steps.some(([t]) => t === 'Writing src/services/quotes.js'));
  assert.ok(texts.indexOf('Adding Resend email') < texts.indexOf('Writing src/services/quotes.js'), 'modules are announced before the model finishes writing');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].system.includes('email-resend') && !calls[0].system.includes('http-client'));
});

test('requests that are not Node servers fall back to the existing builder', async () => {
  const catalog = await catalogPromise;
  const { completeLong } = scripted('<fallback/>');
  const out = await createModuleBuilder({ catalog, completeLong }).generateNewApp({ prompt: 'a python discord bot', history: [] });
  assert.deepEqual(out, { fallback: true });
});

test('one correction pass when the model picks something invalid', async () => {
  const catalog = await catalogPromise;
  const bad = reply.replace('"email-resend"', '"resend"');
  const { completeLong, calls } = scripted(bad, reply);
  const steps = [];
  const out = await createModuleBuilder({ catalog, completeLong }).generateNewApp({ prompt: 'x', onStep: (t) => steps.push(t) });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /Unknown module "resend"\. Did you mean: email-resend/);
  assert.ok(steps.includes('Fixing a problem with the first attempt'));
  assert.equal(out.name, 'quotes');
  const { completeLong: stuck } = scripted(bad, bad);
  await assert.rejects(createModuleBuilder({ catalog, completeLong: stuck }).generateNewApp({ prompt: 'x' }), (e) => e.code === 'unknown_module');
});

test('prompts describe the catalog without leaking internals', async () => {
  const catalog = await catalogPromise;
  const system = buildSystemPrompt(catalog);
  assert.match(system, /<fallback\/>/);
  assert.match(system, /- rate-limit:/);
  assert.ok(system.length < 16_000, `system prompt is ${system.length} characters`);
  const change = changeAddendum(catalog, ['cors']);
  assert.match(change, /Installed: cors/);
  assert.match(change, /<module op="add"/);
});
