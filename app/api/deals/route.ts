import { pooled } from '@/lib/fetcher';
import { enrichQuery, writeVerdict } from '@/lib/llm';
import {
  findStores,
  groupByDomain,
  OverpassUnavailableError,
} from '@/lib/overpass';
import { parseQuery } from '@/lib/product';
import { rankDeals } from '@/lib/rank';
import { selectDomains, validateSearchRequest } from '@/lib/searchRequest';
import {
  acquireSearchSlot,
  assertSameOrigin,
  checkSearchRateLimit,
  readJsonBody,
  RequestProblem,
} from '@/lib/searchGuard';
import { IGNORED_DOMAINS, scrapeDomain } from '@/lib/scrape';
import { adapterFor, labelFor } from '@/lib/scrape/adapters';
import type {
  AgentEvent,
  CoverageGap,
  DomainResult,
  ScrapeFailure,
} from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Scraping a dozen shops takes time. 60s is the ceiling on Vercel's Hobby plan;
 * raise it to 300 on Pro, or ignore it entirely when self-hosting (Railway,
 * Docker, a VPS), where `next start` has no such limit.
 */
export const maxDuration = 60;

/** How many retailer sites we hit at once, across all hosts. */
const SCRAPE_CONCURRENCY = 6;
/** Leave enough headroom to emit a useful error before the platform's 60s kill. */
const SEARCH_BUDGET_MS = 52_000;
const MAX_COVERAGE_GAPS = 50;

/**
 * Reasons a retailer produced nothing, phrased for a shopper rather than a
 * developer. Only genuine coverage gaps appear in the UI; "nothing found" is a
 * real answer, not a gap.
 */
const GAP_REASON: Partial<Record<ScrapeFailure, string>> = {
  blocked: 'blocks automated price checks',
  'js-rendered': 'shows prices only after running JavaScript',
  'no-search-endpoint': 'has no readable website search',
  timeout: 'did not respond in time',
  unreachable: 'was unreachable',
  'unsafe-url': 'has an invalid or non-public website address',
  'response-too-large': 'returned a page too large to check safely',
};

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function toGaps(results: DomainResult[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const r of results) {
    if (!r.failure) continue;
    const reason = GAP_REASON[r.failure];
    if (!reason) continue;
    gaps.push({
      label: labelFor(r.domain),
      reason: adapterFor(r.domain)?.note ?? reason,
    });
  }
  return gaps;
}

function skippedGaps(domains: string[]): CoverageGap[] {
  const visible = domains.slice(0, MAX_COVERAGE_GAPS).map((domain) => ({
    label: labelFor(domain),
    reason: 'skipped to keep the search within its time budget',
  }));
  if (domains.length > visible.length) {
    visible.push({
      label: `${domains.length - visible.length} more mapped retailers`,
      reason: 'not listed individually to keep this response compact',
    });
  }
  return visible;
}

function withRequestId(requestId: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('X-Request-ID', requestId);
  return result;
}

