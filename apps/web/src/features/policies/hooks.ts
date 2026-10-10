'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/** Search param holding the selected policy version (`?version=<id>`). */
export const VERSION_PARAM = 'version';

/**
 * `value`, updated only after it stopped changing for `delayMs`. Use a primitive (e.g. a JSON
 * string) so unchanged values don't restart the timer on every render.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Selected version as URL state (`?version=<id>`), so a version can be linked and survives reloads. */
export function usePolicySelection() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get(VERSION_PARAM);

  const hrefFor = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set(VERSION_PARAM, id);
      else params.delete(VERSION_PARAM);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );

  const select = useCallback(
    (id: string | null) => router.replace(hrefFor(id), { scroll: false }),
    [router, hrefFor],
  );

  return { selectedId, select, hrefFor };
}

/** True below the `lg` breakpoint, read at call time (event handlers only). */
export function isStackedLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
}

/** Scrolls an element into view, respecting reduced-motion preferences (event handlers only). */
export function scrollToElement(id: string) {
  if (typeof window === 'undefined') return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.requestAnimationFrame(() => {
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  });
}
