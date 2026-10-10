'use client';

import { Bot } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { CopyButton } from '@/components/app/copy-button';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { ToneBadge } from '@/components/app/status-badge';
import { UserAvatar } from '@/components/app/user-avatar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { routes } from '@/config/routes';

import { useAuditEntry } from '../api';
import { auditActionLabel, resourceTypeLabel } from '../format';
import { AuditDiff, AuditValue } from './audit-diff';

export interface AuditDetailSheetProps {
  entryId: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Drawer with one audit entry: who, what, why, request metadata and a readable before/after diff. */
export function AuditDetailSheet({ entryId, onOpenChange }: AuditDetailSheetProps) {
  const { data: entry, isPending, error, refetch } = useAuditEntry(entryId);
  return (
    <Sheet open={Boolean(entryId)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>{entry ? auditActionLabel(entry.action) : 'Audit entry'}</SheetTitle>
          <SheetDescription>
            {entry ? (
              <>
                <code className="font-mono text-xs">{entry.action}</code> ·{' '}
                <DateTime value={entry.createdAt} style="long" />
              </>
            ) : (
              'Loading entry details'
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {error ? (
            <ErrorState error={error} onRetry={() => void refetch()} variant="plain" />
          ) : isPending || !entry ? (
            <div className="space-y-3" aria-busy>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
              <span className="sr-only">Loading audit entry</span>
            </div>
          ) : (
            <>
              <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
                <Meta label="Actor">
                  {entry.actor ? (
                    <span className="flex items-center gap-2">
                      <UserAvatar name={entry.actor.fullName} size="sm" />
                      <Link href={`${routes.admin.members}/${entry.actor.id}`} className="font-medium hover:underline">
                        {entry.actor.fullName}
                      </Link>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Bot className="size-4" aria-hidden /> System
                    </span>
                  )}
                </Meta>
                <Meta label="Roles at the time">
                  {entry.actorRoles.length ? (
                    <span className="flex flex-wrap gap-1">
                      {entry.actorRoles.map((r) => (
                        <ToneBadge key={r} tone="neutral">
                          {r.replace(/_/g, ' ').toLowerCase()}
                        </ToneBadge>
                      ))}
                    </span>
                  ) : (
                    '—'
                  )}
                </Meta>
                <Meta label="Resource">
                  {resourceTypeLabel(entry.resourceType)}
                  {entry.resourceId ? (
                    <span className="mt-0.5 flex items-center gap-1">
                      <code className="truncate font-mono text-xs text-muted-foreground">{entry.resourceId}</code>
                      <CopyButton value={entry.resourceId} label="resource id" variant="ghost" size="icon-xs" />
                    </span>
                  ) : null}
                </Meta>
                <Meta label="Program">{entry.program?.name ?? '—'}</Meta>
                <Meta label="Request id">
                  {entry.requestId ? (
                    <span className="flex items-center gap-1">
                      <code className="truncate font-mono text-xs">{entry.requestId}</code>
                      <CopyButton value={entry.requestId} label="request id" variant="ghost" size="icon-xs" />
                    </span>
                  ) : (
                    '—'
                  )}
                </Meta>
                <Meta label="IP address">{entry.ipAddress ?? '—'}</Meta>
              </dl>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Reason</h3>
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm whitespace-pre-line">
                  {entry.reason ?? <span className="text-muted-foreground">No reason recorded</span>}
                </p>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">
                  Changes <span className="font-normal text-muted-foreground">({entry.changes.length})</span>
                </h3>
                <AuditDiff changes={entry.changes} />
              </section>

              <Separator />
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm">
                    Show raw snapshots
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs text-muted-foreground">Before</p>
                    <AuditValue value={entry.before} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs text-muted-foreground">After</p>
                    <AuditValue value={entry.after} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