function problem(
  message: string,
  status: number,
  requestId: string,
  headers?: HeadersInit
): Response {
  return Response.json(
    { error: message },
    { status, headers: withRequestId(requestId, headers) }
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  let body: unknown;
  try {
    assertSameOrigin(request);
    body = await readJsonBody(request);
  } catch (err) {
    if (err instanceof RequestProblem) return problem(err.message, err.status, requestId);
    return problem('Malformed JSON', 400, requestId);
  }

  const validated = validateSearchRequest(body);
  if (typeof validated === 'string') return problem(validated, 400, requestId);

  // Only a well-formed same-origin search consumes quota. Invalid or hostile
  // requests cannot exhaust the allowance of a shared proxy address.
  const rate = checkSearchRateLimit(request);
  if (!rate.allowed) {
    return problem('Too many searches. Please wait a moment and try again.', 429, requestId, {
      'Retry-After': String(rate.retryAfterSeconds),
      'RateLimit-Limit': String(rate.limit),
      'RateLimit-Remaining': '0',
    });
  }

  const { lat, lon, radiusM, item } = validated;
  const releaseSlot = acquireSearchSlot();
  if (!releaseSlot) {
    return problem('All search workers are busy. Please try again shortly.', 503, requestId, {
      'Retry-After': '5',
    });
  }
  const encoder = new TextEncoder();
  const started = Date.now();
  const consumerController = new AbortController();
  const deadlineSignal = AbortSignal.timeout(SEARCH_BUDGET_MS);
  const workSignal = AbortSignal.any([
    request.signal,
    consumerController.signal,
    deadlineSignal,
  ]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
          consumerController.abort(
            new DOMException('Response stream is no longer writable', 'AbortError')
          );
        }
      };

      // If the user navigates away, stop doing work on their behalf.
      request.signal.addEventListener('abort', () => {
        closed = true;
      });

      try {
        // ---- 1. Understand the request ---------------------------------
        send({ type: 'status', message: 'Understanding what you are looking for…' });
        const query = await enrichQuery(parseQuery(item), workSignal);
        workSignal.throwIfAborted();
        send({ type: 'query', query });

        // ---- 2. Find shops around the user ------------------------------
        send({
          type: 'status',
          message: `Finding tech shops within ${(radiusM / 1000).toFixed(1)} km…`,
        });

        const { stores, staleAgeMs } = await findStores(
          { lat, lon },
          radiusM,
          workSignal
        );
        workSignal.throwIfAborted();
        if (staleAgeMs !== null) {
          send({
            type: 'status',
            message: `OpenStreetMap is unreachable — using a store list cached ${formatAge(
              staleAgeMs
            )} ago.`,
          });
        }
        const byDomain = groupByDomain(stores);

        // Drop domains that are not retail tech shops (telecom operators etc).
        for (const domain of [...byDomain.keys()]) {
          if (IGNORED_DOMAINS.has(domain)) byDomain.delete(domain);
        }

        // Order matters: retailers we know how to read go first so useful
        // results stream in early, then the chains with the most branches,
        // then whatever is closest.
        const ranked = [...byDomain.entries()]
          .sort((a, b) => {
            const known = (d: string) => (adapterFor(d) ? 0 : 1);
            const knownDelta = known(a[0]) - known(b[0]);
            if (knownDelta !== 0) return knownDelta;

            const branchDelta = b[1].length - a[1].length;
            if (branchDelta !== 0) return branchDelta;

            return a[1][0].distanceM - b[1][0].distanceM;
          })
          .map(([domain]) => domain);

        // Keep known retailers plus a bounded unknown tail. Every domain left
        // out by either cap is retained as an explicit coverage gap.
        const { domains, skipped } = selectDomains(ranked);

        send({ type: 'stores', count: stores.length, domains: domains.length });

        if (domains.length === 0) {
          send({
            type: 'results',
            deals: [],
            summary: {
              storesFound: stores.length,
              domainsQueried: 0,
              domainsSucceeded: 0,
              listingsSeen: 0,
              listingsMatched: 0,
              dealsFound: 0,
              gaps: [],
              verdict:
                stores.length > 0
                  ? 'Shops were found nearby, but none of them list a website in OpenStreetMap, so there are no prices to compare.'
                  : 'No tech shops mapped in this radius. Try widening it.',
              tookMs: Date.now() - started,
            },
          });
          controller.close();
          return;
        }

        // ---- 3. Search every retailer in parallel ------------------------
        send({
          type: 'status',
          message: `Checking prices at ${domains.length} retailer${
            domains.length === 1 ? '' : 's'
          }…`,
        });

        const completed: DomainResult[] = [];
        let results: DomainResult[];
        try {
          results = await pooled(
            domains,
            SCRAPE_CONCURRENCY,
            async (domain) => {
              send({ type: 'domain', domain, state: 'start' });
              const result = await scrapeDomain(domain, query, workSignal);
              completed.push(result);
              send({
                type: 'domain',
                domain,
                state: 'done',
                found: result.listings.length,
                failure: result.failure,
                tookMs: result.tookMs,
              });
              return result;
            },
            { signal: workSignal }
          );
        } catch (err) {
          if (!deadlineSignal.aborted || completed.length === 0) throw err;
          results = completed;
          send({
            type: 'status',
            message: 'Time limit reached — ranking the retailers that completed…',
          });
        }

        // ---- 4. Match, cost and rank -------------------------------------
        send({ type: 'status', message: 'Filtering accessories and ranking by true cost…' });

        const { deals, listingsSeen, listingsMatched } = rankDeals({
          results,
          storesByDomain: byDomain,
          query,
        });

        const verdict = await writeVerdict(deals, query, workSignal);
        if (!deadlineSignal.aborted) workSignal.throwIfAborted();

        const completedDomains = new Set(results.map((result) => result.domain));
        const timedOutDomains = deadlineSignal.aborted
          ? domains.filter((domain) => !completedDomains.has(domain))
          : [];

        // A started retailer must always receive a terminal event so progress
        // chips never remain stuck on an ellipsis after the global deadline.
        for (const domain of timedOutDomains) {
          send({
            type: 'domain',
            domain,
            state: 'done',
            found: 0,
            failure: 'timeout',
            tookMs: Date.now() - started,
          });
        }

        send({
          type: 'results',
          deals,
          summary: {
            storesFound: stores.length,
            domainsQueried: domains.length,
            domainsSucceeded: results.filter((r) => r.listings.length > 0).length,
            listingsSeen,
            listingsMatched,
            dealsFound: deals.length,
            gaps: [
              ...toGaps(results),
              ...timedOutDomains.map((domain) => ({
                label: labelFor(domain),
                reason: 'did not finish before the search time limit',
              })),
              ...skippedGaps(skipped),
            ],
            verdict,
            tookMs: Date.now() - started,
          },
        });
      } catch (err) {
        if (request.signal.aborted || consumerController.signal.aborted) return;
        const unexpected =
          !deadlineSignal.aborted && !(err instanceof OverpassUnavailableError);
        if (unexpected) {
          console.error('BestPrice search failed', {
            requestId,
            name: err instanceof Error ? err.name : 'UnknownError',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        send({
          type: 'error',
          message:
            deadlineSignal.aborted
              ? 'The search reached its time limit. Try again — cached shop data will make the next attempt faster.'
              : err instanceof OverpassUnavailableError
              ? 'OpenStreetMap’s public servers are overloaded right now and no cached store list exists for this area. Try again in a minute.'
              : `The search failed unexpectedly. Please try again (reference ${requestId}).`,
        });
      } finally {
        releaseSlot();
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      consumerController.abort(
        new DOMException('Response consumer cancelled', 'AbortError')
      );
    },
  });

  return new Response(stream, {
    headers: withRequestId(requestId, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering so events arrive as they happen.
      'X-Accel-Buffering': 'no',
      'RateLimit-Limit': String(rate.limit),
      'RateLimit-Remaining': String(rate.remaining),
    }),
  });
}
