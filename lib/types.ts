/** Shared domain types for the BestPrice agent. */

export interface Coords {
  lat: number;
  lon: number;
}

/** A physical shop discovered from OpenStreetMap. */
export interface Store {
  /** OSM element id, prefixed by type: "node/123", "way/456". */
  id: string;
  name: string;
  /** Normalised host (no `www.`) taken from the OSM `website` tag, if any. */
  domain: string | null;
  website: string | null;
  shopType: string;
  coords: Coords;
  /** Straight-line metres from the user. */
  distanceM: number;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
}

/** One product listing scraped from a retailer's search results. */
export interface Listing {
  title: string;
  /** Price in whole tenge (KZT has no minor unit in practice). */
  price: number;
  /** Pre-discount price when the page advertises one. */
  oldPrice: number | null;
  url: string | null;
  domain: string;
  /** Which extraction strategy produced this row — useful for debugging. */
  via: string;
  inStock: boolean | null;
}

/** Why a domain produced no listings. */
export type ScrapeFailure =
  | 'blocked'
  | 'unreachable'
  | 'no-search-endpoint'
  /** Search results exist but are drawn by JavaScript, so plain HTTP sees none. */
  | 'js-rendered'
  | 'no-listings'
  | 'no-match'
  | 'timeout';

export interface DomainResult {
  domain: string;
  listings: Listing[];
  failure: ScrapeFailure | null;
  /** Milliseconds the whole domain scrape took. */
  tookMs: number;
  /** Search URL that actually worked, for transparency/debugging. */
  searchUrl: string | null;
}

/** A normalised understanding of what the user is shopping for. */
export interface ProductQuery {
  /** Raw user text. */
  raw: string;
  /** Cleaned search string sent to retailers. */
  searchTerm: string;
  brand: string | null;
  /** e.g. "iphone 15 pro" */
  model: string | null;
  /** Storage in GB, when the user specified it. */
  storageGb: number | null;
  /** RAM in GB, when the user specified it. */
  ramGb: number | null;
  category: ProductCategory | null;
  /** Tokens that MUST appear in a listing title for it to count. */
  requiredTokens: string[];
  /**
   * Set when the shopper is buying the accessory itself ("чехол для iphone"),
   * which switches off accessory rejection and the device price floor.
   */
  accessoryLabel: string | null;
  /** How the query was parsed. */
  via: 'rules' | 'llm';
}

export type ProductCategory =
  | 'smartphone'
  | 'laptop'
  | 'tablet'
  | 'tv'
  | 'headphones'
  | 'smartwatch'
  | 'monitor'
  | 'console'
  | 'camera'
  | 'component'
  | 'other';

/** A listing joined to the stores that sell it, with the ranking maths applied. */
export interface Deal {
  listing: Listing;
  store: Store;
  /** Extra stores of the same chain, nearer-first, that share this price. */
  alsoAt: Store[];
  match: MatchResult;
  cost: CostBreakdown;
  /** Final rank score — lower is better. */
  score: number;
  /** Human-readable reason this ranked where it did. */
  reasons: string[];
}

export interface MatchResult {
  /** 0..1 — how confidently this listing is the requested product. */
  confidence: number;
  /** Rejected accessories, wrong models, etc. */
  rejected: boolean;
  rejectReason: string | null;
}

export interface CostBreakdown {
  /** Sticker price in KZT. */
  price: number;
  /** Round-trip travel cost in KZT. */
  travel: number;
  /** Monetised round-trip travel time in KZT. */
  timeCost: number;
  /** price + travel + timeCost */
  total: number;
  distanceKm: number;
  /** Estimated one-way minutes by car in city traffic. */
  minutesOneWay: number;
}

/** Server-sent event payloads streamed to the browser while the agent works. */
export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'query'; query: ProductQuery }
  | { type: 'stores'; count: number; domains: number }
  | { type: 'domain'; domain: string; state: 'start' }
  | {
      type: 'domain';
      domain: string;
      state: 'done';
      found: number;
      failure: ScrapeFailure | null;
      tookMs: number;
    }
  | { type: 'results'; deals: Deal[]; summary: SearchSummary }
  | { type: 'error'; message: string };

/** A retailer we could not read, and the reason — shown so gaps are explicit. */
export interface CoverageGap {
  label: string;
  reason: string;
}

export interface SearchSummary {
  storesFound: number;
  domainsQueried: number;
  domainsSucceeded: number;
  listingsSeen: number;
  /** Listings that survived accessory/model filtering. */
  listingsMatched: number;
  /** Shops that produced a ranked deal. */
  dealsFound: number;
  /** Retailers we could not read, so the UI never implies they had no stock. */
  gaps: CoverageGap[];
  /** One-line natural-language verdict (LLM-written when a key is present). */
  verdict: string | null;
  tookMs: number;
}

export interface SearchRequest {
  lat: number;
  lon: number;
  /** Search radius in metres. */
  radiusM: number;
  item: string;
}
