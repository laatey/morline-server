// The model writes files as tagged blocks instead of JSON strings. Code in JSON needs every
// quote and newline escaped, and one slip (or a cut-off reply) makes the whole answer
// unreadable. Tagged blocks keep files raw, and a cut-off only affects the last block.
//
//   <plan>{"name":"...", ...}</plan>
//   <file path="src/index.js">
//   raw contents
//   </file>
//   <done/>

/** Drop the single newline after an opening tag and before a closing tag. */
const trim = (s) => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

/** Models sometimes wrap everything in a code fence. */
const unfence = (text) => text.replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n```\s*$/i, '');

const count = (text, re) => (text.match(re) || []).length;

export function parseBuildOutput(raw) {
  const text = unfence(raw);
  let plan = null;
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/);
  if (planMatch) {
    try { plan = JSON.parse(planMatch[1]); } catch { plan = null; }
  }
  const files = [...text.matchAll(/<file path="([^"]+)">([\s\S]*?)<\/file>/g)].map((m) => ({ path: m[1], content: trim(m[2]) }));
  const opened = count(text, /<file path="/g);
  return {
    plan,
    files,
    complete: Boolean(planMatch) && opened === files.length && (text.includes('<done/>') || files.length > 0)
  };
}

export function parseChangeOutput(raw) {
  const text = unfence(raw);
  const summary = trim(text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').trim();
  const changes = [];
  const re = /<change\s+path="([^"]+)"\s+action="(update|create|delete)"\s*(?:\/>|>([\s\S]*?)<\/change>)/g;
  for (const m of text.matchAll(re)) {
    const [, path, action, body = ''] = m;
    const change = { path, action };
    const edits = [...body.matchAll(/<edit>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>\s*<\/edit>/g)]
      .map((e) => ({ find: trim(e[1]), replace: trim(e[2]) }));
    const content = body.match(/<content>([\s\S]*?)<\/content>/);
    if (edits.length) change.edits = edits;
    else if (content) change.content = trim(content[1]);
    changes.push(change);
  }
  const opened = count(text, /<change\s+path="/g);
  // A well-formed set of changes is usable even if the model forgot the <summary> line.
  const complete = opened === changes.length && (changes.length > 0 || Boolean(summary));
  return { summary: summary || (changes.length ? `Update ${changes.map((c) => c.path).join(', ')}` : ''), changes, complete };
}

/**
 * Turns streamed text into human steps ("Writing src/index.js"). Call it with the text so far;
 * it reports each file or change once, as soon as its opening tag appears.
 */
export function stepReporter(onStep) {
  const seen = new Set();
  return (soFar) => {
    for (const m of soFar.matchAll(/<file path="([^"]+)">/g)) {
      if (!seen.has(`f:${m[1]}`)) { seen.add(`f:${m[1]}`); onStep(`Writing ${m[1]}`); }
    }
    for (const m of soFar.matchAll(/<change\s+path="([^"]+)"\s+action="(update|create|delete)"/g)) {
      const key = `c:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      onStep(`${{ update: 'Editing', create: 'Creating', delete: 'Deleting' }[m[2]]} ${m[1]}`);
    }
  };
}
