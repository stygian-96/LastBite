"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toDate } from "@/lib/format";

type QueryOptions = { pollMs?: number; enabled?: boolean };

const SLOW_AFTER_MS = 3000;

// Small fetch hook: loading, error, retry, polling, and the design's slow-connection flag.
export function useQuery<T>(fn: () => Promise<T>, deps: readonly unknown[], options: QueryOptions = {}) {
  const { pollMs, enabled = true } = options;
  const [state, setState] = useState<{ data?: T; error?: unknown; settled: boolean; slow: boolean }>({
    settled: false,
    slow: false,
  });
  const fnRef = useRef(fn);
  const callId = useRef(0);
  useEffect(() => {
    fnRef.current = fn;
  });

  const run = useCallback(async () => {
    const id = ++callId.current;
    const slowTimer = setTimeout(() => {
      if (id === callId.current) setState((s) => ({ ...s, slow: true }));
    }, SLOW_AFTER_MS);
    try {
      const data = await fnRef.current();
      if (id === callId.current) setState({ data, settled: true, slow: false });
    } catch (error) {
      if (id === callId.current) setState((s) => ({ data: s.data, error, settled: true, slow: false }));
    } finally {
      clearTimeout(slowTimer);
    }
  }, []);

  const depsKey = JSON.stringify(deps);
  useEffect(() => {
    if (!enabled) return;
    const calls = callId;
    const first = setTimeout(run, 0);
    const poll = pollMs ? setInterval(run, pollMs) : undefined;
    return () => {
      clearTimeout(first);
      if (poll) clearInterval(poll);
      calls.current++;
    };
  }, [depsKey, enabled, pollMs, run]);

  const setData = useCallback((data: T) => setState({ data, settled: true, slow: false }), []);

  return {
    data: state.data,
    error: state.error,
    loading: !state.settled,
    slow: state.slow,
    reload: run,
    setData,
  };
}

export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

// Seconds until a timestamp, ticking once a second.
export function useSecondsLeft(iso: string | null | undefined): number | null {
  const now = useNow();
  if (!iso || now === null) return null;
  return Math.max(0, (toDate(iso).getTime() - now) / 1000);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * A tab kept in the URL hash, so a link or Back lands on the same tab. Read after mount: on a
 * client-side navigation the URL changes after the first render. replaceState, as Next's router owns
 * the history entries.
 */
export function useHashTab<T extends string>(tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(fallback);
  const tabsKey = tabs.join();
  useEffect(() => {
    const read = () => setTab(tabs.find((t) => `#${t}` === window.location.hash) ?? fallback);
    const first = setTimeout(read, 0);
    window.addEventListener("hashchange", read);
    return () => {
      clearTimeout(first);
      window.removeEventListener("hashchange", read);
    };
    // tabsKey stands in for tabs, which callers pass as a fresh array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey, fallback]);
  const go = useCallback((next: T) => {
    history.replaceState(history.state, "", `#${next}`);
    setTab(next);
  }, []);
  return [tab, go];
}
