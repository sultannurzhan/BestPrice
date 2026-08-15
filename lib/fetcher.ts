import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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
};

/** fmobile.kz is about 3.8 MB; anything beyond this is not a search page budget. */
export const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 5;

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
  ['::', 128],
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

async function lookupAll(hostname: string): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

async function assertPublicHttpUrl(raw: string): Promise<URL> {
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
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupAll(hostname);
  } catch {
    // DNS failure is an ordinary unreachable retailer, not a security finding.
    throw new Error('DNS lookup failed');
  }
  if (addresses.length === 0) throw new Error('DNS returned no addresses');
  if (addresses.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new UnsafeUrlError('Hostname resolves to a private or reserved address');
  }

  return url;
}

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

async function withHostSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  while ((hostActive.get(host) ?? 0) >= PER_HOST_LIMIT) {
    await hostQueues.get(host)?.catch(() => {});
    // Re-check in case several callers woke together.
    if ((hostActive.get(host) ?? 0) < PER_HOST_LIMIT) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
  const p = fn().finally(() => {
    hostActive.set(host, Math.max(0, (hostActive.get(host) ?? 1) - 1));
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
  { timeoutMs = 12_000 }: { timeoutMs?: number } = {}
): Promise<FetchResult> {
  let initial: URL;
  try {
    initial = await assertPublicHttpUrl(url);
  } catch (err) {
    const failure = err instanceof UnsafeUrlError ? 'unsafe-url' : 'unreachable';
    return { ok: false, status: 0, html: '', finalUrl: url, failure };
  }

  return withHostSlot(initial.host, async () => {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      let current = initial;

      for (let redirectNo = 0; redirectNo <= MAX_REDIRECTS; redirectNo++) {
        const res = await fetch(current, {
          headers: BASE_HEADERS,
          redirect: 'manual',
          signal,
        });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          await res.body?.cancel().catch(() => {});
          if (!location || redirectNo === MAX_REDIRECTS) {
            return {
              ok: false,
              status: res.status,
              html: '',
              finalUrl: current.toString(),
              failure: 'unreachable' as const,
            };
          }
          const redirected = new URL(location, current);
          current = await assertPublicHttpUrl(redirected.toString());
          continue;
        }

        if ([403, 429, 503].includes(res.status)) {
          await res.body?.cancel().catch(() => {});
          return {
            ok: false,
            status: res.status,
            html: '',
            finalUrl: current.toString(),
            failure: 'blocked' as const,
          };
        }

        const ct = res.headers.get('content-type') ?? '';
        if (!/text\/html|application\/xhtml|application\/json/i.test(ct)) {
          await res.body?.cancel().catch(() => {});
          return {
            ok: false,
            status: res.status,
            html: '',
            finalUrl: current.toString(),
            failure: 'no-listings' as const,
          };
        }

        const html = await readBody(res);
        if (html === null) {
          return {
            ok: false,
            status: res.status,
            html: '',
            finalUrl: current.toString(),
            failure: 'response-too-large' as const,
          };
        }

        if (looksBlocked(res.status, html)) {
          return {
            ok: false,
            status: res.status,
            html: '',
            finalUrl: current.toString(),
            failure: 'blocked' as const,
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            html: '',
            finalUrl: current.toString(),
            failure: 'unreachable' as const,
          };
        }

        return {
          ok: true,
          status: res.status,
          html,
          finalUrl: current.toString(),
          failure: null,
        };
      }

      return { ok: false, status: 0, html: '', finalUrl: url, failure: 'unreachable' };
    } catch (err) {
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
        err instanceof Error &&
        (err.name === 'TimeoutError' || /timeout|aborted/i.test(err.message));
      return {
        ok: false,
        status: 0,
        html: '',
        finalUrl: url,
        failure: timedOut ? ('timeout' as const) : ('unreachable' as const),
      };
    }
  });
}

export const __testing = { isPrivateOrReservedIp, assertPublicHttpUrl, readBody };

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
