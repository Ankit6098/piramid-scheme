'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Runtime breadcrumb labels (e.g. a program's name instead of its id). Pages register a label for
 * their path; the top-bar breadcrumbs read it. Client-only module state, written in effects.
 */
let labels: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
const EMPTY: ReadonlyMap<string, string> = new Map();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBreadcrumbLabel(path: string, label: string | null | undefined) {
  const next = new Map(labels);
  if (label) next.set(path, label);
  else next.delete(path);
  labels = next;
  emit();
}

export function useBreadcrumbLabels(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => labels,
    () => EMPTY,
  );
}

/**
 * Sets the breadcrumb label for the current page (or `path`) while the component is mounted.
 *
 * @example useBreadcrumbLabel(program?.name); // "/admin/programs/5f2…" → "Summer promo"
 */
export function useBreadcrumbLabel(label: string | null | undefined, path?: string) {
  const pathname = usePathname();
  const target = path ?? pathname;
  useEffect(() => {
    if (!label) return;
    setBreadcrumbLabel(target, label);
    return () => setBreadcrumbLabel(target, null);
  }, [target, label]);
}
