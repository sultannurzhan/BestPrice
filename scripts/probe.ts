/**
 * Diagnostic tool: see exactly what the agent reads from a retailer and why
 * each listing was kept or thrown away.
 *
 *   npm run probe -- sulpak.kz "iphone 15"
 *   npm run probe -- --all "macbook air"
 *
 * Retailers redesign their sites; this is how you find out which adapter has
 * gone stale without guessing.
 */

import { matchListing, parseQuery } from '../lib/product';
import { scrapeDomain } from '../lib/scrape';
import { ADAPTERS } from '../lib/scrape/adapters';

async function main(): Promise<void> {
const args = process.argv.slice(2);
const all = args.includes('--all');
const positional = args.filter((a) => !a.startsWith('--'));

const domains = all
  ? Object.keys(ADAPTERS).filter((d) => !ADAPTERS[d].knownBlocked)
  : [positional[0] ?? 'sulpak.kz'];
const term = (all ? positional[0] : positional[1]) ?? 'iphone 15';

const query = parseQuery(term);

console.log(`\nquery: ${JSON.stringify(query, null, 2)}\n`);

for (const domain of domains) {
  console.log(`\n${'='.repeat(70)}\n${domain}\n${'='.repeat(70)}`);

  const started = Date.now();
  const result = await scrapeDomain(domain, query);

  console.log(
    `searchUrl: ${result.searchUrl ?? '(none)'}\n` +
      `listings: ${result.listings.length}  failure: ${result.failure ?? '-'}  ${
        Date.now() - started
      }ms\n`
  );

  const kept: string[] = [];
  const rejected = new Map<string, number>();

  for (const listing of result.listings) {
    const match = matchListing(listing, query);
    if (match.rejected) {
      const reason = match.rejectReason ?? 'unknown';
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
    } else {
      kept.push(
        `  ✓ ${String(listing.price).padStart(9)}₸  conf ${match.confidence.toFixed(
          2
        )}  [${listing.via}]  ${listing.title.slice(0, 78)}`
      );
    }
  }

  if (kept.length) {
    console.log(`KEPT (${kept.length}):`);
    console.log(kept.slice(0, 15).join('\n'));
    if (kept.length > 15) console.log(`  … and ${kept.length - 15} more`);
  } else {
    console.log('KEPT: none');
  }

  if (rejected.size) {
    console.log(`\nREJECTED (${result.listings.length - kept.length}):`);
    for (const [reason, count] of [...rejected.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)} × ${reason}`);
    }
  }

  // Show a few rejected titles so over-filtering is visible, not invisible.
  const samples = result.listings
    .filter((l) => matchListing(l, query).rejected)
    .slice(0, 6);
  if (samples.length) {
    console.log('\n  sample rejected titles:');
    for (const s of samples) {
      const m = matchListing(s, query);
      console.log(`    - [${m.rejectReason}] ${s.price}₸ ${s.title.slice(0, 66)}`);
    }
  }
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
