import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPromise } from '../test-support/helpers.js';
import { catalogCards } from '../index.js';

test('the shipped catalog validates and has the expected shape', async () => {
  const catalog = await catalogPromise;
  assert.ok(catalog.modules.size >= 20);
  for (const def of catalog.modules.values()) {
    assert.ok(def.label.add && def.label.remove, `${def.id} has step labels`);
    assert.ok(def.icon, `${def.id} has an icon`);
  }
});

test('AI cards stay small enough to put in every prompt', async () => {
  const catalog = await catalogPromise;
  const cards = catalogCards(catalog);
  assert.ok(cards.length < 12_000, `cards are ${cards.length} characters`);
  assert.ok(!cards.includes('http-client'), 'internal modules are hidden from the model');
});

test('every module has a unique rank and capability groups are contiguous', async () => {
  const catalog = await catalogPromise;
  const ranks = new Set(catalog.rank.values());
  assert.equal(ranks.size, catalog.modules.size);
  const byCap = new Map();
  for (const m of catalog.ordered) if (m.capability) byCap.set(m.capability, [...(byCap.get(m.capability) ?? []), catalog.rank.get(m.id)]);
  for (const [cap, rs] of byCap) {
    for (let i = 1; i < rs.length; i++) assert.equal(rs[i], rs[i - 1] + 1, `${cap} providers are adjacent in rank`);
  }
});
