'use client';

import { useEffect, useEffectEvent, useState } from 'react';

type Drafts<K extends string> = Partial<Record<K, string>>;

/** A URL patch for text filters: `null` removes the param. */
export type TextFilterPatch<K extends string> = Partial<Record<K, string | null>>;

/**
 * Text the user typed that is not in the URL yet, for the keys they edited only. `null` when the
 * URL already matches every draft (after trimming).
 */
export function pendingTextPatch<K extends string>(
  url: Readonly<Record<K, string>>,
  drafts: Drafts<K>,
): TextFilterPatch<K> | null {
  const patch: TextFilterPatch<K> = {};
  let changed = false;
  for (const key of Object.keys(drafts) as K[]) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    const value = draft.trim();
    if (value !== url[key]) {
      patch[key] = value || null;
      changed = true;
    }
  }
  return changed ? patch : null;
}

/**
 * Reconciles drafts after the URL changed. A key whose URL value moved to what this hook wrote
 * itself keeps its draft (the user may have typed on meanwhile); a key changed by anything else —
 * navigation to a link with filters, back/forward, a route revived by `<Activity>` — drops its
 * draft so the input shows the URL value.
 */
export function reconcileTextDrafts<K extends string>(
  previousUrl: Readonly<Record<K, string>>,
  url: Readonly<Record<K, string>>,
  drafts: Drafts<K>,
  written: Drafts<K>,
): { drafts: Drafts<K>; written: Drafts<K> } {
  const nextDrafts: Drafts<K> = { ...drafts };
  const nextWritten: Drafts<K> = { ...written };
  for (const key of Object.keys(url) as K[]) {
    if (previousUrl[key] === url[key]) continue;
    const ownWrite = written[key] !== undefined && written[key] === url[key];
    delete nextWritten[key];
    if (!ownWrite) delete nextDrafts[key];
  }
  return { drafts: nextDrafts, written: nextWritten };
}

function sameValues<K extends string>(a: Readonly<Record<K, string>>, b: Readonly<Record<K, string>>): boolean {
  return (Object.keys(b) as K[]).every((key) => a[key] === b[key]);
}

/**
 * Local state for URL-synced free-text filters (search boxes in table toolbars).
 *
 * - Typing is debounced into the URL via `commit`, which receives only the keys the user edited —
 *   a stale input can never revert a filter that changed elsewhere.
 * - When the URL changes for another reason, the inputs follow it.
 *
 * @param url  current values from the URL (trimmed, `''` when absent) — one entry per text filter
 * @param commit writes a patch to the URL (`null` removes the param); read the latest search params
 */
export function useUrlTextFilters<K extends string>(
  url: Readonly<Record<K, string>>,
  commit: (patch: TextFilterPatch<NoInfer<K>>) => void,
  delayMs = 300,
): {
  /** Input values (draft or URL value). */
  text: Record<K, string>;
  setText: (key: K, value: string) => void;
  /** Drops every draft (e.g. "Clear filters", together with clearing the URL). */
  clear: () => void;
} {
  const [drafts, setDrafts] = useState<Drafts<K>>({});
  const [written, setWritten] = useState<Drafts<K>>({});
  // "Adjust state during render": follow URL changes made outside this hook.
  const [syncedUrl, setSyncedUrl] = useState(url);
  if (!sameValues(syncedUrl, url)) {
    const next = reconcileTextDrafts(syncedUrl, url, drafts, written);
    setSyncedUrl(url);
    setDrafts(next.drafts);
    setWritten(next.written);
  }

  const flush = useEffectEvent((patch: TextFilterPatch<K>) => {
    setWritten((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch) as K[]) next[key] = patch[key] ?? '';
      return next;
    });
    commit(patch);
  });
  const pending = pendingTextPatch(url, drafts);
  const pendingKey = pending ? JSON.stringify(pending) : null;
  useEffect(() => {
    if (!pendingKey) return;
    const timer = setTimeout(() => flush(JSON.parse(pendingKey) as TextFilterPatch<K>), delayMs);
    return () => clearTimeout(timer);
  }, [pendingKey, delayMs]);

  const text = {} as Record<K, string>;
  for (const key of Object.keys(url) as K[]) text[key] = drafts[key] ?? url[key];

  return {
    text,
    setText: (key, value) => setDrafts((prev) => ({ ...prev, [key]: value })),
    clear: () => setDrafts({}),
  };
}
