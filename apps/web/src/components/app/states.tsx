/**
 * Shared loading / empty / permission / not-found states. Server-compatible (no hooks), so they can
 * be used in `loading.tsx`, `not-found.tsx` and Suspense fallbacks. `ErrorState` lives in
 * `error-state.tsx` (client: retry + copy request id).
 */
import type { LucideIcon } from 'lucide-react';
import { FileQuestion, Inbox, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

// ─── Loading ─────────────────────────────────────────────────────────────────

/** Centered spinner with a label. Prefer skeletons that match the final layout when possible. */
export function LoadingState({
  label = 'Loading…',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-muted-foreground',
        className,
      )}
    >
      <Spinner className="size-5" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

const ROW_WIDTHS = ['w-3/4', 'w-2/3', 'w-5/6', 'w-1/2', 'w-4/5', 'w-3/5'];

/** Header + KPI row + table — default fallback for whole pages. */
export function PageSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-6', className)} role="status" aria-label="Loading page">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <StatGridSkeleton />
      <TableSkeleton />
    </div>
  );
}

export function StatGridSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} size="sm" className="gap-3 px-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-3 w-20" />
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 py-0', className)} aria-hidden>
      <div className="flex gap-4 border-b px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b px-4 py-3.5 last:border-0">
          {Array.from({ length: columns }, (_, c) => (
            <div key={c} className="flex-1">
              <Skeleton className={cn('h-4', ROW_WIDTHS[(r + c) % ROW_WIDTHS.length])} />
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

export function FormSkeleton({ fields = 4, className }: { fields?: number; className?: string }) {
  return (
    <div className={cn('space-y-5', className)} aria-hidden>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
      <Skeleton className="h-8 w-24" />
    </div>
  );
}

/** Card with a few text lines — for detail panels and side cards. */
export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Card className={cn('gap-3 px-4', className)} aria-hidden>
      <Skeleton className="h-5 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', ROW_WIDTHS[i % ROW_WIDTHS.length])} />
      ))}
    </Card>
  );
}

// ─── Empty ───────────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Call to action (a Button or Link button). */
  action?: ReactNode;
  /** `card` adds a dashed border (stand-alone sections); `plain` sits inside an existing card. */
  variant?: 'card' | 'plain';
  size?: 'sm' | 'default';
  className?: string;
}

/** Nothing-here-yet state. Say what will appear here and how to get it. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  variant = 'card',
  size = 'default',
  className,
}: EmptyStateProps) {
  return (
    <Empty
      className={cn(
        variant === 'card' && 'border bg-card',
        size === 'sm' ? 'gap-3 p-4 md:p-6' : 'p-8 md:p-12',
        className,
      )}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

// ─── Permission / not found ──────────────────────────────────────────────────

export interface PermissionDeniedProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Where the "back" button goes. */
  backHref?: string;
  backLabel?: string;
  className?: string;
}

/** Shown when the signed-in user lacks a permission (UI guard; the API enforces it too). */
export function PermissionDenied({
  title = "You don't have access to this page",
  description = "Your account doesn't have the permission this area needs. If you think that's a mistake, ask a Super Admin to review your roles.",
  backHref = '/dashboard',
  backLabel = 'Back to dashboard',
  className,
}: PermissionDeniedProps) {
  return (
    <EmptyState
      icon={ShieldAlert}
      title={title}
      description={description}
      className={className}
      action={
        <Button asChild variant="outline">
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      }
    />
  );
}

export function NotFoundState({
  title = "We couldn't find that page",
  description = 'It may have been moved or deleted, or the link might be wrong.',
  backHref = '/',
  backLabel = 'Go home',
  className,
}: PermissionDeniedProps) {
  return (
    <EmptyState
      icon={FileQuestion}
      title={title}
      description={description}
      className={className}
      action={
        <Button asChild variant="outline">
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      }
    />
  );
}
