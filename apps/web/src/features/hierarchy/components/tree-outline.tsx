'use client';

import { BadgeCheck, ChevronDown, ChevronRight, Loader2, MoreHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';

import {
  depthColor,
  flattenVisible,
  focusAfterLoadMore,
  nodeLabel,
  type VisibleItem,
  type VisibleTree,
} from '../model';
import { describeItem } from './tree-canvas';

export interface TreeOutlineProps {
  visible: VisibleTree;
  selectedId: string | null;
  highlight: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  /** Resolves with the ids of the loaded children (focus moves to the first after the last page). */
  onLoadMore: (parentId: string) => Promise<readonly string[]> | void;
  label: string;
  rootLabel: string;
  className?: string;
}

/**
 * List/outline view of the same tree (WAI-ARIA tree pattern): default on small screens and the
 * accessible alternative to the canvas. Arrow keys move, Right/Left expand/collapse, Enter selects.
 */
export function TreeOutline({
  visible,
  selectedId,
  highlight,
  pending,
  onToggle,
  onSelect,
  onLoadMore,
  label,
  rootLabel,
  className,
}: TreeOutlineProps) {
  const refs = useRef(new Map<string, HTMLLIElement>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const order = useMemo(() => flattenVisible(visible.root), [visible]);
  const parents = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of order) for (const c of item.children) map.set(c.id, item.id);
    return map;
  }, [order]);
  const rovingId = activeId && order.some((o) => o.id === activeId) ? activeId : (visible.root?.id ?? null);

  // After the last "Load N more" page its item (and the focus) disappears: move focus to the first
  // new child once the page is rendered. "Adjust state during render", then focus in an effect.
  const [loadFocus, setLoadFocus] = useState<{ parentId: string; ids: readonly string[] } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);
  if (loadFocus) {
    const next = focusAfterLoadMore(order, loadFocus.parentId, loadFocus.ids);
    if (next.status !== 'wait') {
      setLoadFocus(null);
      if (next.status === 'focus') {
        setActiveId(next.id);
        setFocusRequest((prev) => ({ id: next.id, seq: (prev?.seq ?? 0) + 1 }));
      }
    }
  }
  useEffect(() => {
    if (focusRequest) refs.current.get(focusRequest.id)?.focus();
  }, [focusRequest]);

  function focusItem(id: string | undefined) {
    if (!id) return;
    setActiveId(id);
    refs.current.get(id)?.focus();
  }

  function loadMore(parentId: string) {
    const result = onLoadMore(parentId);
    if (result) void result.then((ids) => setLoadFocus({ parentId, ids }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLLIElement>, item: VisibleItem) {
    if (event.target !== event.currentTarget) return;
    const index = order.findIndex((o) => o.id === item.id);
    switch (event.key) {
      case 'ArrowDown':
        focusItem(order[index + 1]?.id);
        break;
      case 'ArrowUp':
        focusItem(order[index - 1]?.id);
        break;
      case 'ArrowRight':
        if (item.kind === 'member' && item.node.childCount > 0) {
          if (!item.expanded) onToggle(item.id);
          else focusItem(item.children[0]?.id);
        }
        break;
      case 'ArrowLeft':
        if (item.kind === 'member' && item.expanded && item.node.childCount > 0) onToggle(item.id);
        else focusItem(parents.get(item.id));
        break;
      case 'Home':
        focusItem(order[0]?.id);
        break;
      case 'End':
        focusItem(order[order.length - 1]?.id);
        break;
      case 'Enter':
      case ' ':
        if (item.kind === 'more') loadMore(item.parentId);
        else onSelect(item.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function renderItem(item: VisibleItem, level: number, posinset: number, setsize: number) {
    const common = {
      ref: (el: HTMLLIElement | null) => {
        if (el) refs.current.set(item.id, el);
        else refs.current.delete(item.id);
      },
      tabIndex: item.id === rovingId ? 0 : -1,
      'aria-level': level,
      'aria-posinset': posinset,
      'aria-setsize': setsize,
      onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => onKeyDown(e, item),
      onFocus: (e: FocusEvent<HTMLLIElement>) => {
        if (e.target === e.currentTarget) setActiveId(item.id);
      },
      className: 'outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-ring',
    };
    const indent = { paddingLeft: `${(level - 1) * 1.25 + 0.5}rem` };

    if (item.kind === 'more') {
      const busy = pending.has(item.id);
      return (
        <li key={item.id} role="treeitem" aria-selected={false} {...common} aria-label={describeItem(item, rootLabel)}>
          <div
            className="flex cursor-pointer items-center gap-2 rounded-md py-2 pr-2 text-sm text-primary hover:bg-accent"
            style={indent}
            onClick={() => loadMore(item.parentId)}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MoreHorizontal className="size-4" aria-hidden />}
            {busy ? 'Loading…' : `Load ${item.remaining} more`}
          </div>
        </li>
      );
    }

    const n = item.node;
    const hasChildren = n.childCount > 0;
    const selected = item.id === selectedId;
    const busy = pending.has(item.id);
    return (
      <li
        key={item.id}
        role="treeitem"
        {...common}
        aria-label={describeItem(item, rootLabel)}
        aria-selected={selected}
        aria-expanded={hasChildren ? item.expanded : undefined}
      >
        <div
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm hover:bg-accent',
            selected && 'bg-primary/10',
            highlight.has(item.id) && !selected && 'bg-muted',
          )}
          style={indent}
          onClick={() => onSelect(item.id)}
        >
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background"
            onClick={(e) => {
              if (!hasChildren) return;
              e.stopPropagation();
              onToggle(item.id);
            }}
            aria-hidden
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : hasChildren ? (
              item.expanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )
            ) : null}
          </span>
          <span className="h-4 w-1 shrink-0 rounded-full" style={{ background: depthColor(n.depth) }} aria-hidden />
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              n.statusBucket === 'INACTIVE' || n.inScope === false ? 'text-muted-foreground' : 'font-medium',
              n.inScope === false && 'italic',
            )}
          >
            {nodeLabel(n)}
            {n.statusBucket === 'INACTIVE' ? <span className="ml-2 text-xs font-normal">Inactive</span> : null}
          </span>
          {n.hasEligibleEnrollment ? (
            <BadgeCheck className="size-4 shrink-0 text-primary" aria-hidden />
          ) : null}
          <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            {n.depth === 0 ? rootLabel : `L${n.depth}`} · {n.childCount}
          </span>
        </div>
        {item.expanded && item.children.length > 0 ? (
          <ul role="group">
            {item.children.map((c, i) => renderItem(c, level + 1, i + 1, item.children.length))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <div className={cn('h-full overflow-auto p-2', className)}>
      {visible.root ? (
        <ul role="tree" aria-label={label} className="space-y-0.5">
          {renderItem(visible.root, 1, 1, 1)}
        </ul>
      ) : null}
    </div>
  );
}
