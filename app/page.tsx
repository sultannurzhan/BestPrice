'use client';

import { AgentProgress } from '@/components/AgentProgress';
import { DealCard } from '@/components/DealCard';
import { SearchForm } from '@/components/SearchForm';
import { useAgentSearch } from '@/lib/useAgentSearch';

export default function Home() {
  const { state, run, cancel, retry, canRetry } = useAgentSearch();
  const { deals, summary } = state;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-16">
      {/* ---- header ---------------------------------------------------- */}
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">BestPrice</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Checks the shops around you and ranks them by what the purchase really
          costs — sticker price plus getting there.
        </p>
      </header>

      {/* ---- form ------------------------------------------------------ */}
      <SearchForm
        running={state.running}
        onCancel={cancel}
        onSearch={({ coords, radiusM, item }) =>
          run({ lat: coords.lat, lon: coords.lon, radiusM, item })
        }
      />

      {/* ---- progress -------------------------------------------------- */}
      <div className="mt-4">
        <AgentProgress
          status={state.status}
          storeCount={state.storeCount}
          domainCount={state.domainCount}
          progress={state.progress}
          running={state.running}
        />
      </div>

      {/* ---- error ----------------------------------------------------- */}
      {state.error && (
        <div
          className="card p-4 mt-4 text-sm"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
          role="alert"
        >
          <p>{state.error}</p>
          {canRetry && (
            <button type="button" className="btn btn-ghost mt-3" onClick={retry}>
              Retry search
            </button>
          )}
        </div>
      )}

      {/* ---- verdict --------------------------------------------------- */}
      {summary?.verdict && deals && deals.length > 0 && (
        <p
          className="mt-6 text-sm leading-relaxed fade-up"
          style={{ color: 'var(--text)' }}
        >
          {summary.verdict}
        </p>
      )}

      {/* ---- results --------------------------------------------------- */}
      {deals && deals.length > 0 && (
        <ol className="mt-4 flex flex-col gap-3">
          {deals.map((deal, i) => (
            <DealCard
              key={`${deal.store.id}-${deal.listing.url ?? deal.listing.title}`}
              deal={deal}
              rank={i}
              bestTotal={deals[0].cost.total}
            />
          ))}
        </ol>
      )}

      {/* ---- empty state ----------------------------------------------- */}
      {deals && deals.length === 0 && summary && (
        <div className="card p-5 mt-4 fade-up">
          <p className="text-sm font-medium mb-2">No matching products found</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {summary.verdict ??
              `Checked ${summary.domainsQueried} retailer site${
                summary.domainsQueried === 1 ? '' : 's'
              } near you and read ${summary.listingsSeen} listing${
                summary.listingsSeen === 1 ? '' : 's'
              }, but none matched "${state.query?.raw ?? ''}".`}
          </p>
          <p className="text-sm mt-3" style={{ color: 'var(--muted)' }}>
            Try a wider radius, or a simpler search term like the brand and model
            only.
          </p>
        </div>
      )}

      {/* ---- coverage footnote ----------------------------------------- */}
      {summary && (
        <footer
          className="mt-8 pt-5 text-xs leading-relaxed"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--faint)' }}
        >
          <p>
            Searched {summary.storesFound} mapped shop
            {summary.storesFound === 1 ? '' : 's'} across {summary.domainsQueried}{' '}
            retailer site{summary.domainsQueried === 1 ? '' : 's'} in{' '}
            {summary.tookMs < 1000
              ? `${summary.tookMs} ms`
              : `${(summary.tookMs / 1000).toFixed(1)}s`}
            . Read {summary.listingsSeen}{' '}
            listing{summary.listingsSeen === 1 ? '' : 's'}, {summary.listingsMatched}{' '}
            matched after filtering out accessories and other models.
          </p>
          {summary.gaps.length > 0 && (
            <div className="mt-2">
              <p>Not included in this comparison:</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {summary.gaps.map((gap) => (
                  <li key={gap.label}>
                    · <span style={{ color: 'var(--muted)' }}>{gap.label}</span> —{' '}
                    {gap.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2">
            Shop locations from OpenStreetMap. Prices are read from each
            retailer&apos;s public website and may lag the shelf. Travel and time
            costs are estimates, and branch stock is not verified — always
            confirm before travelling.
          </p>
        </footer>
      )}
    </main>
  );
}
