import { cacheDelete, cached, TTL } from './cache';
import { diskGet, diskGetStale, diskSet } from './diskCache';
import { haversine } from './geo';
import type { Coords, Store } from './types';

/**
 * Store discovery via OpenStreetMap's Overpass API — free, no key, worldwide.
 *
 * Two things learned the hard way and encoded here:
 *  1. The public instances are frequently overloaded (504) or slow, so we fail
 *     over across mirrors rather than trusting any single one.
 *  2. A regex tag filter (`["shop"~"^(a|b|c)$"]`) skips Overpass's tag index and
 *     times out; separate exact-match clauses use the index and return in ~15s.
 */

const MIRRORS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Status codes that mean "busy, try again" rather than "wrong request". */
const TRANSIENT = new Set([429, 502, 503, 504]);
const MAX_OVERPASS_BYTES = 8 * 1024 * 1024;
const MAX_OVERPASS_ELEMENTS = 5_000;
const MAX_STORES = 2_000;
const MAX_BRANCHES_PER_DOMAIN = 50;

/**
 * Nearby coordinates share an upstream lookup, but results are re-measured for
 * the exact user before they leave this module. The buffer covers the furthest
 * point inside a 0.001-degree cache cell (under 80 m anywhere on Earth).
 */
const CACHE_COORD_DECIMALS = 3;
const CACHE_CELL_BUFFER_M = 100;
const CACHE_VERSION = 2;

/** OSM `shop=*` values that plausibly sell consumer tech. */
const SHOP_TYPES = [
  'electronics',
  'computer',
  'mobile_phone',
  'hifi',
  'video_games',
  'camera',
  'appliance',
] as const;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function isOverpassElement(value: unknown): value is OverpassElement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const element = value as Record<string, unknown>;
  return (
    ['node', 'way', 'relation'].includes(String(element.type)) &&
    typeof element.id === 'number' &&
    Number.isSafeInteger(element.id) &&
    element.id > 0
  );
}

function buildQuery(centre: Coords, radiusM: number): string {
  const clauses = SHOP_TYPES.map(
    (t) => `  nwr(around:${radiusM},${centre.lat},${centre.lon})["shop"="${t}"];`
  ).join('\n');

  return `[out:json][timeout:25];\n(\n${clauses}\n);\nout center tags;`;
}

