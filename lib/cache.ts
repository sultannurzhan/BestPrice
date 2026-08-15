/**
 * Tiny in-process TTL cache.
 *
 * Retailer prices move on the order of hours, so caching search results for a
 * few minutes removes almost all repeat load from their servers while keeping
 * the app responsive. Scoped per server process — good enough for a single
 * instance; swap for Redis if this ever runs multi-instance.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

/** Evict expired keys occasionally so the map cannot grow without bound. */
function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  if (store.size > 500) sweep();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Drop a key so the next caller recomputes it. */
export function cacheDelete(key: string): void {
  store.delete(key);
}

/** Run `fn` unless a fresh cached value exists. Concurrent callers share one flight. */
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const p = (async () => {
    try {
      const value = await fn();
      cacheSet(key, value, ttlMs);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

export const TTL = {
  /** Store geometry barely changes. */
  stores: 24 * 60 * 60 * 1000,
  /** Prices change slowly; 10 min keeps us off retailers' backs. */
  search: 10 * 60 * 1000,
  /** Remember which URL pattern worked for a domain for a good while. */
  endpoint: 6 * 60 * 60 * 1000,
  /** Remember refusals so we stop hammering sites that block us. */
  blocked: 30 * 60 * 1000,
} as const;
