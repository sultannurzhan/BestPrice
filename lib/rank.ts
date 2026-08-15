import { drivingKm, drivingMinutes } from './geo';
import { matchListing } from './product';
import type {
  CostBreakdown,
  Deal,
  DomainResult,
  Listing,
  ProductQuery,
  Store,
} from './types';

/**
 * Ranking: the cheapest sticker price is frequently not the best deal.
 *
 * A phone 40 km away that is 3 000 ₸ cheaper costs more once you have paid for
 * the fuel and given up an hour of your evening. So we rank on the total cost of
 * actually owning the thing, then apply confidence and stock adjustments.
 */

/**
 * Cost of driving one kilometre in Kazakhstan, all-in.
 * AI-95 is roughly 250 ₸/L; a typical car burns ~9 L/100 km, giving ~23 ₸/km of
 * fuel. Adding tyres, servicing and depreciation lands near 35 ₸/km.
 */
export const COST_PER_KM = 35;

/**
 * What an hour of the shopper's time is worth. The national average wage is
 * around 400 000 ₸/month (~2 300 ₸/hour); we deliberately use a lower figure so
 * the model does not over-penalise distance for people happy to travel.
 */
export const COST_PER_HOUR = 1_200;

/** Below this match confidence a listing is too doubtful to show at all. */
export const MIN_CONFIDENCE = 0.45;

export function computeCost(price: number, distanceM: number): CostBreakdown {
  const distanceKm = drivingKm(distanceM);
  const minutesOneWay = drivingMinutes(distanceM);

  // Round trip: you have to get home too.
  const travel = Math.round(distanceKm * 2 * COST_PER_KM);
  const timeCost = Math.round(((minutesOneWay * 2) / 60) * COST_PER_HOUR);

  return {
    price,
    travel,
    timeCost,
    total: price + travel + timeCost,
    distanceKm: Math.round(distanceKm * 10) / 10,
    minutesOneWay: Math.round(minutesOneWay),
  };
}

/**
 * Pick the single best listing per domain.
 *
 * Retailers list the same product many times (colours, bundles, sellers). We
 * want the cheapest *credible* one, so we weigh price against match confidence
 * rather than blindly taking the minimum.
 */
function bestListingForDomain(
  listings: Listing[],
  query: ProductQuery
): { listing: Listing; confidence: number } | null {
  const matched: Array<{ listing: Listing; confidence: number }> = [];

  for (const listing of listings) {
    const match = matchListing(listing, query);
    if (match.rejected || match.confidence < MIN_CONFIDENCE) continue;

    matched.push({ listing, confidence: match.confidence });
  }

  // Never discard a purchasable listing in favour of a cheaper row the same
  // retailer explicitly marks out of stock. Keep out-of-stock rows only when
  // that shop has no credible alternative at all.
  const pool = matched.some(({ listing }) => listing.inStock !== false)
    ? matched.filter(({ listing }) => listing.inStock !== false)
    : matched;
  let best: { listing: Listing; confidence: number } | null = null;

  for (const candidate of pool) {
    if (
      !best ||
      // Prefer clearly better matches; among comparable matches prefer cheaper.
      candidate.confidence > best.confidence + 0.15 ||
      (Math.abs(candidate.confidence - best.confidence) <= 0.15 &&
        candidate.listing.price < best.listing.price)
    ) {
      best = candidate;
    }
  }

  return best;
}

function buildReasons(
  deal: Omit<Deal, 'reasons' | 'score'>,
  cheapestSticker: number,
  cheapestTotal: number
): string[] {
  const reasons: string[] = [];
  const { listing, cost, store, alsoAt, match } = deal;

  if (listing.price === cheapestSticker) {
    reasons.push('Lowest sticker price found');
  }
  if (cost.total === cheapestTotal && listing.price !== cheapestSticker) {
    reasons.push(
      `Cheaper overall once travel is counted (+${formatKzt(
        cost.travel + cost.timeCost
      )} to get there and back)`
    );
  }
  if (listing.oldPrice && listing.oldPrice > listing.price) {
    const pct = Math.round((1 - listing.price / listing.oldPrice) * 100);
    if (pct >= 3) reasons.push(`Discounted ${pct}% from ${formatKzt(listing.oldPrice)}`);
  }
  if (cost.distanceKm <= 2) {
    reasons.push('Walking distance');
  }
  if (alsoAt.length > 0) {
    reasons.push(
      `Same price at ${alsoAt.length + 1} ${store.name} branches; nearest shown`
    );
  }
  if (match.confidence < 0.7) {
    reasons.push('Listing title is an approximate match — verify before travelling');
  }
  if (listing.inStock === false) {
    reasons.push('Marked out of stock online');
  }

  return reasons;
}

export function formatKzt(n: number): string {
  return `${Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ')} ₸`;
}

export interface RankInput {
  results: DomainResult[];
  storesByDomain: Map<string, Store[]>;
  query: ProductQuery;
}

export interface RankOutput {
  deals: Deal[];
  listingsSeen: number;
  /** Individual listings that survived filtering, across all shops. */
  listingsMatched: number;
}

export function rankDeals({ results, storesByDomain, query }: RankInput): RankOutput {
  let listingsSeen = 0;
  let listingsMatched = 0;
  const candidates: Array<Omit<Deal, 'reasons' | 'score'>> = [];

  for (const result of results) {
    listingsSeen += result.listings.length;
    listingsMatched += result.listings.filter((l) => {
      const m = matchListing(l, query);
      return !m.rejected && m.confidence >= MIN_CONFIDENCE;
    }).length;

    const branches = storesByDomain.get(result.domain);
    if (!branches || branches.length === 0) continue;

    const best = bestListingForDomain(result.listings, query);
    if (!best) continue;

    // Branches are pre-sorted nearest-first by groupByDomain.
    const [nearest, ...others] = branches;

    candidates.push({
      listing: best.listing,
      store: nearest,
      alsoAt: others,
      match: { confidence: best.confidence, rejected: false, rejectReason: null },
      cost: computeCost(best.listing.price, nearest.distanceM),
    });
  }

  if (candidates.length === 0) {
    return { deals: [], listingsSeen, listingsMatched };
  }

  const cheapestSticker = Math.min(...candidates.map((c) => c.listing.price));
  const cheapestTotal = Math.min(...candidates.map((c) => c.cost.total));

  const deals: Deal[] = candidates.map((c) => {
    // Doubtful matches get a soft penalty rather than exclusion, so a strong
    // price at a slightly fuzzy title still surfaces — just not at the top.
    const confidencePenalty = (1 - c.match.confidence) * 0.25;
    // A listing flagged out of stock is worth a wasted trip; push it down.
    const stockPenalty = c.listing.inStock === false ? 0.35 : 0;

    return {
      ...c,
      score: c.cost.total * (1 + confidencePenalty + stockPenalty),
      reasons: buildReasons(c, cheapestSticker, cheapestTotal),
    };
  });

  const hasPurchasableDeal = deals.some((deal) => deal.listing.inStock !== false);
  deals.sort((a, b) => {
    if (hasPurchasableDeal) {
      const availabilityDelta =
        Number(a.listing.inStock === false) - Number(b.listing.inStock === false);
      if (availabilityDelta !== 0) return availabilityDelta;
    }
    return a.score - b.score;
  });

  return { deals, listingsSeen, listingsMatched };
}
