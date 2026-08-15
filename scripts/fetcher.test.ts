import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_RESPONSE_BYTES, politeFetch, __testing } from '../lib/fetcher';

const realFetch = globalThis.fetch;

test('rejects private and local retailer URLs before making a request', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('must not fetch');
  }) as typeof fetch;

  try {
    for (const url of [
      'http://127.0.0.1/admin',
      'http://10.0.0.4/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://localhost/',
    ]) {
      const result = await politeFetch(url);
      assert.equal(result.failure, 'unsafe-url', url);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('validates every redirect and refuses a redirect to a private host', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/secret' },
    });
  }) as typeof fetch;

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.failure, 'unsafe-url');
    assert.equal(calls, 1, 'the private redirect target must never be fetched');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('rejects oversized retailer responses before parsing them', async () => {
  globalThis.fetch = (async () =>
    new Response('<html></html>', {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Content-Length': String(MAX_RESPONSE_BYTES + 1),
      },
    })) as typeof fetch;

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.failure, 'response-too-large');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('stops reading a chunked response once its body crosses the limit', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < 7) controller.enqueue(chunk);
      else controller.close();
    },
  });
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.failure, 'response-too-large');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('recognises public and reserved address ranges', () => {
  assert.equal(__testing.isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(__testing.isPrivateOrReservedIp('10.1.2.3'), true);
  assert.equal(__testing.isPrivateOrReservedIp('::1'), true);
  assert.equal(__testing.isPrivateOrReservedIp('2001:4860:4860::8888'), false);
  assert.equal(__testing.isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
});
