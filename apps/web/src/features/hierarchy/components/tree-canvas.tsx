'use client';

import {
  hierarchy,
  linkHorizontal,
  select,
  tree as d3Tree,
  zoom,
  zoomIdentity,
  type HierarchyPointNode,
  type ZoomBehavior,
  type ZoomTransform,
} from 'd3';
import { BadgeCheck, Maximize, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { depthColor, flattenVisible, nodeLabel, type VisibleItem, type VisibleTree } from '../model';
import type { CenterRequest } from '../use-hierarchy-explorer';
import { NodeTooltip } from './node-tooltip';

const NODE_W = 196;
const NODE_H = 52;
const GAP_X = 52;
const GAP_Y = 14;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;

type LaidNode = HierarchyPointNode<VisibleItem>;

export interface TreeCanvasProps {
  visible: VisibleTree;
  selectedId: string | null;
  highlight: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  center: CenterRequest | null;
  /** Anchor depth offset (depths are relative to the viewer/anchor). */
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onLoadMore: (parentId: string) => void;
  label: string;
  /** How the anchor (depth 0) is named: "You" for members, "Member" in admin views. */
  rootLabel: string;
  className?: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Accessible name of a node for screen readers. */
export function describeItem(item: VisibleItem, rootLabel: string): string {
  if (item.kind === 'more') return `Load ${item.remaining} more member${item.remaining === 1 ? '' : 's'}`;
  const n = item.node;
  const parts = [
    nodeLabel(n),
    n.depth === 0 ? rootLabel.toLowerCase() : `level ${n.depth}`,
    n.statusBucket === 'ACTIVE' ? 'active' : 'inactive',
    n.hasEligibleEnrollment ? 'enrolled' : 'not enrolled',
    `${n.childCount} direct referral${n.childCount === 1 ? '' : 's'}`,
  ];
  return parts.join(', ');
}

/**
 * Interactive tree (D3 for layout + pan/zoom only; React renders the SVG). Horizontal layout:
 * depth grows to the right. Keyboard: arrows move between nodes (Right expands, Left collapses or
 * goes to the parent), Enter/Space selects or loads more, +/- zoom, 0 fits the view.
 */
export function TreeCanvas({
  visible,
  selectedId,
  highlight,
  pending,
  center,
  onToggle,
  onSelect,
  onLoadMore,
  label,
  rootLabel,
  className,
}: TreeCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const handledCenter = useRef<number | null>(null);
  const initialised = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const layout = useMemo(() => {
    if (!visible.root) return null;
    const root = hierarchy<VisibleItem>(visible.root, (d) => d.children);
    const laid = d3Tree<VisibleItem>()
      .nodeSize([NODE_H + GAP_Y, NODE_W + GAP_X])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.2))(root);
    const nodes = laid.descendants();
    return { nodes, links: laid.links(), byId: new Map(nodes.map((n) => [n.data.id, n])) };
  }, [visible]);

  const order = useMemo(() => flattenVisible(visible.root), [visible]);
  const rovingId = activeId && layout?.byId.has(activeId) ? activeId : (visible.root?.id ?? null);

  // Container size.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // d3-zoom: pan with drag, zoom with wheel/pinch. D3 owns only the transform.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      .on('zoom', (event: { transform: ZoomTransform }) => setTransform(event.transform));
    zoomRef.current = behavior;
    const selection = select(svg);
    selection.call(behavior).on('dblclick.zoom', null);
    return () => {
      selection.on('.zoom', null);
    };
  }, []);

  function applyTransform(next: ZoomTransform, animate = true) {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior) return;
    const selection = select(svg);
    if (animate && !prefersReducedMotion()) selection.transition().duration(350).call(behavior.transform, next);
    else selection.call(behavior.transform, next);
  }

  function centerTransform(node: LaidNode, k: number): ZoomTransform {
    const x = node.y + NODE_W / 2;
    const y = node.x;
    return zoomIdentity.translate(size.width / 2 - x * k, size.height / 2 - y * k).scale(k);
  }

  // Initial placement (anchor at the left, vertically centered) and centering requests.
  useEffect(() => {
    if (!layout || size.width === 0) return;
    if (center && handledCenter.current !== center.nonce) {
      const node = layout.byId.get(center.id);
      if (!node) return; // wait for the patch that adds it
      handledCenter.current = center.nonce;
      initialised.current = true;
      applyTransform(centerTransform(node, Math.max(0.8, Math.min(transform.k, 1.2))));
      return;
    }
    if (!initialised.current) {
      initialised.current = true;
      const root = layout.nodes[0];
      if (root) applyTransform(zoomIdentity.translate(24, size.height / 2 - root.x), false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transform is read, not a trigger
  }, [layout, center, size.width, size.height]);

  function fit() {
    if (!layout || size.width === 0) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of layout.nodes) {
      minX = Math.min(minX, n.y);
      maxX = Math.max(maxX, n.y + NODE_W);
      minY = Math.min(minY, n.x - NODE_H / 2);
      maxY = Math.max(maxY, n.x + NODE_H / 2);
    }
    const pad = 32;
    const k = Math.max(
      MIN_SCALE,
      Math.min(1.2, (size.width - pad * 2) / (maxX - minX || 1), (size.height - pad * 2) / (maxY - minY || 1)),
    );
    applyTransform(
      zoomIdentity
        .translate(size.width / 2 - ((minX + maxX) / 2) * k, size.height / 2 - ((minY + maxY) / 2) * k)
        .scale(k),
    );
  }

  function zoomBy(factor: number) {
    const svg = svgRef.current;
    const behavior = zoomRef.current;
    if (!svg || !behavior) return;
    const selection = select(svg);
    if (prefersReducedMotion()) selection.call(behavior.scaleBy, factor);
    else selection.transition().duration(200).call(behavior.scaleBy, factor);
  }

  /** Keeps a keyboard-focused node inside the viewport. */
  function ensureVisible(id: string) {
    const node = layout?.byId.get(id);
    if (!node) return;
    const [sx, sy] = transform.apply([node.y, node.x - NODE_H / 2]);
    const margin = 24;
    const outside =
      sx < margin ||
      sy < margin ||
      sx + NODE_W * transform.k > size.width - margin ||
      sy + NODE_H * transform.k > size.height - margin;
    if (outside) applyTransform(centerTransform(node, transform.k));
  }

  function focusItem(id: string | undefined) {
    if (!id) return;
    setActiveId(id);
    ensureVisible(id);
    requestAnimationFrame(() => nodeRefs.current.get(id)?.focus({ preventScroll: true }));
  }

  function onNodeKeyDown(event: KeyboardEvent<SVGGElement>, item: VisibleItem) {
    const index = order.findIndex((o) => o.id === item.id);
    const laid = layout?.byId.get(item.id);
    const parentId = laid?.parent?.data.id;
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
        else focusItem(parentId);
        break;
      case 'Home':
        focusItem(order[0]?.id);
        break;
      case 'End':
        focusItem(order[order.length - 1]?.id);
        break;
      case 'Enter':
      case ' ':
        if (item.kind === 'more') onLoadMore(item.parentId);
        else onSelect(item.id);
        break;
      case '+':
      case '=':
        zoomBy(1.25);
        break;
      case '-':
        zoomBy(0.8);
        break;
      case '0':
        fit();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const link = linkHorizontal<{ source: [number, number]; target: [number, number] }, [number, number]>();
  const tipId = focusedId ?? hoverId;
  const tipNode = tipId ? layout?.byId.get(tipId) : undefined;
  const tipPos = tipNode ? transform.apply([tipNode.y + NODE_W, tipNode.x - NODE_H / 2]) : null;

  return (
    <div ref={containerRef} className={cn('relative h-full min-h-[420px] overflow-hidden bg-subtle', className)}>
      <svg
        ref={svgRef}
        role="tree"
        aria-label={label}
        className="block size-full cursor-grab touch-none select-none active:cursor-grabbing"
      >
        <g transform={transform.toString()}>
          <g aria-hidden>
            {layout?.links.map((l) => {
              const onPath = highlight.has(l.source.data.id) && highlight.has(l.target.data.id);
              return (
                <path
                  key={`${l.source.data.id}-${l.target.data.id}`}
                  d={link({ source: [l.source.y + NODE_W, l.source.x], target: [l.target.y, l.target.x] }) ?? undefined}
                  className={cn('fill-none', onPath ? 'stroke-primary' : 'stroke-border')}
                  strokeWidth={onPath ? 2 : 1.25}
                />
              );
            })}
          </g>
          {layout?.nodes.map((n) => (
            <CanvasNode
              key={n.data.id}
              laid={n}
              selected={n.data.id === selectedId}
              onPath={highlight.has(n.data.id)}
              pending={pending.has(n.data.id)}
              rootLabel={rootLabel}
              tabbable={n.data.id === rovingId}
              registerRef={(el) => {
                if (el) nodeRefs.current.set(n.data.id, el);
                else nodeRefs.current.delete(n.data.id);
              }}
              onToggle={onToggle}
              onSelect={(id) => {
                setActiveId(id);
                onSelect(id);
              }}
              onLoadMore={onLoadMore}
              onKeyDown={onNodeKeyDown}
              onHover={setHoverId}
              onFocusChange={setFocusedId}
            />
          ))}
        </g>
      </svg>

      {tipNode && tipNode.data.kind === 'member' && tipPos ? (
        <NodeTooltip
          item={tipNode.data}
          left={Math.min(tipPos[0] + 8, Math.max(size.width - 232, 8))}
          top={Math.max(8, Math.min(tipPos[1], size.height - 132))}
        />
      ) : null}

      <div className="absolute top-2 right-2 flex flex-col gap-1 rounded-lg bg-card/90 p-1 shadow-xs ring-1 ring-foreground/10">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          <Plus aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
          <Minus aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Fit tree to view" onClick={fit}>
          <Maximize aria-hidden />
        </Button>
      </div>
      <p className="pointer-events-none absolute bottom-2 left-3 hidden text-xs text-muted-foreground sm:block">
        Drag to pan · scroll to zoom · arrow keys to move between members
      </p>
    </div>
  );
}

interface CanvasNodeProps {
  laid: LaidNode;
  selected: boolean;
  onPath: boolean;
  pending: boolean;
  tabbable: boolean;
  rootLabel: string;
  registerRef: (el: SVGGElement | null) => void;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onLoadMore: (parentId: string) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, item: VisibleItem) => void;
  onHover: (id: string | null) => void;
  onFocusChange: (id: string | null) => void;
}

