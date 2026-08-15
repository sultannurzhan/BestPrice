import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Disk-backed cache for data that is expensive to fetch and changes slowly.
 *
 * This exists specifically for OpenStreetMap store lookups. The public Overpass
 * instances are frequently overloaded — during development every mirror returned
 * 504 at the same moment — and shop locations barely change from week to week.
 * Persisting them means an Overpass outage degrades the app to "slightly stale
 * store list" rather than "cannot search at all".
 *
 * Deliberately not used for prices: those must never be served stale from disk.
 */

/**
 * Where to keep the cache.
 *
 * On a normal server the project directory is fine and the cache survives
 * restarts. Serverless platforms (Vercel, Netlify, Lambda) mount the deployment
 * read-only and only allow writes to the OS temp directory, so we detect those
 * and use it. The cache is then per-instance and dies with it — searches stay
 * correct, they are just slower on a cold instance.
 */
const SERVERLESS = Boolean(
  process.env.VERCEL ??
    process.env.NETLIFY ??
    process.env.AWS_LAMBDA_FUNCTION_NAME ??
    process.env.FUNCTIONS_WORKER_RUNTIME
);

const DIR =
  process.env.BESTPRICE_CACHE_DIR ??
  (SERVERLESS ? join(tmpdir(), 'bestprice-cache') : join(process.cwd(), '.cache'));

interface Envelope<T> {
  savedAt: number;
  value: T;
}

function pathFor(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 20);
  return join(DIR, `${hash}.json`);
}

export async function diskGet<T>(
  key: string,
  maxAgeMs: number
): Promise<{ value: T; ageMs: number } | null> {
  try {
    const raw = await readFile(pathFor(key), 'utf8');
    const parsed = JSON.parse(raw) as Envelope<T>;
    const ageMs = Date.now() - parsed.savedAt;
    if (ageMs > maxAgeMs) return null;
    return { value: parsed.value, ageMs };
  } catch {
    return null;
  }
}

/**
 * Read a cached value regardless of age. Used as a last resort when the
 * upstream service is down — stale data beats no data for shop locations.
 */
export async function diskGetStale<T>(
  key: string
): Promise<{ value: T; ageMs: number } | null> {
  return diskGet<T>(key, Number.POSITIVE_INFINITY);
}

export async function diskSet<T>(
  key: string,
  value: T,
  savedAt: number = Date.now()
): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    const envelope: Envelope<T> = { savedAt, value };
    await writeFile(pathFor(key), JSON.stringify(envelope), 'utf8');
  } catch {
    // A cache that cannot write is not a reason to fail the request.
  }
}

export const __testing = { pathFor, DIR };
