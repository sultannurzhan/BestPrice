import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
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

const MAX_DISK_ENTRIES = 300;
const MAX_DISK_BYTES = 32 * 1024 * 1024;
const MAX_DISK_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DISK_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_WRITES = 20;
const CACHE_FILE = /^[a-f0-9]{20}\.json$/;
let writesSincePrune = 0;
let prunePromise: Promise<void> | null = null;

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
    const path = pathFor(key);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DISK_FILE_BYTES) return null;
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Envelope<T>;
    const now = Date.now();
    if (
      !Number.isFinite(parsed.savedAt) ||
      parsed.savedAt < 0 ||
      parsed.savedAt > now + 60_000
    ) {
      return null;
    }
    const ageMs = Math.max(0, now - parsed.savedAt);
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
  let tempPath: string | null = null;
  try {
    await mkdir(DIR, { recursive: true });
    const envelope: Envelope<T> = { savedAt, value };
    const serialised = JSON.stringify(envelope);
    if (Buffer.byteLength(serialised, 'utf8') > MAX_DISK_FILE_BYTES) return;
    const finalPath = pathFor(key);
    tempPath = join(DIR, `.${randomUUID()}.tmp`);
    await writeFile(tempPath, serialised, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(tempPath, finalPath);
    tempPath = null;

    writesSincePrune++;
    if (writesSincePrune >= PRUNE_EVERY_WRITES) {
      writesSincePrune = 0;
      prunePromise ??= pruneDir(DIR).finally(() => {
        prunePromise = null;
      });
      await prunePromise;
    }
  } catch {
    // A cache that cannot write is not a reason to fail the request.
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
  }
}

async function pruneDir(dir: string): Promise<void> {
  try {
    const entries = (await readdir(dir, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && CACHE_FILE.test(entry.name)
    );
    const files: Array<{ path: string; mtimeMs: number; size: number }> = [];

    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50);
      const inspected = await Promise.all(
        batch.map(async (entry) => {
          const path = join(dir, entry.name);
          const info = await stat(path).catch(() => null);
          return info?.isFile()
            ? { path, mtimeMs: info.mtimeMs, size: info.size }
            : null;
        })
      );
      files.push(...inspected.filter((file): file is NonNullable<typeof file> => file !== null));
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    let kept = 0;
    let keptBytes = 0;
    for (const file of files) {
      const fits =
        now - file.mtimeMs <= MAX_DISK_AGE_MS &&
        kept < MAX_DISK_ENTRIES &&
        keptBytes + file.size <= MAX_DISK_BYTES;
      if (fits) {
        kept++;
        keptBytes += file.size;
      } else {
        await unlink(file.path).catch(() => {});
      }
    }
  } catch {
    // Pruning is maintenance; cache reads and searches must keep working.
  }
}

export const __testing = {
  pathFor,
  DIR,
  pruneDir,
  maxDiskEntries: MAX_DISK_ENTRIES,
  maxDiskBytes: MAX_DISK_BYTES,
};
