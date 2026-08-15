import type { Listing } from '../types';
import {
  elementBlocks,
  maskHtmlTags,
  removeHtmlElementBlocks,
  stripHtmlTags,
} from '../html';

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
const PRICE_SOURCE = `(\\d[\\d\\u00a0\\u202f\\u2009 .,]{2,14}?)(?:<[^>]{0,200}>|\\s|&nbsp;|&#160;)*${CURRENCY}`;
const MAX_LISTINGS = 1_000;
const MAX_STRUCTURED_NODES = 100_000;
const MAX_TITLE_LENGTH = 300;
const MAX_ANCHORS = 5_000;

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
  return decodeEntities(stripHtmlTags(html))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "159 990" / "1 239 990" / "3&nbsp;897" -> number. */
function parsePrice(raw: string): number | null {
  const compact = decodeEntities(raw).replace(/[^\d.,]/g, '');
  // Structured data commonly writes `443990.00`. Treat a final one- or
  // two-digit group as decimals; three digits are a thousands separator.
  const decimal = compact.match(
    /^(\d{1,3}(?:[.,]\d{3})*|\d+)[.,](\d{1,2})$/
  );
  if (decimal) {
    const whole = decimal[1].replace(/[^\d]/g, '');
    const n = Number(`${whole}.${decimal[2]}`);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  const digits = compact.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

/** Remove chrome that carries prices but never products. */
function stripChrome(html: string): string {
  let cleaned = html;
  for (const tag of ['script', 'style', 'noscript', 'nav', 'footer', 'svg']) {
    cleaned = removeHtmlElementBlocks(cleaned, tag);
  }
  return cleaned;
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
const BAD_HREF = /(?:cart|basket|login|register|compare|favou?rite|wishlist|javascript:|#$|\.(?:jpg|png|webp|svg|css|js)$|\/(?:blog|news|article|articles|category|categories|review|reviews|search|tag)(?:\/|[?#]|$))/i;

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
  if (text.length < 3 || text.length > 220) return false;
  if (!/\p{L}/u.test(text)) return false;
  // Reject nav-ish strings and price-only strings.
  if (/^\d[\d\s.,₸〒]*$/.test(text)) return false;
  if (UI_TEXT.test(text.trim())) return false;
  const words = text.trim().split(/\s+/);
  if (words.length >= 2) return true;
  // Compact model names such as PS5 are valid product titles, not UI chrome.
  return /^(?=[\p{L}\p{N}._+-]*\p{L})(?=[\p{L}\p{N}._+-]*\d)[\p{L}\p{N}._+-]+$/u.test(
    text.trim()
  );
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
    const baseUrl = new URL(base);
    const url = new URL(href, baseUrl);
    const normaliseHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 2_048 ||
      normaliseHost(url.hostname) !== normaliseHost(baseUrl.hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function availabilityOf(raw: unknown): boolean | null {
  const value = String(raw ?? '');
  if (!value) return null;
  // Negative phrases first: Russian `нет в наличии` contains the positive
  // phrase `в наличии`.
  if (/OutOfStock|SoldOut|Discontinued|(?:нет|не)\s+в\s+наличии|not\s+available|(?:data-)?available\s*[:=]\s*["']?false|распродан|закончился|unavailable/i.test(value)) return false;
  if (/InStock|LimitedAvailability|в\s+наличии|есть\s+в\s+наличии|(?:data-)?available\s*[:=]\s*["']?true|\bavailable\b/i.test(value)) return true;
  return null;
}

function supportsKzt(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true;
  return /^(?:KZT|₸)$/i.test(String(raw).trim());
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
  for (const block of elementBlocks(html, 'script')) {
    if (
      block.attributes.length > 4_096 ||
      !/type=["']application\/ld\+json["']/i.test(block.attributes)
    ) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.content.trim());
    } catch {
      continue;
    }

    const stack: unknown[] = [parsed];
    const guard = new Set<unknown>();

    let visited = 0;
    while (stack.length && visited++ < MAX_STRUCTURED_NODES && out.length < MAX_LISTINGS) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (guard.has(node)) continue;
      guard.add(node);

      if (Array.isArray(node)) {
        const room = Math.max(0, MAX_STRUCTURED_NODES - visited - stack.length);
        for (let i = Math.min(node.length, room) - 1; i >= 0; i--) {
          stack.push(node[i]);
        }
        continue;
      }

      const obj = node as Record<string, unknown>;
      const type = obj['@type'];
      const isProduct =
        type === 'Product' || (Array.isArray(type) && type.includes('Product'));

      if (isProduct && typeof obj.name === 'string') {
        const offers = (Array.isArray(obj.offers) ? obj.offers.slice(0, 100) : [obj.offers])
          .filter((offer): offer is Record<string, unknown> =>
            Boolean(offer) && typeof offer === 'object' && !Array.isArray(offer)
          );
        if (offers.length === 0) offers.push(obj);

        // Select among complete, usable offers. Looking only at currency first
        // lets a placeholder KZT offer with no price hide a later valid offer.
        const candidates = offers
          .map((offer) => {
            const currency = offer.priceCurrency ?? obj.priceCurrency;
            const rawPrice = offer.price ?? offer.lowPrice;
            const price = parsePrice(String(rawPrice ?? ''));
            const inStock = availabilityOf(offer.availability);
            return {
              offer,
              price,
              inStock,
              explicitKzt: /^(?:KZT|₸)$/i.test(String(offer.priceCurrency ?? '').trim()),
              supported: supportsKzt(currency),
            };
          })
          .filter(
            (candidate): candidate is typeof candidate & { price: number } =>
              candidate.supported && candidate.price !== null && candidate.price > 0
          )
          .sort((a, b) => {
            // Prefer purchasable or unverified offers to known out-of-stock
            // offers, then explicit KZT, then the lower current price.
            const stockA = a.inStock === false ? 1 : 0;
            const stockB = b.inStock === false ? 1 : 0;
            return stockA - stockB || Number(b.explicitKzt) - Number(a.explicitKzt) || a.price - b.price;
          });
        const candidate = candidates[0];
        if (!candidate) continue;
        const offerObj = candidate.offer;

        {
          const url =
            typeof obj.url === 'string'
              ? absolutize(obj.url, baseUrl)
              : typeof offerObj.url === 'string'
                ? absolutize(offerObj.url as string, baseUrl)
                : null;
          out.push({
            title: stripTags(obj.name),
            price: candidate.price,
            oldPrice: null,
            url,
            domain,
            via: 'jsonld',
            inStock: candidate.inStock,
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
  const blockRe = /itemtype=["'][^"']{0,500}\/Product["'][\s\S]{0,4000}?(?=itemtype=["'][^"']{0,500}\/Product["']|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(html)) && out.length < MAX_LISTINGS) {
    const block = m[0];
    const priceM =
      block.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i) ??
      block.match(/itemprop=["']price["'][^>]*>([^<]+)</i);
    const nameM =
      block.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i) ??
      block.match(/itemprop=["']name["'][^>]*>([^<]+)</i);
    if (!priceM || !nameM) continue;

    const currencyM =
      block.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i) ??
      block.match(/itemprop=["']priceCurrency["'][^>]*>([^<]+)</i);
    if (currencyM && !supportsKzt(stripTags(currencyM[1]))) continue;

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
      inStock: availabilityOf(block),
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

  for (const block of elementBlocks(html, 'script')) {
    if (block.attributes.length > 4_096) continue;
    const isNextData = /id=["']__NEXT_DATA__["']/i.test(block.attributes);
    const isJson = /type=["']application\/json["']/i.test(block.attributes);
    if ((isNextData || isJson) && block.content.length > 200) {
      blobs.push(block.content);
    }
  }

  for (const blob of blobs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.trim());
    } catch {
      continue;
    }

    interface EmbeddedEntry {
      node: unknown;
      currency: unknown;
      inStock: boolean | null;
    }
    const stack: EmbeddedEntry[] = [
      { node: parsed, currency: undefined, inStock: null },
    ];
    const guard = new Set<unknown>();
    let visited = 0;

    /**
     * Some shops ship a product catalogue as one embedded blob and filter it in
     * the browser rather than searching server-side — fmobile.kz serves a 911 KB
     * JSON payload that is byte-for-byte the same whatever you search for, so
     * the query filtering here is entirely ours. Walking an already-parsed
     * object is cheap, so the ceilings only guard against pathological input.
     */
    while (stack.length && visited < MAX_STRUCTURED_NODES && out.length < MAX_LISTINGS) {
      visited++;
      const entry = stack.pop();
      if (!entry) continue;
      const { node } = entry;
      if (!node || typeof node !== 'object') continue;
      if (guard.has(node)) continue;
      guard.add(node);

      if (Array.isArray(node)) {
        const room = Math.max(0, MAX_STRUCTURED_NODES - visited - stack.length);
        for (let i = Math.min(node.length, room) - 1; i >= 0; i--) {
          stack.push({ node: node[i], currency: entry.currency, inStock: entry.inStock });
        }
        continue;
      }

      const obj = node as Record<string, unknown>;
      const ownCurrency = obj.priceCurrency ?? obj.currencyCode ?? obj.currency;
      const effectiveCurrency = ownCurrency ?? entry.currency;
      const ownStock =
        typeof obj.inStock === 'boolean'
          ? obj.inStock
          : typeof obj.available === 'boolean'
            ? obj.available
            : availabilityOf(obj.availability ?? obj.stockStatus);
      const effectiveStock = ownStock ?? entry.inStock;
      // A product-ish record: has a name-like field and a price-like field.
      const name =
        (typeof obj.name === 'string' && obj.name) ||
        (typeof obj.title === 'string' && obj.title) ||
        (typeof obj.productName === 'string' && obj.productName) ||
        null;
      const rawPrice =
        obj.price ?? obj.salePrice ?? obj.currentPrice ?? obj.minPrice ?? obj.priceValue;

      if (name && (typeof rawPrice === 'number' || typeof rawPrice === 'string')) {
        if (!supportsKzt(effectiveCurrency)) {
          for (const v of Object.values(obj)) {
            if (v && typeof v === 'object') {
              stack.push({ node: v, currency: effectiveCurrency, inStock: effectiveStock });
            }
          }
          continue;
        }
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
            inStock: effectiveStock,
          });
        }
      }

      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
          stack.push({ node: v, currency: effectiveCurrency, inStock: effectiveStock });
        }
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

function collectAnchors(html: string, baseUrl: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const block of elementBlocks(html, 'a')) {
    if (anchors.length >= MAX_ANCHORS) break;
    if (block.attributes.length > 2_000 || block.content.length > 400) continue;
    const href = block.attributes.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    if (BAD_HREF.test(href)) continue;
    const safeHref = absolutize(href, baseUrl);
    if (!safeHref) continue;
    const text = stripTags(block.content);
    if (!isPlausibleTitle(text)) continue;
    anchors.push({
      index: block.start,
      end: block.end,
      href: safeHref,
      text,
      score: titleScore(text, safeHref),
    });
  }

  return anchors;
}

function fromProximity(html: string, domain: string, baseUrl: string): Listing[] {
  const cleaned = stripChrome(html);
  const anchors = collectAnchors(cleaned, baseUrl);
  if (anchors.length === 0) return [];
  // Preserve string length so anchor and price offsets remain comparable while
  // allowing split markup such as `443 <span>990</span> ₸` to parse as 443990.
  const priceSurface = maskHtmlTags(cleaned).replace(
    /&(?:nbsp|#160|#x0*a0|#8239|#x202f);/giu,
    (entity) => ' '.repeat(entity.length)
  );

  const out: Listing[] = [];
  // Window within which a price and a title plausibly belong to the same card.
  const WINDOW = 2200;

  const scanner = priceRegex();
  let m: RegExpExecArray | null;
  let firstNearbyAnchor = 0;

  while ((m = scanner.exec(priceSurface)) && out.length < MAX_LISTINGS) {
    const price = parsePrice(m[1]);
    if (!price || price < 300 || price > 200_000_000) continue;
    if (isFacetPrice(cleaned, m.index)) continue;
    const beforePrice = stripTags(cleaned.slice(Math.max(0, m.index - 100), m.index));
    const afterPrice = stripTags(cleaned.slice(m.index + m[0].length, m.index + m[0].length + 100));
    if (
      /(?:рассрочк|кредит|installment|monthly)(?:\s+от|\s+from)?\s*$/iu.test(beforePrice) ||
      /^[\s()[\]·,:\-–—]*(?:\/\s*мес|в\s+месяц|ежемесячно|per\s+month|monthly|по\s+рассрочке)/iu.test(afterPrice)
    ) {
      continue;
    }

    // Choose the anchor that best combines closeness with looking like a real
    // product title. Pure proximity picks up card furniture such as a
    // "no reviews" link that happens to sit next to the price.
    let best: Anchor | null = null;
    let bestCost = Infinity;

    while (
      firstNearbyAnchor < anchors.length &&
      anchors[firstNearbyAnchor].end < m.index - WINDOW
    ) {
      firstNearbyAnchor++;
    }

    for (let i = firstNearbyAnchor; i < anchors.length; i++) {
      const a = anchors[i];
      if (a.index > m.index + WINDOW) break;
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
    const tail = priceSurface.slice(Math.max(0, m.index - 260), m.index);
    const oldM = [...tail.matchAll(priceRegex())].pop();
    const oldPrice = oldM ? parsePrice(oldM[1]) : null;

    out.push({
      title: best.text,
      price,
      oldPrice: oldPrice && oldPrice > price ? oldPrice : null,
      url: best.href,
      domain,
      via: 'proximity',
      inStock: availabilityOf(
        cleaned.slice(
          Math.max(0, Math.min(best.index, m.index) - 100),
          Math.min(cleaned.length, Math.max(best.end, m.index + m[0].length) + 160)
        )
      ),
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
      rows = dedupe(
        run().filter(
          (l) =>
            Number.isFinite(l.price) &&
            l.price > 0 &&
            /[\p{L}\p{N}]/u.test(l.title) &&
            l.title.length >= 3 &&
            l.title.length <= MAX_TITLE_LENGTH
        )
      ).slice(0, MAX_LISTINGS);
    } catch {
      continue;
    }
    if (rows.length >= MIN_CONFIDENT_ROWS) return { listings: rows, strategy: name };
    if (rows.length > fallback.listings.length) fallback = { listings: rows, strategy: name };
  }

  return fallback;
}

export const __testing = {
  parsePrice,
  stripTags,
  isPlausibleTitle,
  fromProximity,
  absolutize,
  availabilityOf,
  maxListings: MAX_LISTINGS,
  maxAnchors: MAX_ANCHORS,
};
