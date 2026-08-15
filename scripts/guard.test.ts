import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acquireSearchSlot,
  checkSearchRateLimit,
  MAX_CONCURRENT_SEARCHES,
  MAX_REQUEST_BODY_BYTES,
  RATE_LIMIT,
  assertSameOrigin,
  readJsonBody,
  RequestProblem,
  __testing,
} from '../lib/searchGuard';

function request(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('https://bestprice.example/api/deals', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('rejects oversized declared and chunked JSON bodies', async () => {
  const declared = request('{}', {
    'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1),
  });
  await assert.rejects(
    () => readJsonBody(declared),
    (err: unknown) => err instanceof RequestProblem && err.status === 413
  );

  const chunk = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
  const chunked = new Request('https://bestprice.example/api/deals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await assert.rejects(
    () => readJsonBody(chunked),
    (err: unknown) => err instanceof RequestProblem && err.status === 413
  );
});

test('requires JSON content type and parses a valid bounded body', async () => {
  const wrong = new Request('https://bestprice.example/api/deals', {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'text/plain' },
  });
  await assert.rejects(
    () => readJsonBody(wrong),
    (err: unknown) => err instanceof RequestProblem && err.status === 415
  );

  assert.deepEqual(await readJsonBody(request('{"item":"iPhone"}')), {
    item: 'iPhone',
  });
});

test('stops waiting when a request body is cancelled', async () => {
  const controller = new AbortController();
  const pendingBody = new ReadableStream<Uint8Array>({
    pull() {
      // Deliberately never provide a chunk.
    },
  });
  const pending = new Request('https://bestprice.example/api/deals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: pendingBody,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const reading = readJsonBody(pending);
  controller.abort();
  await assert.rejects(
    reading,
    (err: unknown) => err instanceof RequestProblem && err.status === 408
  );
});

test('rate limits an IP before another expensive search starts', () => {
  __testing.reset();
  const req = request('{}', { 'X-Forwarded-For': '203.0.113.9' });
  for (let i = 0; i < RATE_LIMIT; i++) {
    assert.equal(checkSearchRateLimit(req, 1_000).allowed, true);
  }
  const blocked = checkSearchRateLimit(req, 1_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSeconds > 0);
  __testing.reset();
});

test('does not trust client-supplied proxy headers by default', () => {
  __testing.reset();
  const prior = process.env.BESTPRICE_TRUST_PROXY;
  delete process.env.BESTPRICE_TRUST_PROXY;
  try {
    for (let i = 0; i < RATE_LIMIT; i++) {
      const forged = request('{}', {
        'X-Forwarded-For': `8.8.8.${i + 1}`,
        'X-Real-IP': `9.9.9.${i + 1}`,
      });
      assert.equal(checkSearchRateLimit(forged, 2_000).allowed, true);
    }
    const anotherForgedIp = request('{}', { 'X-Forwarded-For': '1.1.1.1' });
    assert.equal(checkSearchRateLimit(anotherForgedIp, 2_000).allowed, false);
  } finally {
    if (prior === undefined) delete process.env.BESTPRICE_TRUST_PROXY;
    else process.env.BESTPRICE_TRUST_PROXY = prior;
    __testing.reset();
  }
});

test('global search slots are bounded and releases are idempotent', () => {
  __testing.reset();
  const releases = Array.from(
    { length: MAX_CONCURRENT_SEARCHES },
    () => acquireSearchSlot()
  );
  assert.ok(releases.every(Boolean));
  assert.equal(acquireSearchSlot(), null);

  releases[0]?.();
  releases[0]?.();
  assert.equal(__testing.active(), MAX_CONCURRENT_SEARCHES - 1);
  const replacement = acquireSearchSlot();
  assert.ok(replacement);

  for (const release of releases) release?.();
  replacement?.();
  assert.equal(__testing.active(), 0);
});

test('rejects browser requests from another origin', () => {
  const crossOrigin = request('{}', { Origin: 'https://attacker.example' });
  assert.throws(
    () => assertSameOrigin(crossOrigin),
    (err: unknown) => err instanceof RequestProblem && err.status === 403
  );

  const sameOrigin = request('{}', { Origin: 'https://bestprice.example' });
  assert.doesNotThrow(() => assertSameOrigin(sameOrigin));

  const internallyRewritten = new Request('http://localhost:3000/api/deals', {
    method: 'POST',
    headers: {
      Origin: 'https://bestprice.example',
      Host: 'bestprice.example',
    },
  });
  assert.doesNotThrow(() => assertSameOrigin(internallyRewritten));
});
