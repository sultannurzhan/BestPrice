'use client';

import type { DomainProgress } from '@/lib/useAgentSearch';
import type { ScrapeFailure } from '@/lib/types';
import { labelFor } from '@/lib/scrape/adapters';

/** Plain-English reasons, so a zero result never looks like a silent bug. */
const FAILURE_LABEL: Record<ScrapeFailure, string> = {
  blocked: 'blocks bots',
  unreachable: 'unreachable',
  'no-search-endpoint': 'no readable search',
  'js-rendered': 'needs JavaScript',
  'no-listings': 'nothing found',
  'no-match': 'no matches',
  'unsafe-url': 'invalid website',
  'response-too-large': 'page too large',
  timeout: 'timed out',
};

interface Props {
  status: string | null;
  storeCount: number | null;
  domainCount: number | null;
  progress: DomainProgress[];
  running: boolean;
}

export function AgentProgress({
  status,
  storeCount,
  domainCount,
  progress,
  running,
}: Props) {
  if (!running && progress.length === 0 && !status) return null;

  const done = progress.filter((p) => p.state === 'done').length;

  return (
    <div
      className="card p-4 sm:p-5 fade-up"
      aria-live="polite"
      aria-busy={running}
    >
      {/* headline status */}
      <div className="flex items-center gap-2.5 mb-1">
        {running && (
          <span
            className="pulse-dot inline-block w-2 h-2 rounded-full shrink-0"
            style={{ background: 'var(--accent)' }}
            aria-hidden
          />
        )}
        <p className="text-sm font-medium">
          {status ?? (running ? 'Working…' : 'Done')}
        </p>
      </div>

      {storeCount !== null && (
        <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
          {storeCount} shop{storeCount === 1 ? '' : 's'} mapped nearby ·{' '}
          {domainCount ?? 0} retailer site{domainCount === 1 ? '' : 's'} to check
          {domainCount ? ` · ${done}/${domainCount} checked` : ''}
        </p>
      )}

      {/* per-domain chips */}
      {progress.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Retailer progress">
          {progress.map((p) => {
            const label = labelFor(p.domain);
            const pending = p.state === 'start';
            const found = p.found ?? 0;
            const ok = !pending && found > 0;

            return (
              <li
                key={p.domain}
                className="text-xs px-2 py-1 rounded-md whitespace-nowrap"
                style={{
                  border: '1px solid var(--border)',
                  background: ok ? 'var(--accent-soft)' : 'transparent',
                  color: pending
                    ? 'var(--faint)'
                    : ok
                      ? 'var(--accent)'
                      : 'var(--muted)',
                }}
                title={p.domain}
              >
                {pending ? (
                  <>{label}…</>
                ) : ok ? (
                  <>
                    {label} · {found}
                  </>
                ) : (
                  <>
                    {label} · {p.failure ? FAILURE_LABEL[p.failure] : 'nothing'}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
