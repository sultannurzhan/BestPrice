import { cacheGet, cacheSet, TTL } from '../cache';
import { diskGet, diskSet } from '../diskCache';
import { politeFetch } from '../fetcher';
import { elementBlocks, stripHtmlTags } from '../html';
import { normaliseProductText } from '../product';

/**
 * Work out how to search an arbitrary shop's website.
 *
 * The hard part is not finding a URL that returns 200 — it is confirming the
 * page is actually *search results for what we asked*. Two traps, both hit
 * during development against real KZ shops:
 *
 *   - sulpak.kz quietly redirects an unknown `/search?q=` to the homepage, whose
 *     recommendation carousel is full of prices. Naive checks accept it and the
 *     agent then "finds" a microwave when you asked for an iPhone.
 *   - Several shops render a results page whose products arrive later by JS, so
 *     the HTML has a price-range filter widget but no products.
 *
 * So a candidate URL is only accepted when it (a) did not bounce to the
 * homepage, (b) shows several prices, and (c) shows at least two product links
 * whose text actually mentions what we searched for.
 */

/** Ordered by how common they are among KZ retailers. */
const URL_PATTERNS = [
  '/search?q={q}',
  '/search/?q={q}',
  '/search?query={q}',
  '/search/?query={q}',
  // Sulpak and other ASP.NET shops use a capitalised path.
  '/Search?query={q}',
  '/search?text={q}',
  '/catalog/search?q={q}',
  '/?s={q}',
  '/index.php?route=product/search&search={q}',
  '/search/index.php?q={q}',
];

/** Probing is the slowest part of a search, so try a couple of URLs at a time. */
const PROBE_BATCH = 2;
const PROBE_TIMEOUT_MS = 7_000;

/** A working search URL is worth remembering for a long time. */
const DISK_TTL_POSITIVE = 30 * 24 * 60 * 60 * 1000;
/** "This site has no readable search" deserves rechecking sooner. */
const DISK_TTL_NEGATIVE = 3 * 24 * 60 * 60 * 1000;

export interface SearchEndpoint {
  /** Template with `{q}` where the URL-encoded query goes. */
  template: string;
}

function isSearchEndpoint(value: unknown): value is SearchEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const template = (value as Record<string, unknown>).template;
  return (
    typeof template === 'string' &&
    template.startsWith('/') &&
    template.includes('{q}') &&
    template.length <= 2_048
  );
}

export class BlockedError extends Error {
  constructor(public domain: string) {
    super(`${domain} refused automated requests`);
    this.name = 'BlockedError';
  }
}

/** Thrown when a site clearly has search but paints it with JavaScript. */
export class ClientRenderedError extends Error {
  constructor(public domain: string) {
    super(`${domain} renders search results client-side`);
    this.name = 'ClientRenderedError';
  }
}

function buildUrl(origin: string, template: string, query: string): string {
  return origin + template.replace('{q}', encodeURIComponent(query));
}

export function searchUrlFor(
  domain: string,
  endpoint: SearchEndpoint,
  query: string
): string {
  return buildUrl(`https://${domain}`, endpoint.template, query);
}

function countPrices(html: string): number {
  return (
    html.match(
      /\d[\d    .,]{2,14}(?:<[^>]{0,200}>|\s|&nbsp;)*(?:₸|〒|тг(?![\p{L}\p{N}])|тенге)/giu
    )
      ?.length ?? 0
  );
}

/**
 * How many product links mention the search term? This is what separates real
 * results from a homepage carousel.
 */
