'use client';

import { Globe } from 'lucide-react';
import Link from 'next/link';
import { formatBps, type PolicyVersionSummaryDto } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { isStackedLayout, scrollToElement } from '../hooks';
import { approvalModeLabel, phaseMeta } from '../labels';
import { EffectiveRange, PolicyPhaseBadge, TONE_DOT_CLASS } from './policy-badges';

export interface PolicyTimelineProps {
  versions: readonly PolicyVersionSummaryDto[];
  selectedId: string | null;
  hrefFor: (id: string) => string;
  /** Program time zone (IANA) — ranges are shown in it. */
  timeZone: string;
  /** Element id of the detail panel (scrolled into view on small screens after a selection). */
  detailId: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  isFetching?: boolean;
  className?: string;
}

/** Vertical timeline of all versions, newest first. Each entry links to `?version=<id>`. */
export function PolicyTimeline({
  versions,
  selectedId,
  hrefFor,
  timeZone,
  detailId,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  isFetching,
  className,
}: PolicyTimelineProps) {
  return (
    <nav aria-labelledby="policy-versions-heading" className={cn('space-y-3', className)}>
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 id="policy-versions-heading" className="font-heading text-base font-semibold">
            Versions
          </h2>
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Globe className="size-3" aria-hidden />
            Times in {timeZone}
          </p>
        </div>
        {isFetching && !isFetchingNextPage ? (
          <Spinner className="size-4 text-muted-foreground" aria-label="Refreshing versions" />
        ) : null}
      </div>

      <ol className="relative space-y-3 before:absolute before:top-3 before:bottom-3 before:left-[0.4375rem] before:w-px before:bg-border">
        {versions.map((version) => {
          const selected = version.id === selectedId;
          const tone = phaseMeta(version.phase).tone;
          return (
            <li key={version.id} className="relative pl-6">
              <span
                aria-hidden
                className={cn(
                  'absolute top-4 left-0 size-3.5 rounded-full ring-4 ring-background',
                  TONE_DOT_CLASS[tone],
                )}
              />
              <Link
                href={hrefFor(version.id)}
                replace
                scroll={false}
                aria-current={selected ? 'true' : undefined}
                onClick={() => {
                  if (isStackedLayout()) scrollToElement(detailId);
                }}
                className={cn(
                  'block rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected && 'bg-primary/5 ring-2 ring-primary hover:bg-primary/5',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">
                      Version {version.version}
                    </p>
                    <p className="truncate font-medium text-foreground">{version.name}</p>
                  </div>
                  <PolicyPhaseBadge phase={version.phase} />
                </div>

                <EffectiveRange
                  phase={version.phase}
                  effectiveFrom={version.effectiveFrom}
                  effectiveTo={version.effectiveTo}
                  timeZone={timeZone}
                  className="mt-2 text-xs"
                />

                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Budget</dt>
                    <dd className="font-medium tabular-nums">{formatBps(version.budgetBps)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Depth</dt>
                    <dd className="font-medium tabular-nums">{version.maxDepth}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Levels</dt>
                    <dd className="font-medium tabular-nums">{version.ruleCount}</dd>
                  </div>
                </dl>

                <p className="mt-2 text-xs text-muted-foreground">
                  {approvalModeLabel(version.requiresApproval)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {version.publishedAt ? (
                    <>
                      Published
                      {version.publishedBy ? ` by ${version.publishedBy.fullName}` : ''} on{' '}
                      <DateTime value={version.publishedAt} timeZone={timeZone} style="date" />
                    </>
                  ) : (
                    <>
                      Created
                      {version.createdBy ? ` by ${version.createdBy.fullName}` : ''} on{' '}
                      <DateTime value={version.createdAt} timeZone={timeZone} style="date" />
                    </>
                  )}
                </p>
              </Link>
            </li>
          );
        })}
      </ol>

      {hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-6"
          onClick={fetchNextPage}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? <Spinner aria-hidden /> : null}
          Load older versions
        </Button>
      ) : null}
    </nav>
  );
}
