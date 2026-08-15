import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from 'node:zlib';

import type { ScrapeFailure } from './types';

/**
 * Polite HTTP client for scraping retailer search pages.
 *
 * Rules we hold ourselves to:
 *  - identify as a normal browser (many KZ sites 403 anything else) but never
 *    rotate identities to defeat a block: one refusal and we back off;
 *  - cap concurrency per host so we never look like a flood;
 *  - hard timeouts so one slow shop cannot stall a whole search;
 *  - cache aggressively (see cache.ts) so repeat searches cost the site nothing.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BASE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,kk;q=0.8,en-US;q=0.7,en;q=0.6',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'Accept-Encoding': 'gzip, deflate, br',
};

/** fmobile.kz is about 3.8 MB; anything beyond this is not a search page budget. */
export const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const GLOBAL_OUTBOUND_LIMIT = 16;

const blockedIps = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIps.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  // Deprecated IPv4-compatible forms (`::192.168.1.1`) occupy ::/96. They
  // should never be used as public retailer endpoints and can otherwise bypass
  // the IPv4 block list through an IPv6 parser.
  ['::', 96],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedIps.addSubnet(network, prefix, 'ipv6');
}

function isPrivateOrReservedIp(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0];
  // IPv4-mapped IPv6 should normally arrive as IPv4 from dns.lookup. Rejecting
  // the mapped form avoids a second parsing path that could bypass IPv4 ranges.
  if (/^::ffff:/i.test(normalized)) return true;
  const family = isIP(normalized);
  if (family === 4) return blockedIps.check(normalized, 'ipv4');
  if (family === 6) return blockedIps.check(normalized, 'ipv6');
  return true;
}

class UnsafeUrlError extends Error {}

const DNS_TIMEOUT_MS = 3_000;

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function lookupAll(
  hostname: string,
  signal?: AbortSignal
): Promise<Array<{ address: string; family: number }>> {
  const timeout = AbortSignal.timeout(DNS_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    abortPromise(combined),
  ]);
}

interface ResolvedHttpUrl {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

async function assertPublicHttpUrl(
  raw: string,
  signal?: AbortSignal
): Promise<ResolvedHttpUrl> {
  signal?.throwIfAborted();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Malformed URL');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.href.length > 4_096
  ) {
    throw new UnsafeUrlError('Only public HTTP URLs are allowed');
  }
  // Retailer search pages should use the protocol's standard port. Blocking
  // arbitrary public ports narrows SSRF-like probing and avoids treating an
  // unrelated service on the same host as a shop website.
  if (url.port) {
    throw new UnsafeUrlError('Non-standard HTTP ports are not allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    (!hostname.includes('.') && isIP(hostname) === 0)
  ) {
    throw new UnsafeUrlError('Local hostnames are not allowed');
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new UnsafeUrlError('Private or reserved addresses are not allowed');
    }
    return {
      url,
      addresses: [{ address: hostname, family: literalFamily }],
    };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupAll(hostname, signal);
  } catch {
    signal?.throwIfAborted();
    // DNS failure is an ordinary unreachable retailer, not a security finding.
    throw new Error('DNS lookup failed');
  }
  if (addresses.length === 0) throw new Error('DNS returned no addresses');
  if (addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new UnsafeUrlError('Hostname resolves to a private or reserved address');
  }

  return { url, addresses };
}

type Transport = (target: ResolvedHttpUrl, signal: AbortSignal) => Promise<Response>;

function responseBody(res: import('node:http').IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (/\bbr\b/.test(encoding)) return res.pipe(createBrotliDecompress());
  if (/\bgzip\b/.test(encoding)) return res.pipe(createGunzip());
  if (/\bdeflate\b/.test(encoding)) return res.pipe(createInflate());
  return res;
}

