import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheGet, cacheSet, __testing } from '../lib/cache';

test('keeps the in-memory cache bounded under high-cardinality searches', () => {
  __testing.clear();
  try {
    for (let i = 0; i < __testing.maxEntries + 75; i++) {
      cacheSet(`query:${i}`, i, 60_000);
    }

    assert.equal(__testing.size(), __testing.maxEntries);
    assert.equal(cacheGet('query:0'), undefined, 'the oldest cold entry should be evicted');
    assert.equal(cacheGet(`query:${__testing.maxEntries + 74}`), __testing.maxEntries + 74);
  } finally {
    __testing.clear();
  }
});

test('updating an existing cache key does not consume another slot', () => {
  __testing.clear();
  try {
    cacheSet('same', 1, 60_000);
    cacheSet('same', 2, 60_000);
    assert.equal(__testing.size(), 1);
    assert.equal(cacheGet('same'), 2);
  } finally {
    __testing.clear();
  }
});
