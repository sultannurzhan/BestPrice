import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheGet, cacheSet, cached, __testing } from '../lib/cache';

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

test('aborts a loader after its only waiter cancels', async () => {
  __testing.clear();
  const caller = new AbortController();
  let loaderSignal: AbortSignal | null = null;

  try {
    const pending = cached(
      'cancel-only-waiter',
      60_000,
      (signal) => {
        loaderSignal = signal;
        return new Promise<number>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      { signal: caller.signal }
    );
    await Promise.resolve();

    const reason = new DOMException('shopper left', 'AbortError');
    caller.abort(reason);
    await assert.rejects(pending, (err: unknown) => err === reason);
    assert.equal((loaderSignal as AbortSignal | null)?.aborted, true);
  } finally {
    __testing.clear();
  }
});

test('keeps shared work alive while another cache waiter remains', async () => {
  __testing.clear();
  const firstCaller = new AbortController();
  let loaderSignal: AbortSignal | null = null;
  let finish!: (value: number) => void;

  try {
    const loader = (signal: AbortSignal) => {
      loaderSignal = signal;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    };
    const first = cached('shared-flight', 60_000, loader, {
      signal: firstCaller.signal,
    });
    const second = cached('shared-flight', 60_000, loader);
    await Promise.resolve();

    firstCaller.abort();
    await assert.rejects(first);
    assert.equal((loaderSignal as AbortSignal | null)?.aborted, false);

    finish(42);
    assert.equal(await second, 42);
  } finally {
    __testing.clear();
  }
});

test('a late caller restarts instead of joining an already-aborted flight', async () => {
  __testing.clear();
  const firstCaller = new AbortController();
  let loads = 0;

  try {
    const load = (signal: AbortSignal) => {
      loads++;
      return new Promise<number>((resolve, reject) => {
        if (loads === 2) resolve(42);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const first = cached('aborted-race', 60_000, load, {
      signal: firstCaller.signal,
    });
    await Promise.resolve();
    firstCaller.abort();

    const second = cached('aborted-race', 60_000, load);
    await assert.rejects(first);
    assert.equal(await second, 42);
    assert.equal(loads, 2);
  } finally {
    __testing.clear();
  }
});

test('cache reads refresh LRU order', () => {
  __testing.clear();
  try {
    for (let i = 0; i < __testing.maxEntries; i++) cacheSet(`lru:${i}`, i, 60_000);
    assert.equal(cacheGet('lru:0'), 0);
    cacheSet('lru:new', 1, 60_000);
    assert.equal(cacheGet('lru:0'), 0);
    assert.equal(cacheGet('lru:1'), undefined);
  } finally {
    __testing.clear();
  }
});

test('rejects oversized entries and caps aggregate cache bytes', () => {
  __testing.clear();
  try {
    cacheSet('too-large', 'x'.repeat(__testing.maxEntryBytes + 1), 60_000);
    assert.equal(cacheGet('too-large'), undefined);

    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 30; i++) cacheSet(`large:${i}`, `${i}:${chunk}`, 60_000);

    assert.ok(__testing.bytes() <= __testing.maxBytes);
    assert.ok(__testing.size() < 30, 'byte pressure should evict before entry count');
    assert.equal(cacheGet('large:0'), undefined, 'oldest large value should be evicted');
    assert.ok(cacheGet('large:29'));
  } finally {
    __testing.clear();
  }
});
