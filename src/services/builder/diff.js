// Line diff for the review UI. Common head and tail are trimmed first, then an LCS runs on
// the middle, which keeps typical edits fast. Output is hunks with 3 lines of context.

const splitLines = (text) => {
  if (text === '' || text == null) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

function diffOps(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);

  const ops = [];
  for (let i = 0; i < head; i++) ops.push({ t: 'ctx', s: a[i] });

  if (am.length * bm.length > 4_000_000) {
    am.forEach((s) => ops.push({ t: 'del', s }));
    bm.forEach((s) => ops.push({ t: 'add', s }));
  } else {
    const n = am.length;
    const m = bm.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ t: 'ctx', s: am[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', s: am[i++] }); }
      else { ops.push({ t: 'add', s: bm[j++] }); }
    }
    while (i < n) ops.push({ t: 'del', s: am[i++] });
    while (j < m) ops.push({ t: 'add', s: bm[j++] });
  }
  for (let k = a.length - tail; k < a.length; k++) ops.push({ t: 'ctx', s: a[k] });
  return ops;
}

/** @returns {{ hunks, additions, deletions }} where each line is `{ type, text, oldNo, newNo }`. */
export function lineDiff(before, after, context = 3) {
  const ops = diffOps(splitLines(before), splitLines(after));
  let oldNo = 0;
  let newNo = 0;
  const lines = ops.map((op) => {
    if (op.t === 'ctx') { oldNo++; newNo++; return { type: 'ctx', text: op.s, oldNo, newNo }; }
    if (op.t === 'del') { oldNo++; return { type: 'del', text: op.s, oldNo, newNo: null }; }
    newNo++;
    return { type: 'add', text: op.s, oldNo: null, newNo };
  });

  const additions = lines.filter((l) => l.type === 'add').length;
  const deletions = lines.filter((l) => l.type === 'del').length;

  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.type === 'ctx') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });

  const hunks = [];
  let current = null;
  lines.forEach((l, idx) => {
    if (!keep[idx]) { current = null; return; }
    if (!current) { current = { oldStart: l.oldNo || 1, newStart: l.newNo || 1, lines: [] }; hunks.push(current); }
    current.lines.push(l);
  });
  return { hunks, additions, deletions };
}

/** Diff records for the UI: one entry per changed file. */
export function describeChanges(changes) {
  return changes.map((c) => ({
    path: c.path,
    action: c.action,
    ...lineDiff(c.before ?? '', c.after ?? '')
  }));
}
