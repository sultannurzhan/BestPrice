import { isIP } from 'node:net';

export const MAX_REQUEST_BODY_BYTES = 4 * 1024;
export const MAX_REQUEST_BODY_TIME_MS = 5_000;
export const RATE_LIMIT = 8;
export const RATE_WINDOW_MS = 60_000;
export const MAX_CONCURRENT_SEARCHES = 12;
const MAX_RATE_KEYS = 2_000;

interface RateEntry {
  count: number;
  resetAt: number;
}

const rates = new Map<string, RateEntry>();
let activeSearches = 0;

export class RequestProblem extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'RequestProblem';
  }
}

function clientKey(request: Request): string {
  const trustedHeaders: string[] = [];
  if (process.env.VERCEL) trustedHeaders.push('x-vercel-forwarded-for');
  if (process.env.CF_PAGES || process.env.CLOUDFLARE) {
    trustedHeaders.push('cf-connecting-ip');
  }
  // Self-hosters may opt in only when a trusted reverse proxy strips and
  // rewrites these headers. Direct clients can forge them otherwise.
  if (process.env.BESTPRICE_TRUST_PROXY === '1') {
    trustedHeaders.push('x-real-ip', 'x-forwarded-for');
  }

  for (const header of trustedHeaders) {
    const candidate = request.headers.get(header)?.split(',')[0]?.trim();
    if (candidate && isIP(candidate)) return candidate;
  }
  return 'anonymous';
}

function sweepRates(now: number): void {
  for (const [key, entry] of rates) {
    if (entry.resetAt <= now) rates.delete(key);
  }
  while (rates.size >= MAX_RATE_KEYS) {
    const oldest = rates.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rates.delete(oldest);
  }
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/** Best-effort process-local protection; production edge limits can layer on top. */
export function checkSearchRateLimit(
  request: Request,
  now = Date.now()
): RateDecision {
  const key = clientKey(request);
  let entry = rates.get(key);
  if (!entry || entry.resetAt <= now) {
    if (rates.size >= MAX_RATE_KEYS) sweepRates(now);
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rates.set(key, entry);
  }

  if (entry.count >= RATE_LIMIT) {
    return {
      allowed: false,
      limit: RATE_LIMIT,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  entry.count++;
  // Refresh insertion order so a hot key is not the first capacity eviction.
  rates.delete(key);
  rates.set(key, entry);
  return {
    allowed: true,
    limit: RATE_LIMIT,
    remaining: RATE_LIMIT - entry.count,
    retryAfterSeconds: 0,
  };
}

export function acquireSearchSlot(): (() => void) | null {
  if (activeSearches >= MAX_CONCURRENT_SEARCHES) return null;
  activeSearches++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSearches = Math.max(0, activeSearches - 1);
  };
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  let same = false;
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    const host = request.headers.get('host')?.trim().toLowerCase();
    same =
      originUrl.origin === requestUrl.origin ||
      // Next.js may construct request.url with its internal `localhost` origin
      // even for a browser connected through another Host. Browsers cannot set
      // Host, so matching the actual HTTP Host preserves CSRF protection while
      // allowing loopback and reverse-proxy deployments.
      (Boolean(host) &&
        ['http:', 'https:'].includes(originUrl.protocol) &&
        originUrl.host.toLowerCase() === host);
  } catch {
    /* rejected below */
  }
  if (!same) throw new RequestProblem('Cross-origin searches are not allowed', 403);
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim();
  if (!contentType || !/^application\/(?:json|[\w.+-]+\+json)$/i.test(contentType)) {
    throw new RequestProblem('Content-Type must be application/json', 415);
  }

  const declaredRaw = request.headers.get('content-length');
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isInteger(declared) || declared < 0) {
      throw new RequestProblem('Invalid Content-Length', 400);
    }
    if (declared > MAX_REQUEST_BODY_BYTES) {
      throw new RequestProblem('Request body is too large', 413);
    }
  }

  if (!request.body) throw new RequestProblem('Malformed JSON', 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  const timeout = AbortSignal.timeout(MAX_REQUEST_BODY_TIME_MS);
  const readSignal = AbortSignal.any([request.signal, timeout]);

  try {
    for (;;) {
      const { done, value } = await readChunk(reader, readSignal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestProblem('Request body is too large', 413);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof RequestProblem) throw err;
    throw new RequestProblem(
      timeout.aborted ? 'Request body timed out' : 'Request body was cancelled',
      408
    );
  }
  chunks.push(decoder.decode());

  try {
    return JSON.parse(chunks.join('')) as unknown;
  } catch {
    throw new RequestProblem('Malformed JSON', 400);
  }
}

export const __testing = {
  reset: () => {
    rates.clear();
    activeSearches = 0;
  },
  active: () => activeSearches,
  rateKeys: () => rates.size,
};
