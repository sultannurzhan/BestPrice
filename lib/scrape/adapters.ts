import type { Listing } from '../types';

/**
 * Per-retailer knowledge.
 *
 * Everything here was verified against the live sites rather than assumed. Three
 * kinds of entry:
 *
 *   - `searchTemplate`: a confirmed search URL, so we skip endpoint discovery
 *     (much the slowest step) entirely;
 *   - `knownBlocked` / `clientRendered`: sites we have confirmed we cannot read,
 *     recorded so the UI can say *why* a big chain is missing instead of
 *     pretending it had no stock;
 *   - `parse`: markup-specific parsing where the generic extractor does badly.
 *
 * Re-check these with `npm run probe -- <domain> "<query>"` when a retailer
 * redesigns.
 */

export interface Adapter {
  domain: string;
  label: string;
  searchTemplate?: string;
  parse?: (html: string, baseUrl: string) => Listing[];
  /** Site refuses automated requests outright. */
  knownBlocked?: boolean;
  /** Site returns a results page whose products are drawn by JavaScript. */
  clientRendered?: boolean;
  /** Shown in the UI to explain a gap in coverage. */
  note?: string;
}

export const ADAPTERS: Record<string, Adapter> = {
  // --- confirmed working, server-rendered -------------------------------
  'fmobile.kz': {
    domain: 'fmobile.kz',
    label: 'Freedom Mobile',
    // 17 branches in Almaty — the widest physical coverage we can actually read.
    //
    // Its `?s=` page does not search server-side: every query returns the same
    // 3.8 MB page carrying a ~911 KB JSON catalogue of roughly 260 products,
    // which the site filters in the browser. We read that catalogue and do the
    // filtering ourselves, so prices are real but the range is limited to
    // whatever is in that feed.
    searchTemplate: '/?s={q}',
  },
  'tgrad.kz': {
    domain: 'tgrad.kz',
    label: 'ТехноGrad',
    searchTemplate: '/search?q={q}',
  },
  'larek.kz': {
    domain: 'larek.kz',
    label: 'Larek',
    searchTemplate: '/search/?query={q}',
  },

  // --- confirmed unreadable ---------------------------------------------
  'technodom.kz': {
    domain: 'technodom.kz',
    label: 'Technodom',
    knownBlocked: true,
    note: 'Blocks automated requests (HTTP 403).',
  },
  'mechta.kz': {
    domain: 'mechta.kz',
    label: 'Mechta',
    knownBlocked: true,
    note: 'Behind a Cloudflare challenge.',
  },
  'dns-shop.kz': {
    domain: 'dns-shop.kz',
    label: 'DNS',
    knownBlocked: true,
    note: 'Blocks automated requests (HTTP 403).',
  },
  'ispace.kz': {
    domain: 'ispace.kz',
    label: 'iSpace',
    knownBlocked: true,
    note: 'Blocks automated requests (HTTP 403).',
  },
  'ifix.kz': {
    domain: 'ifix.kz',
    label: 'iFix',
    knownBlocked: true,
    note: 'Blocks automated requests (HTTP 403).',
  },
  'sulpak.kz': {
    domain: 'sulpak.kz',
    label: 'Sulpak',
    clientRendered: true,
    // /search?q= silently redirects to the homepage; the real endpoint is
    // /Search?query= and it paints results with JavaScript.
    note: 'Search results are rendered by JavaScript, so prices are not in the HTML.',
  },
  'alser.kz': {
    domain: 'alser.kz',
    label: 'Alser',
    clientRendered: true,
    note: 'Nuxt storefront; search results are rendered by JavaScript.',
  },
  'shop.kz': {
    domain: 'shop.kz',
    label: 'Shop.kz',
    clientRendered: true,
    note: 'Search results are rendered by JavaScript.',
  },
  '1v.kz': {
    domain: '1v.kz',
    label: 'Белый Ветер',
    clientRendered: true,
    note: 'Search results are rendered by JavaScript.',
  },
  'marvel.kz': {
    domain: 'marvel.kz',
    label: 'Marvel',
    knownBlocked: true,
    note: 'B2B distributor; prices require a trade account.',
  },
};

/**
 * Mapped as shops in OSM but never sell retail tech over the counter —
 * mobile operators' service points, vendor offices, repair desks.
 */
export const IGNORED_DOMAINS = new Set([
  'kcell.kz',
  'altel.kz',
  'tele2.kz',
  'beeline.kz',
  'activ.kz',
  'izi.kz',
  'honeywell.com',
  'bosch.com',
  'lg.com',
  'samsung.com',
]);

export function adapterFor(domain: string): Adapter | undefined {
  return ADAPTERS[domain];
}

/** Human label for a domain, falling back to the bare host. */
export function labelFor(domain: string): string {
  return ADAPTERS[domain]?.label ?? domain;
}
