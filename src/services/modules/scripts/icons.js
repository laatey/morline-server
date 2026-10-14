#!/usr/bin/env node
// Lists every icon the frontend needs for the "Adding <module>" step lines, and (optionally)
// checks which brand logos are still missing from the folders you point it at.
//
//   node scripts/icons.js                               # print the list
//   node scripts/icons.js ../morline-main/src/assets/providers ../morline-main/src/assets/stack
//   node scripts/icons.js --json                        # machine-readable

import { existsSync } from 'node:fs';
import path from 'node:path';
import { getCatalog } from '../lib/catalog.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dirs = args.filter((a) => !a.startsWith('--'));

// Step icons the engine emits that do not belong to a single module.
const EXTRA_LUCIDE = { 'lucide:database': 'generated CRUD resources', 'lucide:shield-check': 'security checks step' };

const catalog = await getCatalog();
const brand = new Map();
const lucide = new Map(Object.entries(EXTRA_LUCIDE).map(([k, v]) => [k, [v]]));
for (const def of catalog.ordered.filter((m) => !m.internal)) {
  const target = def.icon.startsWith('lucide:') ? lucide : brand;
  target.set(def.icon, [...(target.get(def.icon) ?? []), def.name]);
}

const rows = [...brand].map(([key, used]) => ({
  key,
  file: `${key}.svg`,
  usedBy: used.join(', '),
  found: dirs.length ? dirs.some((d) => existsSync(path.join(d, `${key}.svg`))) : null
}));

if (json) {
  console.log(JSON.stringify({ brand: rows, lucide: [...lucide].map(([key, used]) => ({ key, name: key.slice(7), usedBy: used.join(', ') })) }, null, 2));
} else {
  console.log('Brand logos (one square SVG per key):');
  for (const r of rows) console.log(`  ${r.found === null ? ' ' : r.found ? '✓' : '✗'} ${r.file.padEnd(16)} ${r.usedBy}`);
  console.log('\nlucide-react icons (no files needed, import by name):');
  for (const [key, used] of lucide) console.log(`    ${key.slice(7).padEnd(16)} ${used.join(', ')}`);
}
if (dirs.length && rows.some((r) => !r.found)) process.exitCode = 1;
