/**
 * Tests for the matcher — the part of the agent most likely to be subtly wrong.
 *
 * Every case here is drawn from something the live scrapers actually returned.
 * Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectCategory, matchListing, parseQuery } from '../lib/product';
import { computeCost } from '../lib/rank';
import type { Listing } from '../lib/types';

function listing(title: string, price: number): Listing {
  return {
    title,
    price,
    oldPrice: null,
    url: null,
    domain: 'example.kz',
    via: 'test',
    inStock: null,
  };
}

function verdict(query: string, title: string, price: number) {
  return matchListing(listing(title, price), parseQuery(query));
}

// ---------------------------------------------------------------------------

test('accepts the product the shopper asked for', () => {
  const m = verdict('iPhone 15', 'Смартфон Apple iPhone 15 128GB Black', 443_990);
  assert.equal(m.rejected, false);
  assert.ok(m.confidence >= 0.7, `confidence was ${m.confidence}`);
});

test('rejects accessories that share the product name', () => {
  // All of these were returned by real KZ shops for the query "iphone".
  const cases: Array<[string, number]> = [
    ['Чехол для iPhone 15 силиконовый черный', 3_990],
    ['Защитное стекло для iPhone 15 Pro', 2_500],
    ['АЗУ Inkax Iphone (CD/CC-13-Iphone) Lightning USB', 1_295],
    ['Кабель USB 2.0 - Lightning(m) 8-pin, 1.5m', 1_400],
    ['Держатель универсальный InterStep с БЗУ 10W', 16_990],
  ];

  for (const [title, price] of cases) {
    const m = verdict('iPhone 15', title, price);
    assert.equal(m.rejected, true, `should have rejected: ${title}`);
  }
});

test('rejects a different product line that shares brand words', () => {
  // The bug this catches: "Samsung Galaxy A17" matched Galaxy Buds headphones
  // because two of three tokens ("samsung", "galaxy") were present.
  const m = verdict(
    'Samsung Galaxy A17',
    'Наушники беспроводные Samsung Galaxy Buds Core, White (SM-R410NZWACIS)',
    20_890
  );
  assert.equal(m.rejected, true);
});

test('requires the model identifier even at a plausible price', () => {
  // Priced well above the smartphone floor, so only the identifier rule can
  // reject it.
  const m = verdict(
    'Samsung Galaxy A17',
    'Смартфон Samsung Galaxy S24 Ultra 12/512GB Titanium Black',
    450_000
  );
  assert.equal(m.rejected, true);
  assert.match(m.rejectReason ?? '', /model identifier/);
});

test('accepts the right Samsung model', () => {
  const m = verdict(
    'Samsung Galaxy A17',
    'Смартфон Samsung Galaxy A17 8/256GB Black (SM-A175FZKOSKZ)',
    119_890
  );
  assert.equal(m.rejected, false);
});

test('does not confuse adjacent model numbers', () => {
  // "a5" must not match "a55" — word boundaries, not substrings.
  const m = verdict('Galaxy A5', 'Смартфон Samsung Galaxy A55 8/256GB', 189_990);
  assert.equal(m.rejected, true);
});

test('rejects prices below a plausible floor for the category', () => {
  const m = verdict('iPhone 15', 'iPhone 15 (дисплей в сборе)', 12_000);
  assert.equal(m.rejected, true);
});

test('enforces storage when the shopper specified it', () => {
  const wrong = verdict('iPhone 15 256GB', 'Apple iPhone 15 128GB Black', 443_990);
  assert.equal(wrong.rejected, true);
  assert.match(wrong.rejectReason ?? '', /storage/);

  const right = verdict('iPhone 15 256GB', 'Apple iPhone 15 256GB Black', 512_990);
  assert.equal(right.rejected, false);
});

test('rejects used and replica listings', () => {
  for (const title of [
    'Apple iPhone 15 128GB Black (б/у)',
    'Apple iPhone 15 копия 1:1',
  ]) {
    assert.equal(verdict('iPhone 15', title, 300_000).rejected, true, title);
  }
});

test('allows an accessory when that is what was asked for', () => {
  const m = verdict('чехол для iphone 15', 'Чехол для iPhone 15 силиконовый', 3_990);
  assert.equal(m.rejected, false);
});

test('categorises two-digit Samsung models as phones', () => {
  // `galaxy a\d` + \b never matched "galaxy a17", which dropped the price floor.
  assert.equal(detectCategory('Samsung Galaxy A17'), 'smartphone');
  assert.equal(detectCategory('Galaxy S24 Ultra'), 'smartphone');
  assert.equal(detectCategory('MacBook Air M2'), 'laptop');
  assert.equal(detectCategory('AirPods Pro 2'), 'headphones');
});

test('parses storage and strips it from the search term', () => {
  const q = parseQuery('iPhone 15 Pro 256GB');
  assert.equal(q.storageGb, 256);
  assert.equal(q.category, 'smartphone');
  assert.ok(!/256/.test(q.searchTerm), `searchTerm kept capacity: ${q.searchTerm}`);
});

test('strips a bare storage capacity from the retailer search term', () => {
  const q = parseQuery('iPhone 15 Pro 256');
  assert.equal(q.storageGb, 256);
  assert.equal(q.searchTerm, 'iPhone 15 Pro');
  assert.ok(!q.requiredTokens.includes('256'));
});

test('distinguishes RAM from storage in common variant formats', () => {
  const spaced = parseQuery('MacBook Air M2 16GB 512GB');
  assert.equal(spaced.ramGb, 16);
  assert.equal(spaced.storageGb, 512);
  assert.equal(spaced.searchTerm, 'MacBook Air M2');

  const compact = parseQuery('Samsung Galaxy A17 8/256GB');
  assert.equal(compact.ramGb, 8);
  assert.equal(compact.storageGb, 256);
  assert.equal(compact.searchTerm, 'Samsung Galaxy A17');

  const labelled = parseQuery('MacBook Air M2 16 GB RAM 1 TB SSD');
  assert.equal(labelled.ramGb, 16);
  assert.equal(labelled.storageGb, 1024);
});

test('enforces RAM when the shopper specified a variant', () => {
  const wrong = verdict(
    'MacBook Air M2 16GB 512GB',
    'Apple MacBook Air M2 8GB 512GB Midnight',
    599_990
  );
  assert.equal(wrong.rejected, true);
  assert.match(wrong.rejectReason ?? '', /wrong RAM/);

  const right = verdict(
    'MacBook Air M2 16GB 512GB',
    'Apple MacBook Air M2 16GB 512GB Midnight',
    649_990
  );
  assert.equal(right.rejected, false);
});

test('travel cost grows with distance and is symmetric', () => {
  const near = computeCost(100_000, 500);
  const far = computeCost(100_000, 20_000);

  assert.ok(near.total < far.total);
  assert.equal(near.price, far.price);
  // A 20 km trip should cost meaningfully more than a 500 m one.
  assert.ok(far.total - near.total > 2_000, `delta was ${far.total - near.total}`);
});

test('a cheaper distant shop can lose to a dearer close one', () => {
  const distant = computeCost(440_000, 22_000);
  const close = computeCost(443_000, 700);
  assert.ok(
    close.total < distant.total,
    `close ${close.total} should beat distant ${distant.total}`
  );
});
