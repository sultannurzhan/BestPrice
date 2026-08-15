import { cached, TTL } from './cache';
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

function buildQuery(centre: Coords, radiusM: number): string {
  const clauses = SHOP_TYPES.map(
    (t) => `  nwr(around:${radiusM},${centre.lat},${centre.lon})["shop"="${t}"];`
  ).join('\n');

  return `[out:json][timeout:25];\n(\n${clauses}\n);\nout center tags;`;
}

async function askMirror(url: string, query: string): Promise<OverpassElement[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'BestPrice/0.1 (local price comparison tool)',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(40_000),
  });

  if (!res.ok) {
    const err = new Error(`${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const json = (await res.json()) as { elements?: OverpassElement[] };
  return json.elements ?? [];
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
async function runOverpass(query: string): Promise<OverpassElement[]> {
  const attempts: string[] = [];

  for (const url of MIRRORS) {
    const host = new URL(url).host;

    for (let tryNo = 0; tryNo < 2; tryNo++) {
      try {
        return await askMirror(url, query);
      } catch (err) {
        const status = (err as Error & { status?: number }).status;
        const message = err instanceof Error ? err.message : String(err);
        attempts.push(`${host}=${message}`);

        // Only a transient status is worth an immediate retry.
        if (tryNo === 0 && status !== undefined && TRANSIENT.has(status)) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        break;
      }
    }
  }

  throw new OverpassUnavailableError(attempts);
}

function normaliseDomain(raw: string | undefined): {
  domain: string | null;
  website: string | null;
} {
  if (!raw) return { domain: null, website: null };
  const trimmed = raw.trim();
  if (!trimmed) return { domain: null, website: null };

  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return {
      domain: url.hostname.replace(/^www\./i, '').toLowerCase(),
      website: url.origin,
    };
  } catch {
    return { domain: null, website: null };
  }
}

function buildAddress(tags: Record<string, string>): string | null {
  const street = tags['addr:street'];
  const houseNumber = tags['addr:housenumber'];
  const city = tags['addr:city'];
  const parts = [
    [street, houseNumber].filter(Boolean).join(' '),
    city,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function toStore(el: OverpassElement, centre: Coords): Store | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const name =
    tags.name ?? tags['name:ru'] ?? tags['name:kk'] ?? tags.brand ?? tags.operator;
  // An unnamed pin we cannot attribute to a retailer is not actionable.
  if (!name) return null;

  const { domain, website } = normaliseDomain(
    tags.website ?? tags['contact:website'] ?? tags.url ?? tags['brand:website']
  );

  const coords = { lat, lon };

  return {
    id: `${el.type}/${el.id}`,
    name: name.trim(),
    domain,
    website,
    shopType: tags.shop ?? 'unknown',
    coords,
    distanceM: Math.round(haversine(centre, coords)),
    address: buildAddress(tags),
    phone: tags.phone ?? tags['contact:phone'] ?? null,
    openingHours: tags.opening_hours ?? null,
  };
}

export interface StoreLookup {
  stores: Store[];
  /** Set when Overpass was unreachable and we served a cached copy. */
  staleAgeMs: number | null;
}

/**
 * Find tech shops within `radiusM` of `centre`, nearest first.
 *
 * Shop locations do not move, so results are cached in memory for a day and on
 * disk indefinitely. If every Overpass mirror is down — which happens — we fall
 * back to the disk copy at any age rather than failing the whole search.
 */
export async function findStores(
  centre: Coords,
  radiusM: number
): Promise<StoreLookup> {
  // Round the cache key so nearby searches share a result.
  const key = `stores:${centre.lat.toFixed(3)}:${centre.lon.toFixed(3)}:${radiusM}`;

  try {
    // Only genuinely fresh results enter the in-memory cache. The stale
    // fallback below is deliberately outside it, so the moment Overpass
    // recovers we go back to live data instead of serving a cached outage
    // for the rest of the day.
    const stores = await cached(key, TTL.stores, async (): Promise<Store[]> => {
      const fresh = await diskGet<Store[]>(key, TTL.stores);
      if (fresh) return fresh.value;

      const elements = await runOverpass(buildQuery(centre, radiusM));

      const found = dedupeStores(
        elements
          .map((el) => toStore(el, centre))
          .filter((s): s is Store => s !== null)
          // Overpass `around` is generous at the edges; enforce it ourselves.
          .filter((s) => s.distanceM <= radiusM)
          .sort((a, b) => a.distanceM - b.distanceM)
      );

      await diskSet(key, found);
      return found;
    });

    return { stores, staleAgeMs: null };
  } catch (err) {
    const stale = await diskGetStale<Store[]>(key);
    if (stale) return { stores: stale.value, staleAgeMs: stale.ageMs };
    throw err;
  }
}

/**
 * OSM often carries both a building `way` and an entrance `node` for the same
 * shop. Collapse pins of the same name within 60 m of each other.
 */
function dedupeStores(stores: Store[]): Store[] {
  const kept: Store[] = [];

  for (const store of stores) {
    const duplicate = kept.find(
      (k) =>
        k.name.toLowerCase() === store.name.toLowerCase() &&
        haversine(k.coords, store.coords) < 60
    );
    if (!duplicate) kept.push(store);
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
  }

  return groups;
}