function requestAddress(
  target: ResolvedHttpUrl,
  address: { address: string; family: number },
  signal: AbortSignal
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const { url } = target;
    const isHttps = url.protocol === 'https:';
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { ...BASE_HEADERS, Host: url.host },
      signal,
      agent: false,
    };
    if (isHttps) {
      Object.assign(options, {
        servername: url.hostname,
        checkServerIdentity: (_hostname: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
          checkServerIdentity(url.hostname, cert),
      });
    }

    const request = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, String(value));
        }
      }

      const status = res.statusCode ?? 500;
      const noBody = [204, 205, 304].includes(status);
      const decoded = noBody ? null : responseBody(res);
      const body = decoded
        ? (Readable.toWeb(decoded) as ReadableStream<Uint8Array>)
        : null;
      resolve(new Response(body, { status, headers }));
    });
    request.once('error', reject);
    request.end();
  });
}

/** Connect to an address we already validated, preserving the original Host/SNI. */
async function pinnedTransport(
  target: ResolvedHttpUrl,
  signal: AbortSignal
): Promise<Response> {
  let lastError: unknown = new Error('No resolved addresses');
  for (const address of target.addresses) {
    signal.throwIfAborted();
    try {
      return await requestAddress(target, address, signal);
    } catch (err) {
      signal.throwIfAborted();
      lastError = err;
    }
  }
  throw lastError;
}

let transportOverride: Transport | null = null;

async function readBody(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  if (!res.body) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

/** At most this many simultaneous requests to any single host. */
const PER_HOST_LIMIT = 2;
const hostQueues = new Map<string, Promise<unknown>>();
const hostActive = new Map<string, number>();
let globalActive = 0;

interface GlobalWaiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
}

const globalWaiters: GlobalWaiter[] = [];

function globalRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalActive = Math.max(0, globalActive - 1);

    for (;;) {
      const waiter = globalWaiters.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) continue;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      globalActive++;
      waiter.resolve(globalRelease());
      return;
    }
  };
}

function acquireGlobalSlot(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (globalActive < GLOBAL_OUTBOUND_LIMIT) {
    globalActive++;
    return Promise.resolve(globalRelease());
  }

  return new Promise((resolve, reject) => {
    const waiter: GlobalWaiter = { signal, resolve, reject };
    const onAbort = () => {
      const index = globalWaiters.indexOf(waiter);
      if (index >= 0) globalWaiters.splice(index, 1);
      reject(signal?.reason);
    };
    waiter.onAbort = onAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    globalWaiters.push(waiter);
  });
}

async function withGlobalSlot<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await acquireGlobalSlot(signal);
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    release();
  }
}

async function waitForSlot(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await promise.catch(() => {});
    return;
  }
  await Promise.race([promise.catch(() => {}), abortPromise(signal)]);
}

async function withHostSlot<T>(
  host: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  while ((hostActive.get(host) ?? 0) >= PER_HOST_LIMIT) {
    const queued = hostQueues.get(host);
    if (queued) await waitForSlot(queued, signal);
    // Re-check in case several callers woke together.
    if ((hostActive.get(host) ?? 0) < PER_HOST_LIMIT) break;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 60)),
      ...(signal ? [abortPromise(signal)] : []),
    ]);
  }
  signal?.throwIfAborted();
  hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
  const p = Promise.resolve().then(fn).finally(() => {
    const remaining = Math.max(0, (hostActive.get(host) ?? 1) - 1);
    if (remaining === 0) {
      hostActive.delete(host);
      hostQueues.delete(host);
    } else {
      hostActive.set(host, remaining);
    }
  });
  hostQueues.set(host, p.catch(() => {}));
  return p;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  html: string;
  finalUrl: string;
  failure: ScrapeFailure | null;
}

/** Detect the "we know you're a bot" pages so we can report them honestly. */
function looksBlocked(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /just a moment|cf-browser-verification|challenge-platform|access denied|attention required/i.test(
    body.slice(0, 4000)
  );
}

