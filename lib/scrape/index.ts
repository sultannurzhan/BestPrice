import { cached, TTL } from '../cache';
import { politeFetch } from '../fetcher';
import type { DomainResult, ProductQuery, ScrapeFailure } from '../types';
import { adapterFor, IGNORED_DOMAINS } from './adapters';
import {
  BlockedError,
  ClientRenderedError,
  discoverSearchEndpoint,
  searchUrlFor,
} from './discover';
import { extractListings } from './extract';

export { IGNORED_DOMAINS };

/**
 * A single shop must never be able to stall the whole search.
 *
 * The budget mostly exists to cap endpoint *discovery*, which walks a list of
 * candidate URLs and can otherwise run to nearly a minute on an unresponsive
 * host. Domains with a confirmed adapter skip discovery altogether, so their
 * only cost is one fetch — and they are the ones actually returning stock, so
 * they get the more generous allowance.
 */
const KNOWN_DOMAIN_BUDGET_MS = 28_000;
const UNKNOWN_DOMAIN_BUDGET_MS = 16_000;

/**
 * Tokens we expect to see in a relevant product title, used to tell real search
 * results from a homepage carousel. Short tokens match too much, so drop them.
 */
function relevanceTerms(query: ProductQuery): string[] {
  const terms = query.requiredTokens.filter(
    (token) => token.length >= 3 || (/\d/.test(token) && token.length >= 2)
  );
  if (terms.length > 0) return terms.slice(0, 3);
  const fallback = query.searchTerm.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  return fallback.slice(0, 2);
}

/**
 * Search one retailer domain for the requested product.
 *
 * Order of play:
 *   1. skip domains that are not retail tech shops;
 *   2. report known-unreadable domains honestly rather than as "no stock";
 *   3. use the adapter's confirmed search URL, else discover one;
 *   4. parse with the adapter if it has one, else the generic extractor.
 */
export async function scrapeDomain(
  domain: string,
  query: ProductQuery,
  signal?: AbortSignal
): Promise<DomainResult> {
  signal?.throwIfAborted();
  const started = Date.now();

  const empty = (failure: ScrapeFailure, searchUrl: string | null = null): DomainResult => ({
    domain,
    listings: [],
    failure,
    tookMs: Date.now() - started,
    searchUrl,
  });

  if (IGNORED_DOMAINS.has(domain)) return empty('no-search-endpoint');

  const adapter = adapterFor(domain);
  if (adapter?.knownBlocked) return empty('blocked');
  if (adapter?.clientRendered) return empty('js-rendered');

  const cacheKey = `search:${domain}:${query.searchTerm.toLowerCase()}`;
  const budget = adapter?.searchTemplate
    ? KNOWN_DOMAIN_BUDGET_MS
    : UNKNOWN_DOMAIN_BUDGET_MS;
  const budgetSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(budget)])
    : AbortSignal.timeout(budget);

  try {
    return await cached(
      cacheKey,
      TTL.search,
      async (workSignal): Promise<DomainResult> => {
        let searchUrl: string;

        try {
          if (adapter?.searchTemplate) {
            searchUrl = searchUrlFor(
              domain,
              { template: adapter.searchTemplate },
              query.searchTerm
            );
          } else {
            const endpoint = await discoverSearchEndpoint(
              domain,
              query.searchTerm,
              relevanceTerms(query),
              workSignal
            );
            if (!endpoint) return empty('no-search-endpoint');
            searchUrl = searchUrlFor(domain, endpoint, query.searchTerm);
          }
        } catch (err) {
          workSignal.throwIfAborted();
          if (err instanceof BlockedError) return empty('blocked');
          if (err instanceof ClientRenderedError) return empty('js-rendered');
          return empty('unreachable');
        }

        /**
         * Known retailers get longer, because the ones worth waiting for are the
         * slow ones: fmobile.kz returns a 3.8 MB page and timed out at 12 s when the
         * deployed function ran in US-East. Unknown shops stay on a short leash so
         * the long tail cannot eat the request budget.
         */
        const res = await politeFetch(searchUrl, {
          timeoutMs: adapter?.searchTemplate ? 22_000 : 12_000,
          signal: workSignal,
        });
        if (!res.ok) return empty(res.failure ?? 'unreachable', searchUrl);

        const baseUrl = res.finalUrl || searchUrl;

        let listings = adapter?.parse ? adapter.parse(res.html, baseUrl) : [];
        // Adapters go stale when a retailer redesigns; fall back rather than
        // reporting a false "nothing found".
        if (listings.length === 0) {
          listings = extractListings(res.html, domain, baseUrl).listings;
        }

        return {
          domain,
          listings,
          failure: listings.length === 0 ? 'no-listings' : null,
          tookMs: Date.now() - started,
          searchUrl,
        };
      },
      { signal: budgetSignal }
    );
  } catch (err) {
    signal?.throwIfAborted();
    if (budgetSignal.aborted) return empty('timeout');
    throw err;
  }
}
