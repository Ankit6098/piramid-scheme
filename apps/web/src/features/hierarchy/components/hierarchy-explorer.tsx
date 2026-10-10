'use client';

import { AlertTriangle, ChevronRight, List, Network, Undo2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

import { ErrorState } from '@/components/app/error-state';
import { EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { routes } from '@/config/routes';
import { useIsMobile } from '@/hooks/use-mobile';

import { MAX_RENDERED_NODES, nodeLabel } from '../model';
import type { HierarchySource } from '../types';
import { useHierarchyExplorer } from '../use-hierarchy-explorer';
import { NodeDetailsPanel } from './node-details-panel';
import { TeamSearch } from './team-search';
import { TreeCanvas } from './tree-canvas';
import { TreeOutline } from './tree-outline';

export interface HierarchyExplorerProps {
  source: HierarchySource;
  /** Member id to focus once the tree has loaded (e.g. `?focus=` from the referrals list). */
  initialFocusId?: string | null;
  /** Extra controls next to the view toggle. */
  actions?: ReactNode;
}

type View = 'tree' | 'list';

/**
 * The interactive team hierarchy: D3 tree (pan/zoom, lazy expand, load-more nodes, search with
 * focus + path highlight, tooltips, keyboard navigation) or an accessible outline list (default on
 * mobile), breadcrumbs to the selected member and a details side panel.
 */
export function HierarchyExplorer({ source, initialFocusId, actions }: HierarchyExplorerProps) {
  const explorer = useHierarchyExplorer(source);
  const isMobile = useIsMobile();
  const [view, setView] = useState<View | null>(null);
  const effectiveView: View = view ?? (isMobile ? 'list' : 'tree');
  const rootLabel = source.admin ? 'Member' : 'You';
  const label = source.admin ? "Member's team" : 'Your team';

  // Focus a member requested via the URL once the initial tree is available.
  const focusedOnce = useRef<string | null>(null);
  const { status, focusMember } = explorer;
  useEffect(() => {
    if (status !== 'success' || !initialFocusId || focusedOnce.current === initialFocusId) return;
    focusedOnce.current = initialFocusId;
    const handle = setTimeout(() => void focusMember(initialFocusId), 0);
    return () => clearTimeout(handle);
  }, [status, initialFocusId, focusMember]);

  if (explorer.status === 'pending') {
    return (
      <div className="space-y-3" role="status" aria-label="Loading team">
        <div className="flex flex-wrap justify-between gap-2">
          <Skeleton className="h-8 w-full max-w-sm" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-[520px] w-full rounded-xl" />
      </div>
    );
  }
  if (explorer.status === 'error') {
    return <ErrorState error={explorer.error} onRetry={explorer.refetch} />;
  }

  const root = explorer.model.rootId ? explorer.model.nodes[explorer.model.rootId] : undefined;
  if (!root || root.childCount === 0) {
    return source.admin ? (
      <EmptyState icon={Network} title="No team members" description="Nobody has registered with this member's referral link." />
    ) : (
      <EmptyState
        icon={UserPlus}
        title="Your team is empty"
        description="Members who register with your referral link — and the members they refer — appear here."
        action={
          <Button asChild>
            <Link href={routes.member.referrals}>Get your referral link</Link>
          </Button>
        }
      />
    );
  }

  const selected = explorer.selectedId ? (explorer.model.nodes[explorer.selectedId] ?? null) : null;
  const commonProps = {
    visible: explorer.visible,
    selectedId: explorer.selectedId,
    highlight: explorer.highlight,
    pending: explorer.pending,
    onToggle: explorer.toggle,
    onSelect: explorer.select,
    onLoadMore: (id: string) => void explorer.loadMore(id),
    label,
    rootLabel,
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <TeamSearch source={source} onPick={(r) => void explorer.focusMember(r.id)} />
        <div className="flex flex-wrap items-center gap-2">
          {explorer.isViewRootCustom ? (
            <Button type="button" variant="outline" size="sm" onClick={() => explorer.showFrom(null)}>
              <Undo2 aria-hidden />
              Show whole team
            </Button>
          ) : null}
          {actions}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={effectiveView}
            onValueChange={(v) => {
              if (v) setView(v as View);
            }}
            aria-label="Team view"
          >
            <ToggleGroupItem value="tree" aria-label="Tree view">
              <Network aria-hidden />
              <span className="hidden sm:inline">Tree</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view">
              <List aria-hidden />
              <span className="hidden sm:inline">List</span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <nav aria-label="Path to the selected member" className="min-h-6">
        {explorer.selectedPath.length > 0 ? (
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {explorer.selectedPath.map((id, i) => {
              const n = explorer.model.nodes[id];
              if (!n) return null;
              const last = i === explorer.selectedPath.length - 1;
              return (
                <Fragment key={id}>
                  <li className="flex items-center gap-1">
                    {i > 0 ? <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden /> : null}
                    {last ? (
                      <span aria-current="location" className="rounded px-1.5 py-0.5 font-medium text-foreground">
                        {nodeLabel(n)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => {
                          explorer.select(id);
                          explorer.centerOn(id);
                        }}
                      >
                        {n.depth === 0 ? rootLabel : nodeLabel(n)}
                      </button>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Select a member to see their path from {source.admin ? 'this member' : 'you'}.</p>
        )}
      </nav>

      {explorer.visible.capped || explorer.serverTruncated ? (
        <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {explorer.visible.capped
            ? `Showing the first ${MAX_RENDERED_NODES} members. Collapse branches, use “Show branch only” or search to see the rest.`
            : 'Some deep branches were not loaded yet — expand them to load more.'}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="h-[560px] gap-0 overflow-hidden py-0">
          {effectiveView === 'tree' ? (
            <TreeCanvas {...commonProps} center={explorer.center} className="h-full" />
          ) : (
            <TreeOutline {...commonProps} />
          )}
        </Card>
        <NodeDetailsPanel
          node={selected}
          admin={source.admin}
          rootLabel={rootLabel}
          isViewRoot={selected?.id === explorer.viewRootId}
          onShowFrom={(id) => explorer.showFrom(id)}
          onCenter={(id) => {
            if (effectiveView === 'list') setView('tree');
            explorer.centerOn(id);
          }}
          className="self-start"
        />
      </div>
    </div>
  );
}
