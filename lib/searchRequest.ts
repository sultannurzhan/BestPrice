import { adapterFor } from './scrape/adapters';
import type { SearchRequest } from './types';

/** Bounds keep the Overpass query cheap and the scrape polite. */
export const MIN_RADIUS_M = 300;
export const MAX_RADIUS_M = 25_000;
/** Never scrape more than this many domains in one search. */
export const MAX_DOMAINS = 16;
/** Endpoint discovery is expensive, so only admit this many unknown shops. */
export const MAX_UNKNOWN_DOMAINS = 6;

export function validateSearchRequest(body: unknown): SearchRequest | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';
  const b = body as Record<string, unknown>;

  // JSON strings, booleans and null must not be coerced into valid coordinates.
  // In particular, Number(null) is zero, which silently moved malformed requests
  // to the Gulf of Guinea.
  const lat = typeof b.lat === 'number' ? b.lat : Number.NaN;
  const lon = typeof b.lon === 'number' ? b.lon : Number.NaN;
  const radiusM = typeof b.radiusM === 'number' ? b.radiusM : Number.NaN;
  const item = typeof b.item === 'string' ? b.item.trim() : '';

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'Invalid latitude';
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return 'Invalid longitude';
  if (!Number.isFinite(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) {
    return `Radius must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} metres`;
  }
  if (item.length < 2) return 'Item is required';
  if (item.length > 120) return 'Item description is too long';

  return { lat, lon, radiusM, item };
}

/**
 * Keep known retailers first, then admit the bounded unknown tail. Return every
 * omitted domain so coverage gaps can never disappear silently when either cap
 * is reached.
 */
export function selectDomains(ranked: string[]): {
  domains: string[];
  skipped: string[];
} {
  const known = ranked.filter((domain) => adapterFor(domain));
  const unknown = ranked.filter((domain) => !adapterFor(domain));
  const candidates = [...known, ...unknown.slice(0, MAX_UNKNOWN_DOMAINS)];
  const domains = candidates.slice(0, MAX_DOMAINS);
  const selected = new Set(domains);

  return {
    domains,
    skipped: ranked.filter((domain) => !selected.has(domain)),
  };
}
