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

export function useAgentSearch() {
  const [state, setState] = useState<AgentState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

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
    setState((s) => ({ ...s, running: false, status: null }));
  }, []);

  const run = useCallback(async (request: SearchRequest) => {
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
        update((s) => ({
          ...s,
          running: false,
          error: problem.error ?? `Request failed (${res.status})`,
        }));
        return;
      }

      if (!res.body) {
        terminalEvent = true;
        update((s) => ({ ...s, running: false, error: 'No response stream' }));
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
          const separator = buffer.match(/\r?\n\r?\n/);
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
        update((s) => ({
          ...s,
          running: false,
          status: null,
          error: 'The search ended before results arrived. Please try again.',
        }));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      update((s) => ({
        ...s,
        running: false,
        error: err instanceof Error ? err.message : 'Search failed',
      }));
    } finally {
      if (requestIdRef.current === requestId) abortRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  return { state, run, cancel, reset };
}

function parseSseRecord(record: string): AgentEvent | null {
  const line = record.split(/\r?\n/).find((candidate) => candidate.startsWith('data: '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(6)) as AgentEvent;
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
      return { ...prev, error: event.message, running: false, status: null };

    default:
      return prev;
  }
}

export const __testing = { parseSseRecord, reduce };
