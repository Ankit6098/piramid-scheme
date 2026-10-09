'use client';

import { useSyncExternalStore } from 'react';

const noopSubscribe = () => () => {};
const getBrowserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const getServerTimeZone = () => null;

/**
 * The viewer's IANA time zone ("Asia/Kolkata"), or `null` on the server / during hydration so
 * server-rendered markup never bakes in the server's zone.
 */
export function useBrowserTimeZone(): string | null {
  return useSyncExternalStore<string | null>(noopSubscribe, getBrowserTimeZone, getServerTimeZone);
}
