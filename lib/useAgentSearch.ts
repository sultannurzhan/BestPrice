'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

function finishPendingProgress(
  progress: DomainProgress[],
  failure: ScrapeFailure = 'unreachable'
): DomainProgress[] {
  return progress.map((entry) =>
    entry.state === 'start'
      ? { domain: entry.domain, state: 'done', found: 0, failure }
      : entry
  );
}

function failedState(
  state: AgentState,
  error: string,
  failure: ScrapeFailure = 'unreachable'
): AgentState {
  return {
    ...state,
    running: false,
    status: null,
    progress: finishPendingProgress(state.progress, failure),
    error,
  };
}

export function useAgentSearch() {
  const [state, setState] = useState<AgentState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const lastRequestRef = useRef<SearchRequest | null>(null);

  useEffect(
    () => () => {
      requestIdRef.current++;
      abortRef.current?.abort();
    },
    []
  );

  const cancel = useCallback(() => {
    requestIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, running: false, status: 'Search stopped' }));
  }, []);

  const run = useCallback(async (request: SearchRequest) => {
    lastRequestRef.current = request;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    const update = (fn: (state: AgentState) => AgentState) => {
      if (requestIdRef.current === requestId) setState(fn);
    };

    setState({ ...IDLE, running: true, status: 'Starting…' });
    let terminalEvent = false;

    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok) {
        const problem = await res.json().catch(() => ({ error: res.statusText }));
        terminalEvent = true;
        update((s) =>
          failedState(s, problem.error ?? `Request failed (${res.status})`)
        );
        return;
      }

      if (!res.body) {
        terminalEvent = true;
        update((s) => failedState(s, 'No response stream'));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Accept both LF and CRLF separators; proxies are allowed to normalize
        // line endings even though our own route emits LF.
        for (;;) {
          const separator = buffer.match(/(?:\r\n|\r|\n){2}/);
          if (separator?.index === undefined) break;
          const record = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);

          const event = parseSseRecord(record);
          if (!event) continue;
          if (event.type === 'results' || event.type === 'error') terminalEvent = true;
          update((prev) => reduce(prev, event));
        }
      }

      // A well-formed SSE stream ends records with a blank line, but process a
      // final complete data line too so intermediary buffering cannot discard
      // the terminal result.
      buffer += decoder.decode();
      const finalEvent = parseSseRecord(buffer);
      if (finalEvent) {
        if (finalEvent.type === 'results' || finalEvent.type === 'error') {
          terminalEvent = true;
        }
        update((prev) => reduce(prev, finalEvent));
      }

      if (!terminalEvent) {
        update((s) =>
          failedState(s, 'The search ended before results arrived. Please try again.')
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      update((s) =>
        failedState(s, err instanceof Error ? err.message : 'Search failed')
      );
    } finally {
      if (requestIdRef.current === requestId) abortRef.current = null;
    }
  }, []);

  const retry = useCallback(() => {
    if (lastRequestRef.current) void run(lastRequestRef.current);
  }, [run]);

  const reset = useCallback(() => {
    requestIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  return {
    state,
    run,
    cancel,
    retry,
    canRetry: lastRequestRef.current !== null && !state.running,
    reset,
  };
}

function parseSseRecord(record: string): AgentEvent | null {
  const data: string[] = [];
  for (const line of record.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  if (data.length === 0) return null;
  try {
    return JSON.parse(data.join('\n')) as AgentEvent;
  } catch {
    return null;
  }
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
      return failedState(
        prev,
        event.message,
        /time limit|timed out/i.test(event.message) ? 'timeout' : 'unreachable'
      );

    default:
      return prev;
  }
}

export const __testing = { parseSseRecord, reduce };
