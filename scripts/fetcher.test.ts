import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_RESPONSE_BYTES, politeFetch, pooled, __testing } from '../lib/fetcher';

test('rejects private and local retailer URLs before making a request', async () => {
  let calls = 0;
  __testing.setTransport(async () => {
    calls++;
    throw new Error('must not fetch');
  });

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
    __testing.setTransport(null);
  }
});

test('rejects retailer URLs on non-standard ports', async () => {
  let calls = 0;
  __testing.setTransport(async () => {
    calls++;
    throw new Error('must not fetch');
  });
  try {
    const result = await politeFetch('https://8.8.8.8:8443/search');
    assert.equal(result.failure, 'unsafe-url');
    assert.equal(calls, 0);
  } finally {
    __testing.setTransport(null);
  }
});

test('validates every redirect and refuses a redirect to a private host', async () => {
  let calls = 0;
  __testing.setTransport(async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/secret' },
    });
  });

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.failure, 'unsafe-url');
    assert.equal(calls, 1, 'the private redirect target must never be fetched');
  } finally {
    __testing.setTransport(null);
  }
});

test('rejects oversized retailer responses before parsing them', async () => {
  __testing.setTransport(async () =>
    new Response('<html></html>', {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Content-Length': String(MAX_RESPONSE_BYTES + 1),
      },
    }));

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.failure, 'response-too-large');
  } finally {
    __testing.setTransport(null);
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
  __testing.setTransport(async () =>
    new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.failure, 'response-too-large');
  } finally {
    __testing.setTransport(null);
  }
});

test('recognises public and reserved address ranges', () => {
  assert.equal(__testing.isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(__testing.isPrivateOrReservedIp('10.1.2.3'), true);
  assert.equal(__testing.isPrivateOrReservedIp('::1'), true);
  assert.equal(__testing.isPrivateOrReservedIp('2001:4860:4860::8888'), false);
  assert.equal(__testing.isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(__testing.isPrivateOrReservedIp('::192.168.1.1'), true);
  assert.equal(__testing.isPrivateOrReservedIp('::8.8.8.8'), true);
});

test('the worker pool stops scheduling work after cancellation', async () => {
  const controller = new AbortController();
  const started: number[] = [];

  await assert.rejects(
    () =>
      pooled(
        [1, 2, 3],
        1,
        async (item) => {
          started.push(item);
          controller.abort();
          return item;
        },
        { signal: controller.signal }
      ),
    (err: unknown) => err === controller.signal.reason
  );
  assert.deepEqual(started, [1]);
});

test('releases per-host bookkeeping after a request completes', async () => {
  __testing.setTransport(async () =>
    new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));

  try {
    const result = await politeFetch('https://8.8.4.4/search');
    assert.equal(result.ok, true);
    assert.deepEqual(__testing.hostStateSize(), { active: 0, queues: 0 });
  } finally {
    __testing.setTransport(null);
  }
});

test('propagates caller cancellation and releases the active host slot', async () => {
  const controller = new AbortController();
  __testing.setTransport(async (_target, signal) => {
    return new Promise<Response>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });

  try {
    const pending = politeFetch('https://8.8.8.8/search', {
      signal: controller.signal,
    });
    await Promise.resolve();
    const reason = new DOMException('client disconnected', 'AbortError');
    controller.abort(reason);

    await assert.rejects(pending, (err: unknown) => err === reason);
    assert.deepEqual(__testing.hostStateSize(), { active: 0, queues: 0 });
  } finally {
    __testing.setTransport(null);
  }
});

test('pins outbound connections to the already validated address', async () => {
  let connectedAddress = '';
  __testing.setTransport(async (target) => {
    connectedAddress = target.addresses[0]?.address ?? '';
    return new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  });

  try {
    const result = await politeFetch('https://8.8.8.8/search');
    assert.equal(result.ok, true);
    assert.equal(connectedAddress, '8.8.8.8');
  } finally {
    __testing.setTransport(null);
  }
});

test('the timeout includes time spent waiting for a host slot', async () => {
  let calls = 0;
  __testing.setTransport(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  });

  try {
    const first = politeFetch('https://8.8.8.8/a', { timeoutMs: 500 });
    const second = politeFetch('https://8.8.8.8/b', { timeoutMs: 500 });
    const queued = politeFetch('https://8.8.8.8/c', { timeoutMs: 40 });
    const queuedResult = await queued;

    assert.equal(queuedResult.failure, 'timeout');
    assert.equal(calls, 2, 'timed-out queued work must never reach the transport');
    await Promise.all([first, second]);
  } finally {
    __testing.setTransport(null);
  }
});

test('bounds outbound work across many distinct hosts', async () => {
  let active = 0;
  let peak = 0;
  __testing.setTransport(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  });

  try {
    const results = await Promise.all(
      Array.from({ length: __testing.globalLimit + 12 }, (_, i) =>
        politeFetch(`https://8.8.${Math.floor(i / 250)}.${(i % 250) + 1}/search`)
      )
    );
    assert.ok(results.every((result) => result.ok));
    assert.ok(peak <= __testing.globalLimit, `peak ${peak} exceeded global limit`);
    assert.deepEqual(__testing.globalState(), { active: 0, queued: 0 });
  } finally {
    __testing.setTransport(null);
  }
});

test('redirected requests obey the destination host limit', async () => {
  let targetActive = 0;
  let targetPeak = 0;
  __testing.setTransport(async (target) => {
    if (target.url.hostname !== '9.9.9.9') {
      return new Response(null, {
        status: 302,
        headers: { Location: `https://9.9.9.9${target.url.pathname}` },
      });
    }

    targetActive++;
    targetPeak = Math.max(targetPeak, targetActive);
    await new Promise((resolve) => setTimeout(resolve, 20));
    targetActive--;
    return new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  });

  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        politeFetch(`https://8.8.1.${i + 1}/redirect-${i}`)
      )
    );
    assert.ok(results.every((result) => result.ok));
    assert.ok(targetPeak <= 2, `redirect target peak was ${targetPeak}`);
    assert.deepEqual(__testing.hostStateSize(), { active: 0, queues: 0 });
  } finally {
    __testing.setTransport(null);
  }
});