async function askMirror(
  url: string,
  query: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<OverpassElement[]> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'BestPrice/0.1 (local price comparison tool)',
    },
    body: 'data=' + encodeURIComponent(query),
    /**
     * Deliberately short. A healthy mirror answers this query in ~15 s, so
     * waiting 40 s only delays failing over to one that works — and on a
     * serverless host the whole request has a hard 60 s ceiling to fit inside.
     */
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!res.ok) {
    const err = new Error(`${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OVERPASS_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error('response too large');
  }
  if (!res.body) throw new Error('empty response');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OVERPASS_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());

  const parsed = JSON.parse(chunks.join('')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid Overpass response');
  }
  const json = parsed as {
    elements?: OverpassElement[];
    remark?: string;
  };

  /**
   * Overpass reports its own failures with HTTP 200: a server-side timeout or
   * out-of-memory comes back as an empty `elements` array plus a `remark`.
   * Taken at face value that reads as "there are no shops here", which is how
   * the deployed app confidently reported zero stores in central Almaty.
   * Treat it as a failure so we fail over to another mirror.
   */
  if (typeof json.remark === 'string' && /error|timed? ?out|memory/i.test(json.remark)) {
    throw new Error(`remark: ${json.remark.slice(0, 80)}`);
  }

  if (!Array.isArray(json.elements)) {
    throw new Error('invalid Overpass response');
  }

  return json.elements.slice(0, MAX_OVERPASS_ELEMENTS).filter(isOverpassElement);
}

export class OverpassUnavailableError extends Error {
  constructor(public attempts: string[]) {
    super(`All Overpass mirrors failed: ${attempts.join('; ')}`);
    this.name = 'OverpassUnavailableError';
  }
}

/**
 * Try each mirror in turn, giving overloaded ones a single second chance.
 *
 * The public instances return 504 under load constantly, and during development
 * all of them failed simultaneously — hence both the long mirror list and the
 * stale-cache fallback in `findStores`.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runOverpass(
  query: string,
  signal?: AbortSignal
): Promise<OverpassElement[]> {
  const attempts: string[] = [];
  /**
   * Leave room for the actual price scraping. Serverless hosts cap the whole
   * request (60s on Vercel Hobby), and burning it all on mirrors that are
   * timing out means the user waits a minute to be told nothing was found.
   */
  const deadline = Date.now() + 32_000;

  for (const url of MIRRORS) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) {
      attempts.push('deadline reached');
      break;
    }

    const host = new URL(url).host;

    for (let tryNo = 0; tryNo < 2; tryNo++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        attempts.push('deadline reached');
        break;
      }
      try {
        return await askMirror(url, query, Math.min(18_000, remainingMs), signal);
      } catch (err) {
        signal?.throwIfAborted();
        const status = (err as Error & { status?: number }).status;
        const message = err instanceof Error ? err.message : String(err);
        attempts.push(`${host}=${message}`);

        // Only a transient status is worth an immediate retry.
        if (tryNo === 0 && status !== undefined && TRANSIENT.has(status)) {
          const retryDelay = Math.min(700, Math.max(0, deadline - Date.now()));
          if (retryDelay === 0) break;
          await abortableDelay(retryDelay, signal);
          continue;
        }
        break;
      }
    }
  }

  throw new OverpassUnavailableError(attempts);
}

function normaliseDomain(raw: unknown): {
  domain: string | null;
  website: string | null;
} {
  if (typeof raw !== 'string' || !raw || raw.length > 4_096) {
    return { domain: null, website: null };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { domain: null, website: null };

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return { domain: null, website: null };
    }
    return {
      domain: url.hostname.replace(/^www\./i, '').toLowerCase(),
      website: url.origin,
    };
  } catch {
    return { domain: null, website: null };
  }
}

function buildAddress(tags: Record<string, string>): string | null {
  const safe = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.trim()
      ? value.trim().slice(0, max)
      : undefined;
  const street = safe(tags['addr:street'], 120);
  const houseNumber = safe(tags['addr:housenumber'], 30);
  const city = safe(tags['addr:city'], 100);
  const parts = [
    [street, houseNumber].filter(Boolean).join(' '),
    city,
  ].filter(Boolean);
  return parts.length ? parts.join(', ').slice(0, 240) : null;
}

function toStore(el: OverpassElement, centre: Coords): Store | null {
  const tags =
    el.tags && typeof el.tags === 'object' && !Array.isArray(el.tags)
      ? el.tags
      : {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    (lat as number) < -90 ||
    (lat as number) > 90 ||
    (lon as number) < -180 ||
    (lon as number) > 180
  ) {
    return null;
  }

  const rawName =
    tags.name ?? tags['name:ru'] ?? tags['name:kk'] ?? tags.brand ?? tags.operator;
  // An unnamed pin we cannot attribute to a retailer is not actionable.
  if (typeof rawName !== 'string' || !rawName.trim()) return null;
  const name = rawName.trim().slice(0, 160);

  const { domain, website } = normaliseDomain(
    tags.website ?? tags['contact:website'] ?? tags.url ?? tags['brand:website']
  );

  const coords = { lat: lat as number, lon: lon as number };
  const safeTag = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.trim()
      ? value.trim().slice(0, max)
      : null;

  return {
    id: `${el.type}/${el.id}`,
    name,
    domain,
    website,
    shopType: safeTag(tags.shop, 60) ?? 'unknown',
    coords,
    distanceM: Math.round(haversine(centre, coords)),
    address: buildAddress(tags),
    phone: safeTag(tags.phone ?? tags['contact:phone'], 80),
    openingHours: safeTag(tags.opening_hours, 200),
  };
}

export interface StoreLookup {
  stores: Store[];
  /** Set when Overpass was unreachable and we served a cached copy. */
  staleAgeMs: number | null;
}

function isCachedStore(value: unknown): value is Store {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const store = value as Record<string, unknown>;
  const coords = store.coords as Record<string, unknown> | null;
  const boundedNullableString = (item: unknown, max: number) =>
    item === null || (typeof item === 'string' && item.length <= max);
  return (
    typeof store.id === 'string' &&
    store.id.length > 0 &&
    store.id.length <= 200 &&
    typeof store.name === 'string' &&
    store.name.length > 0 &&
    store.name.length <= 160 &&
    boundedNullableString(store.domain, 253) &&
    boundedNullableString(store.website, 2_048) &&
    typeof store.shopType === 'string' &&
    store.shopType.length <= 60 &&
    coords !== null &&
    typeof coords === 'object' &&
    Number.isFinite(coords.lat) &&
    Number(coords.lat) >= -90 &&
    Number(coords.lat) <= 90 &&
    Number.isFinite(coords.lon) &&
    Number(coords.lon) >= -180 &&
    Number(coords.lon) <= 180 &&
    Number.isFinite(store.distanceM) &&
    Number(store.distanceM) >= 0 &&
    boundedNullableString(store.address, 240) &&
    boundedNullableString(store.phone, 80) &&
    boundedNullableString(store.openingHours, 200)
  );
}

function normaliseCachedStores(value: unknown): Store[] | null {
  if (!Array.isArray(value)) return null;
  const stores = value.slice(0, MAX_STORES).filter(isCachedStore);
  return stores.length > 0 ? stores : null;
}

/**
 * Find tech shops within `radiusM` of `centre`, nearest first.
 *
 * Shop locations do not move, so results are cached in memory for a day and on
 * bounded disk storage. If every Overpass mirror is down — which happens — we
 * fall back to the oldest retained disk copy rather than failing the search.
 */
export async function findStores(
  centre: Coords,
  radiusM: number,
  signal?: AbortSignal
): Promise<StoreLookup> {
  signal?.throwIfAborted();
  const cacheCentre = {
    lat: Number(centre.lat.toFixed(CACHE_COORD_DECIMALS)),
    lon: Number(centre.lon.toFixed(CACHE_COORD_DECIMALS)),
  };
  const key = `stores:v${CACHE_VERSION}:${cacheCentre.lat.toFixed(
    CACHE_COORD_DECIMALS
  )}:${cacheCentre.lon.toFixed(CACHE_COORD_DECIMALS)}:${radiusM}`;

  const forExactCentre = (stores: Store[]): Store[] =>
    stores
      .map((store) => ({
        ...store,
        distanceM: Math.round(haversine(centre, store.coords)),
      }))
      .filter((store) => store.distanceM <= radiusM)
      .sort((a, b) => a.distanceM - b.distanceM);

  try {
    // Only genuinely fresh results enter the in-memory cache. The stale
    // fallback below is deliberately outside it, so the moment Overpass
    // recovers we go back to live data instead of serving a cached outage
    // for the rest of the day.
    const stores = await cached(key, TTL.stores, async (workSignal): Promise<Store[]> => {
      const fresh = await diskGet<unknown>(key, TTL.stores);
      const freshStores = normaliseCachedStores(fresh?.value);
      if (freshStores) return freshStores;

      const lookupRadiusM = radiusM + CACHE_CELL_BUFFER_M;
      const elements = await runOverpass(
        buildQuery(cacheCentre, lookupRadiusM),
        workSignal
      );

      const found = dedupeStores(
        elements
          .map((el) => toStore(el, cacheCentre))
          .filter((s): s is Store => s !== null)
          // Overpass `around` is generous at the edges; enforce it ourselves.
          .filter((s) => s.distanceM <= lookupRadiusM)
          .sort((a, b) => a.distanceM - b.distanceM)
      ).slice(0, MAX_STORES);

      // Never persist an empty result. A transient Overpass failure that slips
      // through would otherwise poison the cache with "no shops here" for a
      // full day, and the disk copy would keep serving it after that.
      if (found.length > 0) await diskSet(key, found);
      return found;
    }, { signal });

    // Same reasoning as the disk cache: an empty answer is far more likely to
    // be a bad day at Overpass than a genuinely shopless neighbourhood, so let
    // the next request try again rather than holding it for a day.
    if (stores.length === 0) cacheDelete(key);

    return { stores: forExactCentre(stores), staleAgeMs: null };
  } catch (err) {
    signal?.throwIfAborted();
    const stale = await diskGetStale<unknown>(key);
    const staleStores = normaliseCachedStores(stale?.value);
    if (stale && staleStores) {
      return { stores: forExactCentre(staleStores), staleAgeMs: stale.ageMs };
    }
    throw err;
  }
}

/**
 * OSM often carries both a building `way` and an entrance `node` for the same
 * shop. Collapse pins of the same name within 60 m of each other.
 */
function dedupeStores(stores: Store[]): Store[] {
  const kept: Store[] = [];
  const cells = new Map<string, Store[]>();
  const cellSize = 0.0005;

  for (const store of stores) {
    const name = store.name.toLowerCase();
    const y = Math.floor(store.coords.lat / cellSize);
    const x = Math.floor(store.coords.lon / cellSize);
    let duplicate = false;

    for (let dy = -2; dy <= 2 && !duplicate; dy++) {
      for (let dx = -2; dx <= 2 && !duplicate; dx++) {
        const nearby = cells.get(`${name}:${y + dy}:${x + dx}`) ?? [];
        duplicate = nearby.some((candidate) => haversine(candidate.coords, store.coords) < 60);
      }
    }
    if (duplicate) continue;

    kept.push(store);
    const key = `${name}:${y}:${x}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(store);
    else cells.set(key, [store]);
  }

  return kept;
}

/**
 * Group stores by the retailer domain we would scrape.
 *
 * This is the main efficiency win: a chain quotes one price online for all its
 * branches, so 11 Technodom pins cost exactly one HTTP search, and the nearest
 * branch is the one we route the user to.
 */
export function groupByDomain(stores: Store[]): Map<string, Store[]> {
  const groups = new Map<string, Store[]>();

  for (const store of stores) {
    if (!store.domain) continue;
    const existing = groups.get(store.domain);
    if (existing) existing.push(store);
    else groups.set(store.domain, [store]);
  }

  // Nearest branch first within each chain.
  for (const branches of groups.values()) {
    branches.sort((a, b) => a.distanceM - b.distanceM);
    // The UI only needs the nearest branch and a compact alternatives list.
    // Bound pathological OSM data before it is repeated in the streamed deals.
    if (branches.length > MAX_BRANCHES_PER_DOMAIN) {
      branches.splice(MAX_BRANCHES_PER_DOMAIN);
    }
  }

  return groups;
}

export const __testing = {
  isOverpassElement,
  normaliseCachedStores,
};
