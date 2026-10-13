import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBuildOutput, parseChangeOutput, stepReporter } from '../src/services/builder/format.js';

const code = 'const s = "has \\"quotes\\"";\nconsole.log(`${s}`);\n';

test('build output keeps file contents raw, including quotes and template literals', () => {
  const text = `<plan>\n{"name":"img-api","port":3000,"volume":{"mountPath":"/data","sizeGb":5}}\n</plan>\n<file path="index.js">\n${code}</file>\n<file path="Dockerfile">\nFROM node:22\n</file>\n<done/>`;
  const out = parseBuildOutput(text);
  assert.equal(out.complete, true);
  assert.equal(out.plan.volume.sizeGb, 5);
  assert.equal(out.files[0].content, code.replace(/\n$/, ''));
  assert.deepEqual(out.files.map((f) => f.path), ['index.js', 'Dockerfile']);
});

test('a reply cut off inside a file is reported as incomplete, and earlier files survive', () => {
  const text = `<plan>{"name":"x"}</plan>\n<file path="a.js">\nok\n</file>\n<file path="b.js">\nhalf a fi`;
  const out = parseBuildOutput(text);
  assert.equal(out.complete, false);
  assert.equal(out.files.length, 1);
});

test('code fences around the whole reply are ignored', () => {
  const out = parseBuildOutput('```\n<plan>{"name":"x"}</plan>\n<file path="a.js">\nx\n</file>\n<done/>\n```');
  assert.equal(out.complete, true);
});

test('change output parses edits, creates and deletes', () => {
  const text = `<summary>Add a route.</summary>
<change path="src/a.js" action="update">
<edit>
<find>
app.listen(3000)
</find>
<replace>
app.get("/x", h);
app.listen(3000)
</replace>
</edit>
</change>
<change path="src/b.js" action="create">
<content>
export const b = 1;
</content>
</change>
<change path="old.js" action="delete"/>`;
  const out = parseChangeOutput(text);
  assert.equal(out.complete, true);
  assert.equal(out.summary, 'Add a route.');
  assert.deepEqual(out.changes[0].edits, [{ find: 'app.listen(3000)', replace: 'app.get("/x", h);\napp.listen(3000)' }]);
  assert.equal(out.changes[1].content, 'export const b = 1;');
  assert.deepEqual(out.changes[2], { path: 'old.js', action: 'delete' });
  assert.equal(parseChangeOutput(text.slice(0, text.indexOf('<change path="src/b.js"') + 40)).complete, false);
});

test('steps are reported once, as each file or change starts', () => {
  const steps = [];
  const report = stepReporter((s) => steps.push(s));
  report('<plan>{}</plan>\n<file path="Dockerfile">\nFROM');
  report('<plan>{}</plan>\n<file path="Dockerfile">\nFROM node\n</file>\n<file path="src/index.js">\nx');
  report('<change path="a.js" action="update">');
  report('<change path="a.js" action="update">\n<change path="b.js" action="create">');
  assert.deepEqual(steps, ['Writing Dockerfile', 'Writing src/index.js', 'Editing a.js', 'Creating b.js']);
});
