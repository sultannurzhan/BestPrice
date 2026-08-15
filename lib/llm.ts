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
}

async function chat({
  system,
  user,
  maxTokens = 300,
  timeoutMs = 12_000,
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
      signal: AbortSignal.timeout(timeoutMs),
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
  "requiredTokens": string[] - lowercase tokens that MUST appear in a matching product title
Keep requiredTokens short (2-4 items) and never include storage numbers there.
Do not invent details the user did not give.`;

/**
 * Refine a rule-parsed query with the LLM. Anything the model returns is
 * validated before use, and any failure keeps the rule-based result.
 */
export async function enrichQuery(base: ProductQuery): Promise<ProductQuery> {
  if (!isLlmEnabled()) return base;

  const raw = await chat({
    system: PARSE_SYSTEM,
    user: base.raw,
    maxTokens: 220,
  });
  if (!raw) return base;

  const parsed = extractJson(raw) as Record<string, unknown> | null;
  if (!parsed) return base;

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

  const tokens = Array.isArray(parsed.requiredTokens)
    ? parsed.requiredTokens
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 6)
    : [];

  const searchTerm = str(parsed.searchTerm);
  const category =
    typeof parsed.category === 'string' &&
    PRODUCT_CATEGORIES.includes(parsed.category as (typeof PRODUCT_CATEGORIES)[number])
      ? (parsed.category as ProductQuery['category'])
      : base.category;

  return {
    ...base,
    searchTerm: searchTerm ?? base.searchTerm,
    brand: str(parsed.brand) ?? base.brand,
    model: str(parsed.model) ?? base.model,
    storageGb: num(parsed.storageGb) ?? base.storageGb,
    ramGb: num(parsed.ramGb) ?? base.ramGb,
    category,
    // Trust the model only if it gave us something usable.
    requiredTokens: tokens.length >= 1 ? tokens : base.requiredTokens,
    via: 'llm',
  };
}

/** Deterministic verdict used when no API key is configured. */
function ruleVerdict(deals: Deal[]): string | null {
  const best = deals[0];
  if (!best) return null;

  const cheapestSticker = deals.reduce((a, b) =>
    a.listing.price <= b.listing.price ? a : b
  );

  if (best !== cheapestSticker) {
    const saved = cheapestSticker.cost.total - best.cost.total;
    return `${best.store.name} wins on total cost: ${formatKzt(
      best.listing.price
    )} at ${best.cost.distanceKm} km beats the ${formatKzt(
      cheapestSticker.listing.price
    )} at ${cheapestSticker.store.name} once the ${cheapestSticker.cost.distanceKm} km round trip is priced in (${formatKzt(
      saved
    )} better).`;
  }

  if (deals.length === 1) {
    return `Only one nearby shop had a readable listing: ${best.store.name} at ${formatKzt(
      best.listing.price
    )}.`;
  }

  const runnerUp = deals[1];
  const gap = runnerUp.cost.total - best.cost.total;
  return `${best.store.name} is both cheapest and closest at ${formatKzt(
    best.listing.price
  )} — ${formatKzt(gap)} better than the next option once travel is counted.`;
}

const VERDICT_SYSTEM = `You write a single-sentence verdict for a price comparison tool in Kazakhstan.
Be concrete and factual: name the shop, the price, and the reason it wins.
Mention travel cost only if it changed the ranking. Prices are in tenge (₸).
No greetings, no markdown, no more than 40 words. Never invent prices or shops.`;

export async function writeVerdict(
  deals: Deal[],
  query: ProductQuery
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
        }₸`
    )
    .join('\n');

  const answer = await chat({
    system: VERDICT_SYSTEM,
    user: `Shopper wants: ${query.raw}\n\nRanked options:\n${table}`,
    maxTokens: 120,
  });

  return answer ?? fallback;
}
