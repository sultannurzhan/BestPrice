/**
 * The app depends on a free, frequently-overloaded third party (Overpass). These
 * tests pin down what happens when it is unavailable — during development every
 * mirror returned 504 simultaneously, which took the whole app down.
 */

import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';

import { diskGet, diskSet, __testing } from '../lib/diskCache';
import { findStores, OverpassUnavailableError } from '../lib/overpass';
import type { Store } from '../lib/types';

const realFetch = globalThis.fetch;

function fakeStore(name: string, domain: string | null): Store {
  return {
    id: `node/${name}`,
    name,
    domain,
    website: domain ? `https://${domain}` : null,
    shopType: 'electronics',
    coords: { lat: 43.24, lon: 76.88 },
    distanceM: 400,
    address: null,
    phone: null,
    openingHours: null,
  };
}

/** Same key shape findStores uses internally. */
function storeKey(lat: number, lon: number, radiusM: number): string {
  return `stores:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusM}`;
}

test('serves a stale store list when every Overpass mirror is down', async () => {
  // A coordinate no other test uses, so the in-memory cache starts empty.
  const lat = 10.111;
  const lon = 20.222;
  const radius = 4321;
  const key = storeKey(lat, lon, radius);

  // Seed the disk cache with an entry older than the fresh window.
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  await diskSet(key, [fakeStore('Old Shop', 'example.kz')], threeDaysAgo);

  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  try {
    const result = await findStores({ lat, lon }, radius);

    assert.equal(result.stores.length, 1);
    assert.equal(result.stores[0].name, 'Old Shop');
    assert.ok(
      result.staleAgeMs !== null && result.staleAgeMs > 24 * 60 * 60 * 1000,
      `expected a stale age over a day, got ${result.staleAgeMs}`
    );
  } finally {
    globalThis.fetch = realFetch;
    // Remove only the fixture this test wrote. Deleting the whole .cache
    // directory would throw away the app's real store data on every test run.
    await rm(__testing.pathFor(key), { force: true }).catch(() => {});
  }
});

test('reports a clear error when Overpass is down and nothing is cached', async () => {
  const lat = 11.333;
  const lon = 21.444;
  const radius = 1234;

  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => findStores({ lat, lon }, radius),
      (err: unknown) => err instanceof OverpassUnavailableError
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('disk cache round-trips and respects max age', async () => {
  const key = 'test:roundtrip';
  try {
    await diskSet(key, { hello: 'world' });

    const fresh = await diskGet<{ hello: string }>(key, 60_000);
    assert.equal(fresh?.value.hello, 'world');

    // Same entry, asked for with a zero-length freshness window.
    const expired = await diskGet(key, -1);
    assert.equal(expired, null);
  } finally {
    await rm(__testing.pathFor(key), { force: true }).catch(() => {});
  }
});
