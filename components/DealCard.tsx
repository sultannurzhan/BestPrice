'use client';

import { formatKzt } from '@/lib/rank';
import type { Deal } from '@/lib/types';

interface Props {
  deal: Deal;
  rank: number;
  /** Total cost of the top-ranked deal, for showing the delta. */
  bestTotal: number;
}

export function DealCard({ deal, rank, bestTotal }: Props) {
  const { listing, store, cost, alsoAt, reasons, match } = deal;
  const isBest = rank === 0;
  const delta = cost.total - bestTotal;
  const mapUrl = `https://www.openstreetmap.org/?mlat=${store.coords.lat}&mlon=${store.coords.lon}#map=18/${store.coords.lat}/${store.coords.lon}`;

  return (
    <li
      className="card fade-up p-4 sm:p-5"
      style={{
        borderColor: isBest ? 'var(--accent)' : 'var(--border)',
        boxShadow: isBest ? 'var(--shadow)' : 'none',
        animationDelay: `${Math.min(rank, 8) * 40}ms`,
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* shop + badge */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold">{store.name}</span>
            {isBest && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                {listing.inStock === false
                  ? 'Best unavailable listing'
                  : listing.inStock === true
                    ? 'Best overall'
                    : 'Best listed option'}
              </span>
            )}
            {listing.oldPrice && listing.oldPrice > listing.price && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}
              >
                −{Math.round((1 - listing.price / listing.oldPrice) * 100)}%
              </span>
            )}
          </div>

          {/* product title */}
          <p
            className="text-sm mb-2 leading-snug"
            style={{ color: 'var(--muted)' }}
            title={listing.title}
          >
            {listing.url ? (
              <a
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="underline decoration-dotted underline-offset-2 hover:opacity-70"
              >
                {listing.title}
              </a>
            ) : (
              listing.title
            )}
          </p>

          {/* location line */}
          <p className="text-sm" style={{ color: 'var(--faint)' }}>
            {cost.distanceKm} km · ~{cost.minutesOneWay} min each way
            {store.address ? ` · ${store.address}` : ''}
            {' · '}
            <a
              href={mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:opacity-70"
              aria-label={`Open ${store.name} on OpenStreetMap`}
            >
              Map
            </a>
            {alsoAt.length > 0
              ? ` · +${alsoAt.length} mapped branch${
                  alsoAt.length === 1 ? '' : 'es'
                } (stock unverified)`
              : ''}
          </p>
        </div>

        {/* prices */}
        <div className="text-right shrink-0">
          <div
            className="text-lg font-semibold tabular-nums whitespace-nowrap"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {formatKzt(listing.price)}
          </div>
          {listing.oldPrice && listing.oldPrice > listing.price && (
            <div
              className="text-xs line-through tabular-nums"
              style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}
            >
              {formatKzt(listing.oldPrice)}
            </div>
          )}
          <div
            className="text-xs mt-1 tabular-nums whitespace-nowrap"
            style={{ color: 'var(--muted)' }}
            title={`Sticker ${formatKzt(listing.price)} + travel ${formatKzt(
              cost.travel
            )} + time ${formatKzt(cost.timeCost)}`}
          >
            {formatKzt(cost.total)} estimated all-in
          </div>
          {!isBest && delta > 0 && (
            <div className="text-xs mt-0.5 tabular-nums" style={{ color: 'var(--faint)' }}>
              +{formatKzt(delta)}
            </div>
          )}
        </div>
      </div>

      {/* reasons */}
      {reasons.length > 0 && (
        <ul className="mt-3 pt-3 flex flex-col gap-1" style={{ borderTop: '1px solid var(--border)' }}>
          {reasons.map((reason) => (
            <li key={reason} className="text-xs flex gap-2" style={{ color: 'var(--muted)' }}>
              <span style={{ color: 'var(--faint)' }}>·</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {/* confidence hint for weak matches */}
      {match.confidence < 0.6 && (
        <p className="text-xs mt-2" style={{ color: 'var(--warn)' }}>
          Low match confidence ({Math.round(match.confidence * 100)}%) — this may be a
          different variant.
        </p>
      )}
    </li>
  );
}
