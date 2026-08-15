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

function fakeStore(
  name: string,
  domain: string | null,
  coords = { lat: 43.24, lon: 76.88 }
): Store {
  return {
    id: `node/${name}`,
    name,
    domain,
    website: domain ? `https://${domain}` : null,
    shopType: 'electronics',
    coords,
    distanceM: 400,
    address: null,
    phone: null,
    openingHours: null,
  };
}

/** Same key shape findStores uses internally. */
function storeKey(lat: number, lon: number, radiusM: number): string {
  return `stores:v2:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusM}`;
}

test('serves a stale store list when every Overpass mirror is down', async () => {
  // A coordinate no other test uses, so the in-memory cache starts empty.
  const lat = 10.111;
  const lon = 20.222;
  const radius = 4321;
  const key = storeKey(lat, lon, radius);

  // Seed the disk cache with an entry older than the fresh window.
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  await diskSet(
    key,
    [fakeStore('Old Shop', 'example.kz', { lat: lat + 0.001, lon })],
    threeDaysAgo
  );

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

test('treats an Overpass "remark" timeout as failure, not as zero shops', async () => {
  // Overpass reports its own timeouts with HTTP 200, an empty elements array
  // and a remark. Taken at face value the deployed app told users there were
  // no shops in central Almaty. Every mirror here returns that shape, so the
  // lookup must fail rather than succeed with nothing.
  const lat = 12.555;
  const lon = 22.666;
  const radius = 3333;

  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        version: 0.6,
        remark: 'runtime error: Query timed out in "query" at line 3 after 25 seconds.',
        elements: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(
      () => findStores({ lat, lon }, radius),
      (err: unknown) => err instanceof OverpassUnavailableError
    );
    assert.ok(calls > 1, `should have tried more than one mirror, tried ${calls}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an empty store result is not cached', async () => {
  // A genuinely empty area must not be remembered as empty, or a transient
  // upstream failure sticks for the rest of the day.
  const lat = 13.777;
  const lon = 23.888;
  const radius = 2222;

  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ version: 0.6, elements: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  try {
    const first = await findStores({ lat, lon }, radius);
    assert.equal(first.stores.length, 0);

    const callsAfterFirst = calls;
    await findStores({ lat, lon }, radius);
    assert.ok(
      calls > callsAfterFirst,
      'second lookup should hit the network again, not serve a cached empty list'
    );
  } finally {
    globalThis.fetch = realFetch;
    await rm(__testing.pathFor(storeKey(lat, lon, radius)), { force: true }).catch(
      () => {}
    );
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

test('recalculates cached shop distances for the exact user location', async () => {
  const first = { lat: 14.1111, lon: 24.2221 };
  // Same three-decimal cache cell, roughly 33 m north.
  const second = { lat: 14.1114, lon: 24.2221 };
  const radius = 900;
  const key = storeKey(first.lat, first.lon, radius);
  let calls = 0;

  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        version: 0.6,
        elements: [
          {
            type: 'node',
            id: 9001,
            lat: first.lat,
            lon: first.lon,
            tags: { name: 'Exact Shop', shop: 'electronics', website: 'example.kz' },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;

  try {
    const atFirst = await findStores(first, radius);
    const atSecond = await findStores(second, radius);

    assert.equal(atFirst.stores[0].distanceM, 0);
    assert.ok(
      atSecond.stores[0].distanceM >= 30,
      `expected a recalculated distance, got ${atSecond.stores[0].distanceM}`
    );
    assert.equal(calls, 1, 'nearby searches should still share the upstream lookup');
  } finally {
    globalThis.fetch = realFetch;
    await rm(__testing.pathFor(key), { force: true }).catch(() => {});
  }
});
