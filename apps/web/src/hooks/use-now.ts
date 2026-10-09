'use client';

import { useSyncExternalStore } from 'react';

/**
 * Current time that is safe for prerendering and hydration: returns `null` on the server (and
 * during hydration), then the real time on the client, re-rendering every `TICK_MS`.
 * Use it instead of calling `Date.now()` / `new Date()` during render (Cache Components treat
 * that as an error outside <Suspense> and it would cause hydration mismatches).
 */
const TICK_MS = 30_000;

let now = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  // Refresh a stale value lazily (first use, or after the tab slept with no subscribers).
  if (now === 0 || (!timer && Date.now() - now > TICK_MS)) now = Date.now();
  return now;
}

const getServerSnapshot = (): number | null => null;

/** Milliseconds since epoch on the client, `null` on the server. */
export function useNow(): number | null {
  return useSyncExternalStore<number | null>(subscribe, getSnapshot, getServerSnapshot);
}
