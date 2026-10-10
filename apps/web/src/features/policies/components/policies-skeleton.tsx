/** Prerender-safe skeletons for the reward-policies page (no hooks — usable from loading.tsx). */
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function PolicyTimelineSkeleton({ items = 3 }: { items?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: items }, (_, i) => (
        <Card key={i} size="sm" className="gap-2 px-3">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-40" />
        </Card>
      ))}
    </div>
  );
}

export function PolicyDetailSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-4', className)} aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="h-4 w-56 max-w-full" />
      </div>
      <Card className="gap-4 px-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </Card>
      <Card className="gap-3 px-4">
        <Skeleton className="h-5 w-40" />
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </Card>
    </div>
  );
}

export function PoliciesPageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading reward policies">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <PolicyTimelineSkeleton />
        <PolicyDetailSkeleton />
      </div>
    </div>
  );
}
