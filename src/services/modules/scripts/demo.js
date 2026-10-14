#!/usr/bin/env node
// Shows what the engine renders versus what the model has to write.
import { getCatalog } from '../lib/catalog.js';
import { buildFromCompose } from '../lib/compose.js';
import { buildSystemPrompt } from '../lib/prompt.js';

const catalog = await getCatalog();
const tokens = (chars) => Math.round(chars / 4);
const rows = [];

const cases = {
  'webhook-receiver': { name: 'hooks', preset: 'webhook-receiver' },
  'rest-api': { name: 'shop-api', preset: 'rest-api', resources: [{ name: 'products', fields: [{ name: 'title', type: 'string', required: true }, { name: 'price', type: 'number', required: true }] }] },
  'saas-backend + email + payments + AI': {
    name: 'notes-saas', preset: 'saas-backend',
    modules: [{ id: 'email-resend' }, { id: 'payments-stripe' }, { id: 'llm-anthropic' }, { id: 'queue' }],
    resources: [{ name: 'notes', fields: [{ name: 'title', type: 'string', required: true }, { name: 'body', type: 'text' }] }]
  }
};
for (const [label, compose] of Object.entries(cases)) {
  const composeChars = JSON.stringify(compose).length;
  const r = buildFromCompose(catalog, compose);
  const rendered = r.files.reduce((n, f) => n + f.content.length, 0);
  rows.push({ case: label, files: r.files.length, 'rendered (tokens)': tokens(rendered), 'model writes (tokens)': tokens(composeChars) });
}
console.table(rows);
console.log(`One-off prompt cost: system prompt with the full catalog is about ${tokens(buildSystemPrompt(catalog).length)} tokens.`);