export async function politeFetch(
  url: string,
  {
    timeoutMs = 12_000,
    signal,
  }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<FetchResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const initial = await assertPublicHttpUrl(url, operationSignal);
    let current = initial;

    for (let redirectNo = 0; redirectNo <= MAX_REDIRECTS; redirectNo++) {
      // Apply both limits to every redirect hop. Otherwise a redirect could
      // bypass the destination host's politeness limit, and many distinct
      // domains could collectively exhaust sockets and memory.
      const hop = await withHostSlot(
        current.url.host,
        () =>
          withGlobalSlot(async () => {
            const res = await (transportOverride ?? pinnedTransport)(
              current,
              operationSignal
            );

            if ([301, 302, 303, 307, 308].includes(res.status)) {
              const location = res.headers.get('location');
              await res.body?.cancel().catch(() => {});
              return { kind: 'redirect' as const, status: res.status, location };
            }

            if ([403, 429, 503].includes(res.status)) {
              await res.body?.cancel().catch(() => {});
              return {
                kind: 'complete' as const,
                value: {
                  ok: false,
                  status: res.status,
                  html: '',
                  finalUrl: current.url.toString(),
                  failure: 'blocked' as const,
                },
              };
            }

            const ct = res.headers.get('content-type') ?? '';
            if (!/text\/html|application\/xhtml|application\/json/i.test(ct)) {
              await res.body?.cancel().catch(() => {});
              return {
                kind: 'complete' as const,
                value: {
                  ok: false,
                  status: res.status,
                  html: '',
                  finalUrl: current.url.toString(),
                  failure: 'no-listings' as const,
                },
              };
            }

            const html = await readBody(res);
            if (html === null) {
              return {
                kind: 'complete' as const,
                value: {
                  ok: false,
                  status: res.status,
                  html: '',
                  finalUrl: current.url.toString(),
                  failure: 'response-too-large' as const,
                },
              };
            }

            if (looksBlocked(res.status, html)) {
              return {
                kind: 'complete' as const,
                value: {
                  ok: false,
                  status: res.status,
                  html: '',
                  finalUrl: current.url.toString(),
                  failure: 'blocked' as const,
                },
              };
            }
            if (!res.ok) {
              return {
                kind: 'complete' as const,
                value: {
                  ok: false,
                  status: res.status,
                  html: '',
                  finalUrl: current.url.toString(),
                  failure: 'unreachable' as const,
                },
              };
            }

            return {
              kind: 'complete' as const,
              value: {
                ok: true,
                status: res.status,
                html,
                finalUrl: current.url.toString(),
                failure: null,
              },
            };
          }, operationSignal),
        operationSignal
      );

      if (hop.kind === 'complete') return hop.value;
      if (!hop.location || redirectNo === MAX_REDIRECTS) {
        return {
          ok: false,
          status: hop.status,
          html: '',
          finalUrl: current.url.toString(),
          failure: 'unreachable' as const,
        };
      }
      const redirected = new URL(hop.location, current.url);
      current = await assertPublicHttpUrl(redirected.toString(), operationSignal);
    }

    return { ok: false, status: 0, html: '', finalUrl: url, failure: 'unreachable' };
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof UnsafeUrlError) {
      return {
        ok: false,
        status: 0,
        html: '',
        finalUrl: url,
        failure: 'unsafe-url' as const,
      };
    }
    const timedOut =
      timeout.aborted ||
      (err instanceof Error &&
        (err.name === 'TimeoutError' || /timeout|aborted/i.test(err.message)));
    return {
      ok: false,
      status: 0,
      html: '',
      finalUrl: url,
      failure: timedOut ? ('timeout' as const) : ('unreachable' as const),
    };
  }
}

export const __testing = {
  isPrivateOrReservedIp,
  assertPublicHttpUrl,
  pinnedTransport,
  setTransport: (transport: Transport | null) => {
    transportOverride = transport;
  },
  readBody,
  hostStateSize: () => ({ active: hostActive.size, queues: hostQueues.size }),
  globalState: () => ({ active: globalActive, queued: globalWaiters.length }),
  globalLimit: GLOBAL_OUTBOUND_LIMIT,
};

/** Run tasks with a global concurrency ceiling. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  { signal }: { signal?: AbortSignal } = {}
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      signal?.throwIfAborted();
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
