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
  bytes: number;
}

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 500;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
let storeBytes = 0;

function estimateEntryBytes(key: string, value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return Infinity;
    return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(encoded, 'utf8');
  } catch {
    return Infinity;
  }
}

function deleteEntry(key: string): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  storeBytes = Math.max(0, storeBytes - entry.bytes);
  return store.delete(key);
}

/** Evict expired keys occasionally so the map cannot grow without bound. */
function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) deleteEntry(k);
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    deleteEntry(key);
    return undefined;
  }
  // Reads count as use: move the key to the tail so eviction is true LRU.
  store.delete(key);
  store.set(key, hit);
  return hit.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  const bytes = estimateEntryBytes(key, value);
  // Refresh insertion order so frequently updated keys outlive cold ones.
  deleteEntry(key);
  // One adversarial result must not consume the entire process cache.
  if (!Number.isFinite(bytes) || bytes > MAX_ENTRY_BYTES) return;

  sweep();
  // A high-cardinality or high-volume stream of fresh queries would otherwise
  // grow forever: expired-only sweeping does nothing while all rows are live.
  while (
    store.size >= MAX_ENTRIES ||
    storeBytes + bytes > MAX_CACHE_BYTES
  ) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    deleteEntry(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs, bytes });
  storeBytes += bytes;
}

/** Drop a key so the next caller recomputes it. */
export function cacheDelete(key: string): void {
  deleteEntry(key);
}

interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

/** Run `fn` unless a fresh cached value exists. Concurrent callers share one flight. */
const inFlight = new Map<string, Flight<unknown>>();

async function waitForFlight<T>(
  flight: Flight<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  flight.waiters++;
  let released = false;
  const releaseWaiter = () => {
    if (released) return;
    released = true;
    flight.waiters--;
    // Preserve useful single-flight work while another request still needs it,
    // but stop the loader once every waiting client has gone away.
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort(new DOMException('No cache waiters remain', 'AbortError'));
    }
  };

  try {
    if (!signal) return await flight.promise;

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        // Update the flight synchronously with AbortController.abort(), so a
        // caller arriving in the same tick cannot join a doomed flight.
        releaseWaiter();
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  } finally {
    releaseWaiter();
  }
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  { signal }: { signal?: AbortSignal } = {}
): Promise<T> {
  signal?.throwIfAborted();
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;

  const existing = inFlight.get(key);
  if (existing && !existing.controller.signal.aborted) {
    return waitForFlight(existing as Flight<T>, signal);
  }
  // A late caller must not inherit a flight whose last waiter already aborted.
  if (existing) inFlight.delete(key);

  const controller = new AbortController();
  const flight: Flight<T> = {
    promise: Promise.resolve(undefined as T),
    controller,
    waiters: 0,
    settled: false,
  };
  const promise = Promise.resolve()
    .then(() => fn(controller.signal))
    .then((value) => {
      cacheSet(key, value, ttlMs);
      return value;
    })
    .finally(() => {
      flight.settled = true;
      if (inFlight.get(key) === flight) inFlight.delete(key);
    });
  flight.promise = promise;

  inFlight.set(key, flight as Flight<unknown>);
  // If all callers cancel, the loader may reject after nobody is awaiting it.
  // Keep that rejection handled while preserving it for active waiters.
  void promise.catch(() => {});
  return waitForFlight(flight, signal);
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

export const __testing = {
  size: () => store.size,
  bytes: () => storeBytes,
  clear: () => {
    store.clear();
    storeBytes = 0;
    for (const flight of inFlight.values()) flight.controller.abort();
    inFlight.clear();
  },
  maxEntries: MAX_ENTRIES,
  maxBytes: MAX_CACHE_BYTES,
  maxEntryBytes: MAX_ENTRY_BYTES,
};