function countRelevantTitles(html: string, terms: string[], origin: string): number {
  if (terms.length === 0) return Infinity;
  const normalisedTerms = terms.map((term) =>
    normaliseProductText(term).toLowerCase()
  );
  const identifiers = normalisedTerms.filter((term) => /\d/.test(term));
  const variants = new Set([
    'pro', 'max', 'ultra', 'plus', 'mini', 'air', 'fe', 'lite', 'slim',
    'oled', 'fold', 'flip', 'se',
  ]);
  const familyTerms = normalisedTerms.filter(
    (term) => !/\d/.test(term) && !variants.has(term)
  );
  const normaliseHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
  let expectedHost: string;
  try {
    expectedHost = normaliseHost(new URL(origin).hostname);
  } catch {
    return 0;
  }

  let hits = 0;
  for (const block of elementBlocks(html, 'a')) {
    if (block.content.length > 300) continue;
    const href = block.attributes.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || /(?:^#|javascript:|\/(?:blog|news|article|help|about|search|tag)(?:\/|$))/i.test(href)) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(href, origin);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      normaliseHost(url.hostname) !== expectedHost
    ) {
      continue;
    }
    const path = url.pathname;
    const lastSegment = path.split('/').filter(Boolean).pop() ?? '';
    const productishHref =
      /\/(?:product|products|p|tovar|tovary|item|goods)\//i.test(path) ||
      /\d/.test(lastSegment) ||
      /[a-z0-9]+(?:-[a-z0-9]+){2,}/i.test(lastSegment);
    if (!productishHref) continue;
    const text = stripHtmlTags(block.content)
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < 3) continue;
    const lower = normaliseProductText(text).toLowerCase();
    const compact = lower.replace(/[^\p{L}\p{N}]+/gu, '');
    const hasTerm = (term: string) =>
      lower.includes(term) || compact.includes(term.replace(/[^\p{L}\p{N}]+/gu, ''));
    const hasIdentifiers = identifiers.every(hasTerm);
    const hasFamily = familyTerms.length === 0 || familyTerms.some(hasTerm);
    if (hasIdentifiers && hasFamily) hits++;
    if (hits >= 2) return hits;
  }
  return hits;
}

interface Verdict {
  accepted: boolean;
  /** True when the page looks like search chrome but the products never arrived. */
  clientRendered: boolean;
}

function judge(
  html: string,
  finalUrl: string,
  requestedUrl: string,
  terms: string[]
): Verdict {
  let landed: URL;
  let requested: URL;
  try {
    landed = new URL(finalUrl);
    requested = new URL(requestedUrl);
  } catch {
    return { accepted: false, clientRendered: false };
  }

  const normaliseHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
  if (normaliseHost(landed.hostname) !== normaliseHost(requested.hostname)) {
    return { accepted: false, clientRendered: false };
  }

  // Bounced to the homepage: whatever prices are here belong to a carousel.
  if (landed.pathname === '/' && requested.pathname !== '/' && !landed.search) {
    return { accepted: false, clientRendered: false };
  }

  const prices = countPrices(html);
  const relevant = countRelevantTitles(html, terms, landed.origin);

  if (prices >= 3 && relevant >= 2) return { accepted: true, clientRendered: false };

  // Search chrome present (filters, a results heading) but nothing priced:
  // the products are almost certainly fetched by JavaScript.
  const lower = html.toLowerCase();
  const hasSearchChrome = [
    'class="filter',
    "class='filter",
    'class="facet',
    "class='facet",
    'product-list',
    'search-result',
    'найдено',
    'результат поиска',
    'search results',
  ].some((marker) => lower.includes(marker));

  if (hasSearchChrome && prices < 3) {
    return { accepted: false, clientRendered: true };
  }

  return { accepted: false, clientRendered: false };
}

/** Read the site's own search form to learn its endpoint. */
function discoverFromForms(html: string, origin: string): string[] {
  const templates: string[] = [];

  // Many shops publish their search URL in schema.org SearchAction markup.
  const action = html.match(
    /"target"\s*:\s*"([^"]*\{search_term_string\}[^"]*)"/i
  );
  if (action) {
    try {
      const url = new URL(action[1].replace(/\{search_term_string\}/g, '{q}'), origin);
      templates.push(url.pathname + url.search);
    } catch {
      /* ignore */
    }
  }

  for (const block of elementBlocks(html, 'form')) {
    if (block.attributes.length > 2_000 || block.content.length > 6_000) continue;
    const attrs = block.attributes;
    const inner = block.content;

    const method = (attrs.match(/method=["']([^"']*)["']/i)?.[1] ?? 'get').toLowerCase();
    if (method !== 'get') continue;

    const formAction = attrs.match(/action=["']([^"']*)["']/i)?.[1] ?? '';

    for (const inputMatch of inner.matchAll(/<input\b[^>]*>/gi)) {
      const tag = inputMatch[0];
      const type = (tag.match(/type=["']([^"']*)["']/i)?.[1] ?? 'text').toLowerCase();
      if (!['search', 'text', ''].includes(type)) continue;

      const name = tag.match(/name=["']([^"']+)["']/i)?.[1];
      if (!name) continue;

      const searchy =
        /^(q|s|query|search|text|keyword|term)$/i.test(name) ||
        /search|поиск|искать/i.test(tag) ||
        /search|поиск/i.test(formAction);
      if (!searchy) continue;

      try {
        const url = new URL(formAction || '/', origin);
        const sep = url.search ? '&' : '?';
        templates.push(
          `${url.pathname}${url.search}${sep}${encodeURIComponent(name)}={q}`
        );
      } catch {
        /* ignore malformed action */
      }
    }
  }

  return [...new Set(templates)];
}

