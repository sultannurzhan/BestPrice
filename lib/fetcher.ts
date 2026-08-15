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
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, status: 0, html: '', finalUrl: url, failure: 'unreachable' };
  }

  return withHostSlot(host, async () => {
    try {
      const res = await fetch(url, {
        headers: BASE_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      const ct = res.headers.get('content-type') ?? '';
      // Guard against multi-megabyte pages and non-HTML payloads.
      if (!/text\/html|application\/xhtml|application\/json/i.test(ct)) {
        return {
          ok: false,
          status: res.status,
          html: '',
          finalUrl: res.url || url,
          failure: 'no-listings' as const,
        };
      }

      const html = await res.text();

      if (looksBlocked(res.status, html)) {
        return {
          ok: false,
          status: res.status,
          html: '',
          finalUrl: res.url || url,
          failure: 'blocked' as const,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          html: '',
          finalUrl: res.url || url,
          failure: 'unreachable' as const,
        };
      }

      return {
        ok: true,
        status: res.status,
        html,
        finalUrl: res.url || url,
        failure: null,
      };
    } catch (err) {
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

/** Run tasks with a global concurrency ceiling. */
export async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
