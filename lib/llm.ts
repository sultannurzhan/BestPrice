import { PRODUCT_CATEGORIES, type Deal, type ProductQuery } from './types';
import { formatKzt } from './rank';

/**
 * Optional OpenRouter integration.
 *
 * The agent is deterministic by design — rules parse the query, arithmetic ranks
 * the deals. The LLM is used only where language is genuinely hard:
 *
 *   1. understanding messy free-text ("cheapest 15 pro max 256 in white");
 *   2. writing the one-line verdict above the results.
 *
 * Both paths fall back silently to the rule-based versions, so the app works
 * fully with no API key. Nothing here can change a price or a ranking.
 */

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export function isLlmEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

interface ChatOptions {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function chat({
  system,
  user,
  maxTokens = 300,
  timeoutMs = 12_000,
  signal,
}: ChatOptions): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // OpenRouter uses these for attribution; harmless if unset.
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'http://localhost:3000',
        'X-Title': 'BestPrice',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Pull the first JSON object out of a model response that may be fenced. */
function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const PARSE_SYSTEM = `You normalise shopping queries for a Kazakhstan electronics price comparison tool.
Return ONLY a JSON object with these keys:
  "searchTerm": string  - a short query to type into a shop's search box (brand + model, no storage qualifiers)
  "brand": string|null  - lowercase manufacturer
  "model": string|null  - lowercase model name
  "storageGb": number|null
  "ramGb": number|null
  "category": one of "smartphone","laptop","tablet","tv","headphones","smartwatch","monitor","console","camera","component","other"
Do not invent details the user did not give.`;

/**
 * Refine a rule-parsed query with the LLM. Anything the model returns is
 * validated before use, and any failure keeps the rule-based result.
 */
export async function enrichQuery(
  base: ProductQuery,
  signal?: AbortSignal
): Promise<ProductQuery> {
  if (!isLlmEnabled()) return base;

  const raw = await chat({
    system: PARSE_SYSTEM,
    user: base.raw,
    maxTokens: 220,
    signal,
  });
  if (!raw) return base;

  const parsed = extractJson(raw) as Record<string, unknown> | null;
  if (!parsed) return base;

  return mergeEnrichment(base, parsed);
}

function mergeEnrichment(
  base: ProductQuery,
  parsed: Record<string, unknown>
): ProductQuery {

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
  const num = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max
      ? v
      : null;

  const proposedSearchTerm = str(parsed.searchTerm);
  const proposedSearchTokens = new Set(
    (proposedSearchTerm ?? '')
      .replace(/([\p{L}\p{N}])\+/gu, '$1 plus ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
  const searchTerm =
    proposedSearchTerm &&
    base.requiredTokens.every((token) =>
      proposedSearchTokens.has(token.replace(/\+/g, 'plus'))
    )
      ? proposedSearchTerm
      : base.searchTerm;
  const proposedCategory =
    typeof parsed.category === 'string' &&
    PRODUCT_CATEGORIES.includes(parsed.category as (typeof PRODUCT_CATEGORIES)[number])
      ? (parsed.category as ProductQuery['category'])
      : null;

  return {
    ...base,
    searchTerm,
    brand: base.brand ?? str(parsed.brand),
    model: base.model ?? str(parsed.model),
    storageGb: base.storageGb ?? num(parsed.storageGb, 16_384),
    ramGb: base.ramGb ?? num(parsed.ramGb, 512),
    // A known rule-derived category is an invariant, especially `other` for an
    // accessory query. Let the model fill only genuinely unknown categories.
    category: base.category ?? proposedCategory,
    // Deterministic constraints are invariants. Rule parsing already retains
    // every meaningful raw token, so model-authored constraints can only make
    // matching less reliable or smuggle conversational noise back in.
    requiredTokens: base.requiredTokens,
    via: 'llm',
  };
}

/** Deterministic verdict used when no API key is configured. */
function ruleVerdict(deals: Deal[]): string | null {
  const best = deals[0];
  if (!best) return null;
  const qualifyUnknownStock = (message: string) =>
    best.listing.inStock === null
      ? `${message} Branch stock is unverified.`
      : message;

  const cheapestSticker = deals.reduce((a, b) =>
    a.listing.price <= b.listing.price ? a : b
  );
  const cheapestTotal = deals.reduce((a, b) =>
    a.cost.total <= b.cost.total ? a : b
  );

  if (deals.length === 1) {
    const availability =
      best.listing.inStock === false
        ? ' It is marked out of stock online.'
        : '';
    return qualifyUnknownStock(`Only one nearby shop had a readable listing: ${best.store.name} at ${formatKzt(
      best.listing.price
    )}.${availability}`);
  }

  if (deals.every((deal) => deal.listing.inStock === false)) {
    return `Every readable matching listing is marked out of stock; ${best.store.name} has the lowest ranked unavailable option at ${formatKzt(
      best.listing.price
    )}.`;
  }

  if (best === cheapestTotal && best !== cheapestSticker) {
    const saved = cheapestSticker.cost.total - best.cost.total;
    return qualifyUnknownStock(`${best.store.name} wins on total cost: ${formatKzt(
      best.listing.price
    )} at ${best.cost.distanceKm} km beats the ${formatKzt(
      cheapestSticker.listing.price
    )} at ${cheapestSticker.store.name} once its ${cheapestSticker.cost.distanceKm} km distance is priced in (${formatKzt(
      saved
    )} better).`);
  }

  if (best === cheapestTotal) {
    const runnerUp = deals[1];
    const gap = runnerUp.cost.total - best.cost.total;
    return qualifyUnknownStock(`${best.store.name} is the best-value option at ${formatKzt(
      best.listing.price
    )} (${formatKzt(best.cost.total)} including travel), ${formatKzt(
      gap
    )} below the next ranked option.`);
  }

  const caveat =
    cheapestTotal.listing.inStock === false
      ? 'is marked out of stock'
      : cheapestTotal.match.confidence < best.match.confidence
        ? 'is a lower-confidence match'
        : 'has a weaker availability or match signal';
  return qualifyUnknownStock(`${best.store.name} ranks first as the stronger available match at ${formatKzt(
    best.listing.price
  )}; ${cheapestTotal.store.name} has the lower estimated total at ${formatKzt(
    cheapestTotal.cost.total
  )}, but ${caveat}.`);
}

const VERDICT_SYSTEM = `You write a single-sentence verdict for a price comparison tool in Kazakhstan.
Be concrete and factual: name the shop, the price, and the reason it wins.
Mention travel cost only if it changed the ranking. Prices are in tenge (₸).
Never call an out-of-stock listing available; clearly say when stock is unverified.
No greetings, no markdown, no more than 40 words. Never invent prices or shops.`;

function verdictIsGrounded(answer: string, deals: Deal[]): boolean {
  const best = deals[0];
  if (!best || answer.length > 320 || answer.trim().split(/\s+/).length > 50) return false;
  const lower = answer.toLowerCase();
  if (!lower.includes(best.store.name.toLowerCase())) return false;

  const numberGroups = (text: string): string[] =>
    [...text.matchAll(/\d{1,3}(?:[\s\u00a0\u202f.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)].map((match) =>
      match[0].replace(/\D/g, '')
    );
  const allowedNumbers = new Set<string>();
  const allowedMoney = new Set<string>();
  const allow = (value: unknown) => {
    for (const group of numberGroups(String(value))) allowedNumbers.add(group);
  };
  const allowMoney = (value: number | undefined) => {
    if (value === undefined) return;
    const normalized = String(Math.round(value));
    allowedNumbers.add(normalized);
    allowedMoney.add(normalized);
  };
  for (const deal of deals.slice(0, 6)) {
    allow(deal.store.name);
    allow(deal.listing.title);
    for (const value of [deal.cost?.distanceKm, deal.cost?.minutesOneWay]) {
      if (value !== undefined) allow(value);
    }
    for (const value of [
      deal.listing.price,
      deal.cost?.price,
      deal.cost?.travel,
      deal.cost?.timeCost,
      deal.cost?.total,
      deal.cost ? deal.cost.travel + deal.cost.timeCost : undefined,
    ]) {
      allowMoney(value);
    }
  }
  // A concise verdict may state the exact gap between ranked total costs.
  for (let i = 0; i < Math.min(6, deals.length); i++) {
    for (let j = i + 1; j < Math.min(6, deals.length); j++) {
      if (deals[i].cost && deals[j].cost) {
        allowMoney(Math.abs(deals[i].cost.total - deals[j].cost.total));
      }
    }
  }

  const answerNumbers = numberGroups(answer);
  if (!answerNumbers.includes(String(Math.round(best.listing.price)))) return false;
  if (answerNumbers.some((number) => !allowedNumbers.has(number))) return false;
  const moneyClaims = [
    ...answer.matchAll(
      /(\d{1,3}(?:[\s\u00a0\u202f.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(?:₸|KZT|тенге)/giu
    ),
  ].map((match) => match[1].replace(/\D/g, ''));
  if (moneyClaims.some((number) => !allowedMoney.has(number))) return false;
  if (best.listing.inStock === false && !/(?:out of stock|unavailable)/i.test(answer)) {
    return false;
  }
  if (
    best.listing.inStock === null &&
    !/(?:unverified|unknown|confirm|verify)/i.test(answer)
  ) {
    return false;
  }
  return true;
}

export async function writeVerdict(
  deals: Deal[],
  query: ProductQuery,
  signal?: AbortSignal
): Promise<string | null> {
  const fallback = ruleVerdict(deals);
  if (!isLlmEnabled() || deals.length === 0) return fallback;

  const table = deals
    .slice(0, 6)
    .map(
      (d, i) =>
        `${i + 1}. ${d.store.name} | ${d.listing.title.slice(0, 70)} | price ${
          d.listing.price
        }₸ | ${d.cost.distanceKm}km | travel+time ${d.cost.travel + d.cost.timeCost}₸ | total ${
          d.cost.total
        }₸ | stock ${
          d.listing.inStock === true
            ? 'listed in stock'
            : d.listing.inStock === false
              ? 'listed out of stock'
              : 'unverified'
        }`
    )
    .join('\n');

  const answer = await chat({
    system: VERDICT_SYSTEM,
    user: `Shopper wants: ${query.raw}\n\nRanked options:\n${table}`,
    maxTokens: 120,
    signal,
  });

  return answer && verdictIsGrounded(answer, deals) ? answer : fallback;
}

export const __testing = { ruleVerdict, mergeEnrichment, verdictIsGrounded };