/**
 * Find a search URL template that returns genuine results for `probeQuery`.
 *
 * `terms` are lowercase tokens we expect to see in matching product titles.
 * Throws BlockedError / ClientRenderedError so callers can report the real
 * reason instead of a generic "nothing found".
 */
export async function discoverSearchEndpoint(
  domain: string,
  probeQuery: string,
  terms: string[],
  signal?: AbortSignal
): Promise<SearchEndpoint | null> {
  signal?.throwIfAborted();
  const cacheKey = `endpoint:${domain}`;

  const cachedValue = cacheGet<SearchEndpoint | null>(cacheKey);
  if (cachedValue !== undefined) return cachedValue;

  /**
   * Discovery is by far the slowest step — walking ten candidate URLs against
   * four unknown domains turned a 5 s search into a 60 s one. A site's search
   * URL almost never changes, so the answer is persisted; a negative answer is
   * kept for a shorter time in case a shop adds search later.
   */
  const remembered = await diskGet<unknown>(
    cacheKey,
    DISK_TTL_POSITIVE
  );
  if (remembered) {
    const value = remembered.value;
    // Honour the shorter negative TTL.
    if (
      (isSearchEndpoint(value) || value === null) &&
      (value !== null || remembered.ageMs <= DISK_TTL_NEGATIVE)
    ) {
      cacheSet(cacheKey, value, value ? TTL.endpoint : TTL.blocked);
      return value;
    }
  }

  const origin = `https://${domain}`;
  let sawClientRendered = false;
  /**
   * A host that accepts connections but never answers would otherwise burn the
   * full probe list at seven seconds a go. Two dead probes and we walk away.
   */
  let deadProbes = 0;
  const DEAD_PROBE_LIMIT = 2;

  const attempt = async (template: string): Promise<SearchEndpoint | null> => {
    signal?.throwIfAborted();
    const url = buildUrl(origin, template, probeQuery);
    const res = await politeFetch(url, { timeoutMs: PROBE_TIMEOUT_MS, signal });

    if (res.failure === 'blocked') throw new BlockedError(domain);
    if (res.failure === 'timeout' || res.failure === 'unreachable') deadProbes++;
    if (!res.ok) return null;

    const verdict = judge(res.html, res.finalUrl, url, terms);
    if (verdict.clientRendered) sawClientRendered = true;
    return verdict.accepted ? { template } : null;
  };

  const tryAll = async (templates: string[]): Promise<SearchEndpoint | null> => {
    for (let i = 0; i < templates.length; i += PROBE_BATCH) {
      signal?.throwIfAborted();
      if (deadProbes >= DEAD_PROBE_LIMIT) return null;

      const batch = templates.slice(i, i + PROBE_BATCH);
      const found = await Promise.all(batch.map((t) => attempt(t).catch((e) => e)));
      signal?.throwIfAborted();

      for (const r of found) {
        if (r instanceof BlockedError) throw r;
      }
      const hit = found.find(
        (r): r is SearchEndpoint => r !== null && !(r instanceof Error)
      );
      if (hit) return hit;
    }
    return null;
  };

  const remember = async (value: SearchEndpoint | null): Promise<void> => {
    cacheSet(cacheKey, value, value ? TTL.endpoint : TTL.blocked);
    await diskSet(cacheKey, value);
  };

  try {
    const conventional = await tryAll(URL_PATTERNS);
    if (conventional) {
      await remember(conventional);
      return conventional;
    }

    // Nothing conventional worked — ask the site how it searches.
    const home = await politeFetch(origin, { timeoutMs: PROBE_TIMEOUT_MS, signal });
    if (home.failure === 'blocked') throw new BlockedError(domain);

    if (home.ok) {
      const declared = discoverFromForms(home.html, origin).filter(
        (t) => !URL_PATTERNS.includes(t)
      );
      const found = await tryAll(declared.slice(0, 4));
      if (found) {
        await remember(found);
        return found;
      }
    }
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof BlockedError) {
      // Blocking is a property of the site, not of this query — but do not
      // persist it, since bot rules change and a 403 may be rate limiting.
      cacheSet(cacheKey, null, TTL.blocked);
      throw err;
    }
  }

  signal?.throwIfAborted();
  await remember(null);
  if (sawClientRendered) throw new ClientRenderedError(domain);
  return null;
}

export const __testing = {
  discoverFromForms,
  judge,
  countRelevantTitles,
  isSearchEndpoint,
  URL_PATTERNS,
};