function CanvasNode({
  laid,
  selected,
  onPath,
  pending,
  tabbable,
  rootLabel,
  registerRef,
  onToggle,
  onSelect,
  onLoadMore,
  onKeyDown,
  onHover,
  onFocusChange,
}: CanvasNodeProps) {
  const item = laid.data;
  const x = laid.y;
  const y = laid.x - NODE_H / 2;
  const level = (laid.depth ?? 0) + 1;
  const common = {
    ref: registerRef,
    role: 'treeitem' as const,
    tabIndex: tabbable ? 0 : -1,
    'aria-level': level,
    'aria-label': describeItem(item, rootLabel),
    transform: `translate(${x},${y})`,
    className: 'group cursor-pointer outline-none',
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => onKeyDown(e, item),
    onFocus: () => onFocusChange(item.id),
    onBlur: () => onFocusChange(null),
    onMouseEnter: () => onHover(item.id),
    onMouseLeave: () => onHover(null),
  };

  if (item.kind === 'more') {
    return (
      <g {...common} onClick={() => onLoadMore(item.parentId)}>
        <rect
          width={NODE_W}
          height={NODE_H}
          rx={10}
          className="fill-card stroke-input group-hover:fill-accent group-focus-visible:stroke-ring"
          strokeDasharray="5 4"
          strokeWidth={1.5}
        />
        <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" className="fill-primary text-[12px] font-medium">
          {pending ? 'Loading…' : `Load ${item.remaining} more`}
        </text>
      </g>
    );
  }

  const n = item.node;
  const inactive = n.statusBucket === 'INACTIVE';
  const limited = n.inScope === false;
  const hasChildren = n.childCount > 0;
  const meta = [
    n.depth === 0 ? rootLabel : `Level ${n.depth}`,
    inactive ? 'Inactive' : null,
    `${n.childCount} referral${n.childCount === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <g
      {...common}
      aria-selected={selected}
      aria-expanded={hasChildren ? item.expanded : undefined}
      onClick={() => onSelect(item.id)}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        className={cn(
          'transition-colors group-hover:fill-accent',
          inactive ? 'fill-muted' : 'fill-card',
          selected ? 'stroke-primary' : onPath ? 'stroke-primary/60' : 'stroke-border',
          'group-focus-visible:stroke-ring',
        )}
        strokeWidth={selected ? 2.5 : onPath ? 2 : 1.25}
        strokeDasharray={inactive ? '4 3' : undefined}
      />
      <rect x={0} y={8} width={4} height={NODE_H - 16} rx={2} style={{ fill: depthColor(n.depth) }} aria-hidden />
      <text
        x={14}
        y={21}
        className={cn('text-[12.5px] font-medium', inactive || limited ? 'fill-muted-foreground' : 'fill-foreground', limited && 'italic')}
      >
        {truncate(nodeLabel(n), n.hasEligibleEnrollment ? 19 : 22)}
      </text>
      <text x={14} y={38} className="fill-muted-foreground text-[11px]">
        {meta}
      </text>
      {n.hasEligibleEnrollment ? (
        <BadgeCheck x={NODE_W - 44} y={9} width={14} height={14} className="text-primary" aria-hidden />
      ) : null}
      {hasChildren ? (
        <g
          transform={`translate(${NODE_W},${NODE_H / 2})`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(item.id);
          }}
          aria-hidden
        >
          <circle r={10} className="fill-card stroke-input hover:fill-accent" strokeWidth={1.25} />
          <text y={4} textAnchor="middle" className="fill-foreground text-[12px] font-semibold">
            {pending ? '…' : item.expanded ? '−' : '+'}
          </text>
        </g>
      ) : null}
    </g>
  );
}

