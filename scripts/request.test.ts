import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_DOMAINS,
  MAX_UNKNOWN_DOMAINS,
  selectDomains,
  validateSearchRequest,
} from '../lib/searchRequest';

test('requires real JSON numbers instead of coercing malformed coordinates', () => {
  for (const lat of [null, '', '43.2', true, undefined]) {
    assert.equal(
      validateSearchRequest({ lat, lon: 76.9, radiusM: 5_000, item: 'iPhone' }),
      'Invalid latitude'
    );
  }

  const valid = validateSearchRequest({ lat: 0, lon: 0, radiusM: 5_000, item: ' SSD ' });
  assert.deepEqual(valid, { lat: 0, lon: 0, radiusM: 5_000, item: 'SSD' });
});

test('reports every retailer omitted by the search time budget', () => {
  const known = [
    'fmobile.kz',
    'tgrad.kz',
    'larek.kz',
    'technodom.kz',
    'mechta.kz',
    'dns-shop.kz',
    'ispace.kz',
    'ifix.kz',
    'sulpak.kz',
    'alser.kz',
  ];
  const unknown = Array.from({ length: 10 }, (_, i) => `shop-${i}.example.kz`);
  const ranked = [...unknown.slice(0, 2), ...known, ...unknown.slice(2)];
  const { domains, skipped } = selectDomains(ranked);

  assert.equal(domains.length, MAX_DOMAINS);
  assert.equal(domains.filter((domain) => unknown.includes(domain)).length, MAX_UNKNOWN_DOMAINS);
  assert.equal(skipped.length, ranked.length - domains.length);
  assert.deepEqual(new Set([...domains, ...skipped]), new Set(ranked));
});

test('quantises arbitrary radii to keep persistent cache keys bounded', () => {
  const validated = validateSearchRequest({
    lat: 43.2,
    lon: 76.9,
    radiusM: 5_049.75,
    item: 'iPhone',
  });
  assert.notEqual(typeof validated, 'string');
  if (typeof validated !== 'string') assert.equal(validated.radiusM, 5_000);
});

test('rejects item descriptions with no searchable characters', () => {
  for (const item of ['🔥🔥', '--', '   💸   ']) {
    assert.equal(
      validateSearchRequest({ lat: 43.2, lon: 76.9, radiusM: 5_000, item }),
      'Item must include letters or numbers'
    );
  }
});
