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
import { __testing as llmTesting } from '../lib/llm';
import type { Deal, Listing } from '../lib/types';

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
  assert.equal(q.searchTerm, 'iphone 15 pro');
  assert.ok(!q.requiredTokens.includes('256'));
});

test('distinguishes RAM from storage in common variant formats', () => {
  const spaced = parseQuery('MacBook Air M2 16GB 512GB');
  assert.equal(spaced.ramGb, 16);
  assert.equal(spaced.storageGb, 512);
  assert.equal(spaced.searchTerm, 'macbook air m2');

  const compact = parseQuery('Samsung Galaxy A17 8/256GB');
  assert.equal(compact.ramGb, 8);
  assert.equal(compact.storageGb, 256);
  assert.equal(compact.searchTerm, 'samsung galaxy a17');

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

test('parses decimal terabytes without leaking fragments into model matching', () => {
  const q = parseQuery('Laptop 1.5TB');
  assert.equal(q.storageGb, 1536);
  assert.equal(q.searchTerm, 'laptop');
  assert.deepEqual(q.requiredTokens, ['laptop']);

  const m = matchListing(
    listing('Gaming Laptop 1.5TB SSD', 650_000),
    q
  );
  assert.equal(m.rejected, false);
});

test('normalises plus model names written as a word or symbol', () => {
  assert.equal(
    verdict('Samsung S24 Plus', 'Samsung Galaxy S24+ 256GB', 400_000).rejected,
    false
  );
  assert.equal(
    verdict('Samsung S24+', 'Samsung Galaxy S24 Plus 256GB', 400_000).rejected,
    false
  );
});

test('requires explicit textual variants', () => {
  for (const [query, wrong, right] of [
    ['iPhone 15 Pro', 'Apple iPhone 15 128GB', 'Apple iPhone 15 Pro 128GB'],
    ['Samsung S24 Ultra', 'Samsung Galaxy S24 256GB', 'Samsung Galaxy S24 Ultra 256GB'],
    ['MacBook Air M2', 'Apple MacBook Pro M2 512GB', 'Apple MacBook Air M2 512GB'],
  ]) {
    assert.equal(verdict(query, wrong, 450_000).rejected, true, `${query}: ${wrong}`);
    assert.equal(verdict(query, right, 450_000).rejected, false, `${query}: ${right}`);
  }
});

test('rejects an unrequested sibling phone variant', () => {
  assert.equal(
    verdict('iPhone 15', 'Apple iPhone 15 Pro 128GB', 500_000).rejected,
    true
  );
  assert.equal(
    verdict('Galaxy S24', 'Samsung Galaxy S24 Ultra 256GB', 500_000).rejected,
    true
  );
});

test('accepts an included charger without treating the phone as an accessory', () => {
  const result = verdict(
    'iPhone 15',
    'Apple iPhone 15 128GB с зарядным устройством в комплекте',
    450_000
  );
  assert.equal(result.rejected, false, result.rejectReason ?? 'unexpected rejection');
});

test('rejects an explicitly conflicting manufacturer', () => {
  assert.equal(
    verdict('Samsung Galaxy S24', 'Xiaomi Galaxy S24 Ultra 256GB', 400_000).rejected,
    true
  );
  // A generic query may still match a branded listing.
  assert.equal(
    verdict('S24', 'Samsung Galaxy S24 256GB', 400_000).rejected,
    false
  );
});

test('drops conversational shopping noise from identity matching', () => {
  const query = parseQuery('please find the cheapest iPhone 15 near me');
  assert.deepEqual(query.requiredTokens, ['iphone', '15']);
  assert.equal(query.searchTerm, 'iphone 15');
  assert.equal(
    matchListing(listing('Apple iPhone 15 128GB Black', 443_990), query).rejected,
    false
  );
});

test('normalises common Russian aliases and Cyrillic model lookalikes', () => {
  assert.equal(
    verdict('айфон 15', 'Apple iPhone 15 128GB Black', 443_990).rejected,
    false
  );
  assert.equal(
    verdict(
      'самсунг галакси а17',
      'Samsung Galaxy A17 8/256GB Black',
      120_000
    ).rejected,
    false
  );
});

test('does not consume model numbers as storage or RAM', () => {
  const consoleQuery = parseQuery('Nintendo 64');
  assert.equal(consoleQuery.category, 'console');
  assert.equal(consoleQuery.storageGb, null);
  assert.ok(consoleQuery.requiredTokens.includes('64'));
  assert.equal(
    matchListing(listing('Nintendo 64 Console Grey', 150_000), consoleQuery).rejected,
    false
  );

  const phoneQuery = parseQuery('iPhone 15/256');
  assert.equal(phoneQuery.ramGb, null);
  assert.equal(phoneQuery.storageGb, 256);
  assert.ok(phoneQuery.requiredTokens.includes('15'));
  assert.equal(
    matchListing(listing('Apple iPhone 15 256GB Black', 500_000), phoneQuery).rejected,
    false
  );
});

test('distinguishes numeric phone models from slash-separated storage', () => {
  for (const queryText of [
    'iPhone 12/128',
    'Google Pixel 8/128',
    'Xiaomi 14 Ultra/512',
    'OnePlus 12/256',
  ]) {
    const query = parseQuery(queryText);
    const model = queryText.split('/')[0];
    const storage = Number(queryText.split('/')[1]);
    assert.equal(query.ramGb, null, queryText);
    assert.equal(query.storageGb, storage, queryText);
    assert.equal(query.searchTerm, model.toLowerCase(), queryText);
    assert.ok(query.requiredTokens.some((token) => /\d/.test(token)), queryText);
  }

  const memoryCombo = parseQuery('MacBook Pro M3 36/512');
  assert.equal(memoryCombo.ramGb, 36);
  assert.equal(memoryCombo.storageGb, 512);
});

test('normalises English ordinal model suffixes', () => {
  assert.equal(
    verdict('AirPods Pro 2', 'Apple AirPods Pro 2nd Generation', 120_000).rejected,
    false
  );
});

test('matches harmless model punctuation and spacing variants', () => {
  assert.equal(
    verdict(
      'Samsung Galaxy Z Fold5',
      'Samsung Galaxy Z Fold 5 512GB',
      700_000
    ).rejected,
    false
  );
  assert.equal(
    verdict('Sony WH-1000XM5', 'Sony WH1000XM5 Wireless Headphones', 180_000).rejected,
    false
  );
});

test('treats RAM and HDD searches as meaningful component queries', () => {
  const ram = parseQuery('16GB RAM');
  assert.equal(ram.category, 'component');
  assert.equal(ram.ramGb, 16);
  assert.equal(ram.searchTerm, 'ram');
  assert.equal(
    matchListing(listing('Kingston DDR5 16GB RAM', 45_000), ram).rejected,
    false
  );

  const disk = parseQuery('1TB HDD');
  assert.equal(disk.category, 'component');
  assert.equal(disk.storageGb, 1024);
  assert.equal(disk.searchTerm, 'hdd');
  assert.equal(
    matchListing(listing('Seagate Barracuda 1TB HDD', 35_000), disk).rejected,
    false
  );
});

test('reads DDR context as RAM and rejects the wrong capacity', () => {
  assert.equal(
    verdict('16GB RAM', 'Kingston 32GB DDR4 RAM', 45_000).rejected,
    true
  );
  assert.equal(
    verdict('32GB RAM', 'Kingston 32GB DDR4 RAM', 45_000).rejected,
    false
  );
});

test('enforces explicit CPU and GPU family conflicts', () => {
  assert.equal(
    verdict('Nvidia RTX 4090', 'AMD RTX 4090 Graphics Card', 900_000).rejected,
    true
  );
  assert.equal(
    verdict('Nvidia RTX 4090', 'ASUS Nvidia RTX 4090 Graphics Card', 900_000).rejected,
    false
  );
});

test('matches compact model names in either query direction', () => {
  assert.equal(
    verdict('RTX4090', 'Nvidia RTX 4090 Graphics Card', 900_000).rejected,
    false
  );
  assert.equal(
    verdict('WH1000XM5', 'Sony WH-1000XM5 Headphones', 180_000).rejected,
    false
  );
});

test('recognises numeric phone families before extracting bare storage', () => {
  for (const queryText of [
    'Xiaomi 14 256',
    'OnePlus 12 256',
    'Oppo Reno 12 256',
    'Honor Magic 6 256',
  ]) {
    const query = parseQuery(queryText);
    assert.equal(query.category, 'smartphone', queryText);
    assert.equal(query.storageGb, 256, queryText);
    assert.ok(!query.requiredTokens.includes('256'), queryText);
  }
});

test('rejects English used, counterfeit, and case listings', () => {
  for (const title of [
    'Used Apple iPhone 15 128GB',
    'Fake Apple iPhone 15 replica',
    'Premium Case for Apple iPhone 15',
  ]) {
    assert.equal(verdict('iPhone 15', title, 400_000).rejected, true, title);
  }

  assert.equal(
    verdict('used iPhone 15', 'Used Apple iPhone 15 128GB', 400_000).rejected,
    false
  );
});

test('an accessory query still rejects a different accessory type', () => {
  const wrong = verdict(
    'charger for iPhone 15',
    'Premium Case for Apple iPhone 15',
    45_000
  );
  assert.equal(wrong.rejected, true);
  assert.match(wrong.rejectReason ?? '', /requested charger/);

  const right = verdict(
    'charger for iPhone 15',
    '20W Power Adapter Charger for Apple iPhone 15',
    15_000
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

test('the fallback verdict never invents that the cheapest shop is closest', () => {
  const deal = (name: string, price: number, total: number, distanceKm: number) =>
    ({
      store: { name },
      listing: { price, inStock: true },
      cost: { total, distanceKm },
      match: { confidence: 0.9 },
    }) as Deal;

  const verdictText = llmTesting.ruleVerdict([
    deal('Far Shop', 100_000, 103_000, 12),
    deal('Near Shop', 101_000, 104_000, 1),
  ]);

  assert.ok(verdictText);
  assert.doesNotMatch(verdictText, /closest/i);
  assert.match(verdictText, /including travel/i);
});

test('the fallback flags unknown branch stock for multi-shop results', () => {
  const deal = (name: string, price: number, total: number) =>
    ({
      store: { name },
      listing: { price, inStock: null },
      cost: { total, distanceKm: 1 },
      match: { confidence: 0.9 },
    }) as Deal;

  const verdictText = llmTesting.ruleVerdict([
    deal('Example Shop', 443_990, 444_500),
    deal('Other Shop', 449_990, 450_500),
  ]);
  assert.match(verdictText ?? '', /stock is unverified/i);
});

test('LLM enrichment cannot remove deterministic product invariants', () => {
  const base = parseQuery('Samsung Galaxy A17 8/256GB');
  const enriched = llmTesting.mergeEnrichment(base, {
    searchTerm: 'samsung buds',
    brand: 'samsung',
    model: 'galaxy buds',
    storageGb: 128,
    ramGb: 4,
    category: 'headphones',
    requiredTokens: ['samsung', 'galaxy', 'buds'],
  });

  assert.equal(enriched.searchTerm, base.searchTerm);
  assert.equal(enriched.category, 'smartphone');
  assert.equal(enriched.storageGb, 256);
  assert.equal(enriched.ramGb, 8);
  assert.deepEqual(
    enriched.requiredTokens,
    base.requiredTokens,
    'invented tokens must not replace or extend the rule-derived model'
  );

  const buds = listing(
    'Samsung Galaxy Buds Core wireless headphones',
    45_000
  );
  assert.equal(matchListing(buds, enriched).rejected, true);
});

test('LLM enrichment also preserves textual variants', () => {
  const base = parseQuery('iPhone 15 Pro Max');
  const enriched = llmTesting.mergeEnrichment(base, {
    searchTerm: 'iphone 15',
    model: 'iphone 15',
    requiredTokens: ['iphone', '15'],
  });

  assert.equal(enriched.searchTerm, base.searchTerm);
  assert.deepEqual(enriched.requiredTokens, base.requiredTokens);
  assert.equal(
    matchListing(listing('Apple iPhone 15 128GB', 443_990), enriched).rejected,
    true
  );
});

test('LLM search terms must preserve whole tokens, not substrings', () => {
  const base = parseQuery('iPhone Pro');
  const enriched = llmTesting.mergeEnrichment(base, {
    searchTerm: 'product iphone',
    requiredTokens: ['iphone'],
  });
  assert.equal(enriched.searchTerm, base.searchTerm);
  assert.deepEqual(enriched.requiredTokens, base.requiredTokens);
});

test('rejects ungrounded LLM verdicts', () => {
  const deal = {
    store: { name: 'Example Shop' },
    listing: { price: 443_990, inStock: null },
  } as Deal;
  assert.equal(
    llmTesting.verdictIsGrounded(
      'Example Shop is best at 443 990 ₸; branch stock is unverified.',
      [deal]
    ),
    true
  );
  assert.equal(
    llmTesting.verdictIsGrounded('Invented Shop wins at 1 ₸.', [deal]),
    false
  );
  assert.equal(
    llmTesting.verdictIsGrounded(
      'Example Shop is best at 443 990 ₸; another option costs 1 ₸; stock is unverified.',
      [deal]
    ),
    false,
    'every numeric claim must come from the ranked deal data'
  );
});
