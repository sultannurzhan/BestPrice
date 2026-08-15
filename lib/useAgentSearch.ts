'use client';

import { useCallback, useRef, useState } from 'react';
import type {
  AgentEvent,
  Deal,
  ProductQuery,
  ScrapeFailure,
  SearchRequest,
  SearchSummary,
} from './types';

/**
 * Drives the streaming search.
 *
 * The endpoint is a POST that streams server-sent events, so `EventSource` is
 * not an option (it only does GET). We read the body stream and split on the
 * SSE record separator ourselves.
 */

export interface DomainProgress {
  domain: string;
  state: 'start' | 'done';
  found?: number;
  failure?: ScrapeFailure | null;
  tookMs?: number;
}

export interface AgentState {
  running: boolean;
  status: string | null;
  query: ProductQuery | null;
  storeCount: number | null;
  domainCount: number | null;
  progress: DomainProgress[];
  deals: Deal[] | null;
  summary: SearchSummary | null;
  error: string | null;
}

const IDLE: AgentState = {
  running: false,
  status: null,
  query: null,
  storeCount: null,
  domainCount: null,
  progress: [],
  deals: null,
  summary: null,
  error: null,
};

export function useAgentSearch() {
  const [state, setState] = useState<AgentState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, running: false, status: null }));
  }, []);

  const run = useCallback(async (request: SearchRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...IDLE, running: true, status: 'Starting…' });

    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        const problem = await res.json().catch(() => ({ error: res.statusText }));
        setState((s) => ({
          ...s,
          running: false,
          error: problem.error ?? `Request failed (${res.status})`,
        }));
        return;
      }

      if (!res.body) {
        setState((s) => ({ ...s, running: false, error: 'No response stream' }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE records are separated by a blank line.
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const record = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);

          const line = record.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;

          let event: AgentEvent;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          setState((prev) => reduce(prev, event));
        }
      }

      setState((s) => ({ ...s, running: false, status: null }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({
        ...s,
        running: false,
        error: err instanceof Error ? err.message : 'Search failed',
      }));
    }
  }, []);

  const reset = useCallback(() => setState(IDLE), []);

  return { state, run, cancel, reset };
}

function reduce(prev: AgentState, event: AgentEvent): AgentState {
  switch (event.type) {
    case 'status':
      return { ...prev, status: event.message };

    case 'query':
      return { ...prev, query: event.query };

    case 'stores':
      return { ...prev, storeCount: event.count, domainCount: event.domains };

    case 'domain': {
      const progress = [...prev.progress];
      const i = progress.findIndex((p) => p.domain === event.domain);
      const entry: DomainProgress =
        event.state === 'start'
          ? { domain: event.domain, state: 'start' }
          : {
              domain: event.domain,
              state: 'done',
              found: event.found,
              failure: event.failure,
              tookMs: event.tookMs,
            };
      if (i === -1) progress.push(entry);
      else progress[i] = entry;
      return { ...prev, progress };
    }

    case 'results':
      return {
        ...prev,
        deals: event.deals,
        summary: event.summary,
        status: null,
        running: false,
      };

    case 'error':
      return { ...prev, error: event.message, running: false, status: null };

    default:
      return prev;
  }
}
