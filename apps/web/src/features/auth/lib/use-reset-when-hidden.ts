'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * Cache Components keep recently visited routes mounted inside React `<Activity>` (hidden, with
 * their state preserved — see next/dist/docs/01-app/02-guides/preserving-ui-state.md). Auth screens
 * must not come back with a stale result: a "pending" button left disabled by an earlier success, an
 * old error, a typed password or code. `reset` runs when the screen is hidden (the layout-effect
 * cleanup runs synchronously on hide), so the next visit starts clean; on re-show the screen's own
 * effects (e.g. prefilling the remembered email) run again.
 *
 * `reset` may change between renders — the latest one is used.
 */
export function useResetWhenHidden(reset: () => void): void {
  const latest = useRef(reset);
  useLayoutEffect(() => {
    latest.current = reset;
  });
  useLayoutEffect(() => () => latest.current(), []);
}
