'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * Filters, tabs and the open drawer kept in the URL (shareable, survives reload and back/forward).
 * `set({ status: 'POSTED', cursor: null })` — `null`/empty removes a param.
 */
export function useUrlState<K extends string>(keys: readonly K[]) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const serialized = searchParams.toString();

  const values = useMemo(() => {
    const params = new URLSearchParams(serialized);
    return Object.fromEntries(keys.map((k) => [k, params.get(k) || undefined])) as Record<K, string | undefined>;
    // `keys` is a module-level constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  const set = useCallback(
    (patch: Partial<Record<K, string | null | undefined>>) => {
      const next = new URLSearchParams(serialized);
      for (const [key, value] of Object.entries(patch) as Array<[string, string | null | undefined]>) {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [serialized, router, pathname],
  );

  return [values, set] as const;
}
