import type { Listing } from '../types';

/**
 * Generic price extraction from an arbitrary retailer's search-results HTML.
 *
 * There are ~30 distinct shop domains within 5 km of central Almaty and only a
 * handful are big chains, so hand-written adapters alone would cover about half
 * the market. These strategies run in order of trustworthiness and the first one
 * that yields a usable set of rows wins:
 *
 *   1. JSON-LD  — schema.org Product/Offer. Exact, when present.
 *   2. Microdata — itemprop="price". Exact, when present.
 *   3. Embedded state — __NEXT_DATA__ / Nuxt / Bitrix JSON blobs.
 *   4. Proximity — pair each visible price with the most product-like link near it.
 *
 * Strategy 4 is the workhorse for the long tail and is deliberately fussy: it
 * strips chrome, refuses filter facets, scans in both directions (some templates
 * put the price above the title, some below), and scores candidate links on how
 * much they look like a product title rather than simply taking the closest —
 * on larek.kz the closest link to every price is "Нет отзывов" ("no reviews").
 */

const CURRENCY = '(?:₸|〒|тг(?![\\p{L}])|тенге|KZT)';
const PRICE_SOURCE = `(\\d[\\d\\u00a0\\u202f\\u2009 .,]{2,14}?)(?:<[^>]*>|\\s|&nbsp;|&#160;)*${CURRENCY}`;

/**
 * Always build a fresh regex rather than sharing one global instance.
 *
 * `String.prototype.matchAll` copies `lastIndex` from the regex it is given, so
 * a shared `/g/` object that an `exec` loop has advanced into the thousands
 * silently matches nothing against a short string. Sharing this one caused the
 * struck-through "old price" scan to always come back empty.
 */
