'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { getErrorMessage } from '@/lib/api-client';

import {
  applyPatches,
  buildVisibleTree,
  modelFromTree,
  moreItemId,
  newChildIds,
  pathToRoot,
  type TreeModel,
  type TreePatch,
  type VisibleTree,
} from './model';
import { hierarchyKeys } from './query-keys';
import type { AnyTreeResponse, HierarchySource } from './types';

/** Levels fetched per request: 2 when expanding, so the next expansion is instant. */
const INITIAL_DEPTH = 2;

export interface CenterRequest {
  id: string;
  nonce: number;
}

export interface HierarchyExplorerState {
  source: HierarchySource;
  status: 'pending' | 'error' | 'success';
  error: unknown;
  refetch: () => void;
  model: TreeModel;
  visible: VisibleTree;
  /** Server stopped deeper levels because of its node budget. */
  serverTruncated: boolean;
  viewRootId: string | null;
  isViewRootCustom: boolean;
  selectedId: string | null;
  /** Ids along the last focused path (search / breadcrumb), top first. */
  highlight: ReadonlySet<string>;
  /** Path from the anchor to the selected member, top first. */
  selectedPath: string[];
  pending: ReadonlySet<string>;
  center: CenterRequest | null;
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  expand: (id: string) => Promise<void>;
  collapse: (id: string) => void;
  /** Loads the next page of children; resolves with the ids it added (`[]` on failure). */
  loadMore: (parentId: string) => Promise<string[]>;
  select: (id: string | null) => void;
  focusMember: (id: string) => Promise<void>;
  showFrom: (id: string | null) => void;
  centerOn: (id: string) => void;
}

/**
 * State machine of the team explorer: the initial tree (anchor + 2 levels) plus patches from lazy
 * loads, expand/collapse overrides, selection, path highlight and the canvas centering request.
 */
export function useHierarchyExplorer(source: HierarchySource): HierarchyExplorerState {
  const queryClient = useQueryClient();
  const initial = useQuery({
    queryKey: hierarchyKeys.tree(source.key, null, INITIAL_DEPTH),
    queryFn: ({ signal }) => source.tree(undefined, INITIAL_DEPTH, signal),
  });

  const base = useMemo(() => modelFromTree(initial.data?.root), [initial.data]);
  const [patches, setPatches] = useState<TreePatch[]>([]);
  const model = useMemo(() => applyPatches(base, patches), [base, patches]);

  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [viewRootId, setViewRootId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [center, setCenter] = useState<CenterRequest | null>(null);
  const [serverTruncated, setServerTruncated] = useState(false);

  const effectiveViewRoot = viewRootId && model.nodes[viewRootId] ? viewRootId : model.rootId;
  const isExpanded = useCallback(
    (id: string) => overrides.get(id) ?? id === effectiveViewRoot,
    [overrides, effectiveViewRoot],
  );
  const visible = useMemo(
    () => buildVisibleTree(model, effectiveViewRoot, isExpanded),
    [model, effectiveViewRoot, isExpanded],
  );
  const highlight = useMemo(() => new Set(highlightIds), [highlightIds]);
  const selectedPath = useMemo(() => (selectedId ? pathToRoot(model, selectedId) : []), [model, selectedId]);

  const setExpanded = useCallback((id: string, value: boolean) => {
    setOverrides((prev) => new Map(prev).set(id, value));
  }, []);
  const markPending = useCallback((id: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const fetchTree = useCallback(
    (rootId: string, depth: number): Promise<AnyTreeResponse> =>
      queryClient.fetchQuery({
        queryKey: hierarchyKeys.tree(source.key, rootId, depth),
        queryFn: ({ signal }) => source.tree(rootId, depth, signal),
        staleTime: 30_000,
      }),
    [queryClient, source],
  );

  const expand = useCallback(
    async (id: string) => {
      const node = model.nodes[id];
      if (!node) return;
      setExpanded(id, true);
      if (node.childrenLoaded || node.childCount === 0) return;
      markPending(id, true);
      try {
        const res = await fetchTree(id, INITIAL_DEPTH);
        if (res.truncated) setServerTruncated(true);
        setPatches((prev) => [...prev, { kind: 'tree', root: res.root, parentId: node.parentId }]);
      } catch (error) {
        setExpanded(id, false);
        toast.error("Couldn't load this part of the team", { description: getErrorMessage(error) });
      } finally {
        markPending(id, false);
      }
    },
    [fetchTree, markPending, model.nodes, setExpanded],
  );

  const collapse = useCallback((id: string) => setExpanded(id, false), [setExpanded]);

  const toggle = useCallback(
    (id: string) => {
      if (isExpanded(id)) collapse(id);
      else void expand(id);
    },
    [collapse, expand, isExpanded],
  );

  const loadMore = useCallback(
    async (parentId: string): Promise<string[]> => {
      const node = model.nodes[parentId];
      const cursor = node?.childrenCursor ?? null;
      if (!node || !cursor) return [];
      const key = moreItemId(parentId);
      markPending(key, true);
      try {
        const page = await queryClient.fetchQuery({
          queryKey: hierarchyKeys.children(source.key, parentId, cursor),
          queryFn: ({ signal }) => source.children(parentId, cursor, signal),
          staleTime: 30_000,
        });
        setPatches((prev) => [
          ...prev,
          { kind: 'children', parentId, rows: page.data, nextCursor: page.page.nextCursor },
        ]);
        return newChildIds(model, parentId, page.data);
      } catch (error) {
        toast.error("Couldn't load more members", { description: getErrorMessage(error) });
        return [];
      } finally {
        markPending(key, false);
      }
    },
    [markPending, model, queryClient, source],
  );

  /** Loads every node on the path to `memberId`, expands it, selects + highlights + centers it. */
  const focusMember = useCallback(
    async (memberId: string) => {
      markPending(memberId, true);
      try {
        const { nodes } = await queryClient.fetchQuery({
          queryKey: hierarchyKeys.path(source.key, memberId),
          queryFn: ({ signal }) => source.path(memberId, signal),
          staleTime: 30_000,
        });
        let working = model;
        const local: TreePatch[] = [];
        for (const [i, p] of nodes.entries()) {
          const parentId = i > 0 ? (nodes[i - 1]?.id ?? null) : null;
          const existing = working.nodes[p.id];
          const isTarget = i === nodes.length - 1;
          if (!existing || (!isTarget && !existing.childrenLoaded)) {
            const res = await fetchTree(p.id, 1);
            const patch: TreePatch = { kind: 'tree', root: res.root, parentId };
            local.push(patch);
            working = applyPatches(working, [patch]);
          }
          if (parentId) {
            const link: TreePatch = { kind: 'link', parentId, childId: p.id };
            local.push(link);
            working = applyPatches(working, [link]);
          }
        }
        const ids = nodes.map((n) => n.id);
        setPatches((prev) => [...prev, ...local]);
        setOverrides((prev) => {
          const next = new Map(prev);
          for (const id of ids.slice(0, -1)) next.set(id, true);
          return next;
        });
        setViewRootId((current) => (current && !ids.includes(current) ? null : current));
        setSelectedId(memberId);
        setHighlightIds(ids);
        setCenter({ id: memberId, nonce: Date.now() });
      } catch (error) {
        toast.error("Couldn't show this member", { description: getErrorMessage(error) });
      } finally {
        markPending(memberId, false);
      }
    },
    [fetchTree, markPending, model, queryClient, source],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setHighlightIds(id ? pathToRoot(model, id) : []);
    },
    [model],
  );

  const showFrom = useCallback(
    (id: string | null) => {
      setViewRootId(id);
      const target = id ?? model.rootId;
      if (target) {
        setExpanded(target, true);
        setCenter({ id: target, nonce: Date.now() });
      }
    },
    [model.rootId, setExpanded],
  );

  const centerOn = useCallback((id: string) => setCenter({ id, nonce: Date.now() }), []);

  return {
    source,
    status: initial.status,
    error: initial.error,
    refetch: () => void initial.refetch(),
    model,
    visible,
    serverTruncated: serverTruncated || Boolean(initial.data?.truncated),
    viewRootId: effectiveViewRoot,
    isViewRootCustom: Boolean(viewRootId && viewRootId !== model.rootId && model.nodes[viewRootId]),
    selectedId,
    highlight,
    selectedPath,
    pending,
    center,
    isExpanded,
    toggle,
    expand,
    collapse,
    loadMore,
    select,
    focusMember,
    showFrom,
    centerOn,
  };
}