function priceRegex(): RegExp {
  return new RegExp(PRICE_SOURCE, 'giu');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>')
    .replace(/&laquo;|&raquo;/gi, '"');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "159 990" / "1 239 990" / "3&nbsp;897" -> number. */
function parsePrice(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/** Remove chrome that carries prices but never products. */
function stripChrome(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
}

/**
 * Price-range filter facets look exactly like prices. Reject anything that is
 * introduced by a range word or sits inside a filter widget.
 */
const FACET_CONTEXT = /(?:filter|facet|range|slider|vueform|диапазон)/i;
const RANGE_PREFIX = /(?:до|от|from|to|más|свыше|менее|более)\s*$/i;

function isFacetPrice(html: string, index: number): boolean {
  const before = html.slice(Math.max(0, index - 220), index);
  if (RANGE_PREFIX.test(stripTags(before))) return true;
  if (FACET_CONTEXT.test(before.slice(-220))) return true;
  return false;
}

/** Product links look like /product/..., /p/..., /catalog/..., not /cart or /login. */
const BAD_HREF = /(?:cart|basket|login|register|compare|favou?rite|wishlist|javascript:|#$|\.(?:jpg|png|webp|svg|css|js)$)/i;

/** Hrefs that usually point at a product detail page. */
const PRODUCT_HREF = /\/(?:product|products|p|tovar|tovary|item|goods|catalog|shop)\//i;

/**
 * Anchor text that belongs to card furniture rather than the product.
 *
 * Real example: larek.kz puts a "Нет отзывов" ("no reviews") link closer to the
 * price than the product title, so a nearest-anchor rule captured that instead
 * of the product name for every row.
 */
const UI_TEXT =
  /^(?:нет отзывов|\d+\s*отзыв\w*|в корзину|купить|купить в кредит|сравнить|в сравнение|в избранное|подробнее|подробно|заказать|оформить|показать (?:ещё|еще|все)|все товары|быстрый просмотр|рассрочка|доставка|в наличии|нет в наличии|add to cart|buy now|compare|quick view|no reviews|\d+\s*reviews?)$/i;

function isPlausibleTitle(text: string): boolean {
  if (text.length < 10 || text.length > 220) return false;
  if (!/[a-zA-Zа-яА-ЯёЁ]/.test(text)) return false;
  // Reject nav-ish strings and price-only strings.
  if (/^\d[\d\s.,₸〒]*$/.test(text)) return false;
  if (UI_TEXT.test(text.trim())) return false;
  return text.trim().split(/\s+/).length >= 2;
}

/**
 * How much this anchor looks like a product title rather than card furniture.
 * Used to break ties when several anchors sit near the same price.
 */
function titleScore(text: string, href: string): number {
  let score = 0;
  if (PRODUCT_HREF.test(href)) score += 3;
  // Slug-like hrefs ("/apple-iphone-15-128gb-black") are a strong signal.
  if (/[a-z0-9]+(?:-[a-z0-9]+){2,}/i.test(href)) score += 2;

  const words = text.trim().split(/\s+/).length;
  if (words >= 3) score += 2;
  else if (words === 2) score += 0.5;

  // Model names almost always carry a digit.
  if (/\d/.test(text)) score += 1;
  // Long descriptive titles beat two-word labels.
  if (text.length >= 25) score += 1;

  return score;
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function dedupe(listings: Listing[]): Listing[] {
  const seen = new Set<string>();
  const out: Listing[] = [];
  for (const l of listings) {
    const key = `${l.url ?? l.title.toLowerCase()}|${l.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// strategy 1: JSON-LD
// ---------------------------------------------------------------------------

function fromJsonLd(html: string, domain: string, baseUrl: string): Listing[] {
  const out: Listing[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }

    const stack: unknown[] = [parsed];
    const guard = new Set<unknown>();

    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (guard.has(node)) continue;
      guard.add(node);

      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }

      const obj = node as Record<string, unknown>;
      const type = obj['@type'];
      const isProduct =
        type === 'Product' || (Array.isArray(type) && type.includes('Product'));

      if (isProduct && typeof obj.name === 'string') {
        const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
        const offerObj = (offers ?? {}) as Record<string, unknown>;
        const rawPrice = offerObj.price ?? offerObj.lowPrice ?? obj.price;
        const price = parsePrice(String(rawPrice ?? ''));

        if (price) {
          const url =
            typeof obj.url === 'string'
              ? absolutize(obj.url, baseUrl)
              : typeof offerObj.url === 'string'
                ? absolutize(offerObj.url as string, baseUrl)
                : null;
          const availability = String(offerObj.availability ?? '');
          out.push({
            title: stripTags(obj.name),
            price,
            oldPrice: null,
            url,
            domain,
            via: 'jsonld',
            inStock: availability
              ? /InStock|LimitedAvailability/i.test(availability)
              : null,
          });
        }
      }

      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// strategy 2: microdata
// ---------------------------------------------------------------------------

function fromMicrodata(html: string, domain: string, baseUrl: string): Listing[] {
  const out: Listing[] = [];
  // Each itemscope block that carries both a name and a price.
  const blockRe = /itemtype=["'][^"']*\/Product["'][\s\S]{0,4000}?(?=itemtype=["'][^"']*\/Product["']|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(html))) {
    const block = m[0];
    const priceM =
      block.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i) ??
      block.match(/itemprop=["']price["'][^>]*>([^<]+)</i);
    const nameM =
      block.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i) ??
      block.match(/itemprop=["']name["'][^>]*>([^<]+)</i);
    if (!priceM || !nameM) continue;

    const price = parsePrice(priceM[1]);
    if (!price) continue;

    const hrefM = block.match(/<a\b[^>]*href=["']([^"']+)["']/i);
    out.push({
      title: stripTags(nameM[1]),
      price,
      oldPrice: null,
      url: hrefM ? absolutize(hrefM[1], baseUrl) : null,
      domain,
      via: 'microdata',
      inStock: /InStock/i.test(block) ? true : null,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// strategy 3: embedded JSON state (Next.js / Nuxt / Bitrix)
// ---------------------------------------------------------------------------

function fromEmbeddedJson(html: string, domain: string, baseUrl: string): Listing[] {
  const out: Listing[] = [];
  const blobs: string[] = [];

  const nextData = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextData) blobs.push(nextData[1]);

  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    if (m[1].length > 200) blobs.push(m[1]);
  }

  for (const blob of blobs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.trim());
    } catch {
      continue;
    }

    const stack: unknown[] = [parsed];
    const guard = new Set<unknown>();
    let visited = 0;

    /**
     * Some shops ship a product catalogue as one embedded blob and filter it in
     * the browser rather than searching server-side — fmobile.kz serves a 911 KB
     * JSON payload that is byte-for-byte the same whatever you search for, so
     * the query filtering here is entirely ours. Walking an already-parsed
     * object is cheap, so the ceilings only guard against pathological input.
     */
    while (stack.length && visited < 600_000 && out.length < 6_000) {
      visited++;
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (guard.has(node)) continue;
      guard.add(node);

      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }

      const obj = node as Record<string, unknown>;
      // A product-ish record: has a name-like field and a price-like field.
      const name =
        (typeof obj.name === 'string' && obj.name) ||
        (typeof obj.title === 'string' && obj.title) ||
        (typeof obj.productName === 'string' && obj.productName) ||
        null;
      const rawPrice =
        obj.price ?? obj.salePrice ?? obj.currentPrice ?? obj.minPrice ?? obj.priceValue;

      if (name && (typeof rawPrice === 'number' || typeof rawPrice === 'string')) {
        const price = parsePrice(String(rawPrice));
        if (price && price > 100) {
          const oldRaw = obj.oldPrice ?? obj.listPrice ?? obj.priceOld;
          const slug =
            (typeof obj.url === 'string' && obj.url) ||
            (typeof obj.slug === 'string' && obj.slug) ||
            null;
          out.push({
            title: stripTags(String(name)),
            price,
            oldPrice: oldRaw ? parsePrice(String(oldRaw)) : null,
            url: slug ? absolutize(slug, baseUrl) : null,
            domain,
            via: 'embedded-json',
            inStock:
              typeof obj.inStock === 'boolean'
                ? obj.inStock
                : typeof obj.available === 'boolean'
                  ? obj.available
                  : null,
          });
        }
      }

      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// strategy 4: proximity (bidirectional)
// ---------------------------------------------------------------------------

interface Anchor {
  index: number;
  end: number;
  href: string;
  text: string;
  score: number;
}

function collectAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    const href = m[1];
    if (BAD_HREF.test(href)) continue;
    const text = stripTags(m[2]);
    if (!isPlausibleTitle(text)) continue;
    anchors.push({
      index: m.index,
      end: m.index + m[0].length,
      href,
      text,
      score: titleScore(text, href),
    });
  }

  return anchors;
}

function fromProximity(html: string, domain: string, baseUrl: string): Listing[] {
  const cleaned = stripChrome(html);
  const anchors = collectAnchors(cleaned);
  if (anchors.length === 0) return [];

  const out: Listing[] = [];
  // Window within which a price and a title plausibly belong to the same card.
  const WINDOW = 2200;

  const scanner = priceRegex();
  let m: RegExpExecArray | null;

  while ((m = scanner.exec(cleaned))) {
    const price = parsePrice(m[1]);
    if (!price || price < 300 || price > 200_000_000) continue;
    if (isFacetPrice(cleaned, m.index)) continue;

    // Choose the anchor that best combines closeness with looking like a real
    // product title. Pure proximity picks up card furniture such as a
    // "no reviews" link that happens to sit next to the price.
    let best: Anchor | null = null;
    let bestCost = Infinity;

    for (const a of anchors) {
      const distance = a.end <= m.index ? m.index - a.end : a.index - m.index;
      if (distance < 0 || distance > WINDOW) continue;

      // Bias towards titles that come before the price (the usual card layout).
      const positional = a.end <= m.index ? distance : distance * 1.6;
      // Each point of title-likeness is worth ~180 characters of distance.
      const cost = positional - a.score * 180;

      if (cost < bestCost) {
        bestCost = cost;
        best = a;
      }
    }

    if (!best) continue;

    // An "old price" often sits immediately before the current price.
    const tail = cleaned.slice(Math.max(0, m.index - 260), m.index);
    const oldM = [...tail.matchAll(priceRegex())].pop();
    const oldPrice = oldM ? parsePrice(oldM[1]) : null;

    out.push({
      title: best.text,
      price,
      oldPrice: oldPrice && oldPrice > price ? oldPrice : null,
      url: absolutize(best.href, baseUrl),
      domain,
      via: 'proximity',
      inStock: null,
    });
  }

  // Same title appearing with several prices: keep the lowest (usually the
  // discounted one; the higher figure is the struck-through original).
  const byTitle = new Map<string, Listing>();
  for (const l of out) {
    const key = `${l.url ?? l.title.toLowerCase()}`;
    const prev = byTitle.get(key);
    if (!prev || l.price < prev.price) byTitle.set(key, l);
  }

  return [...byTitle.values()];
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

export interface ExtractResult {
  listings: Listing[];
  strategy: string;
}

/** Minimum rows before we trust a structured strategy over proximity. */
const MIN_CONFIDENT_ROWS = 2;

export function extractListings(
  html: string,
  domain: string,
  baseUrl: string
): ExtractResult {
  const strategies: Array<[string, () => Listing[]]> = [
    ['jsonld', () => fromJsonLd(html, domain, baseUrl)],
    ['microdata', () => fromMicrodata(html, domain, baseUrl)],
    ['embedded-json', () => fromEmbeddedJson(html, domain, baseUrl)],
    ['proximity', () => fromProximity(html, domain, baseUrl)],
  ];

  let fallback: ExtractResult = { listings: [], strategy: 'none' };

  for (const [name, run] of strategies) {
    let rows: Listing[];
    try {
      rows = dedupe(run().filter((l) => l.price > 0 && l.title.length > 3));
    } catch {
      continue;
    }
    if (rows.length >= MIN_CONFIDENT_ROWS) return { listings: rows, strategy: name };
    if (rows.length > fallback.listings.length) fallback = { listings: rows, strategy: name };
  }

  return fallback;
}

export const __testing = { parsePrice, stripTags, isPlausibleTitle, fromProximity };
