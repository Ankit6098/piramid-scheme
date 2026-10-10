'use client';

import { Info, Layers } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { MemberProgramDto } from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { CardSkeleton, EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MyEnrollments } from '@/features/enrollments/components/my-enrollments';
import { queryKeys } from '@/lib/query-keys';

import { MEMBER_PROGRAMS_PATH } from '../../api';
import { ProgramCard } from './program-card';

type Tab = 'browse' | 'enrollments';

/** /programs — browse programs (cards) and "My enrollments". */
export function MemberProgramsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: Tab = params.get('tab') === 'enrollments' ? 'enrollments' : 'browse';
  const setTab = (next: string) => router.replace(next === 'enrollments' ? `${pathname}?tab=enrollments` : pathname, { scroll: false });

  return (
    <div>
      <PageHeader
        title="Programs"
        description="Programs give you access to approved products and services through a plan. Plan prices pay for that access — enrolling never earns rewards. Rewards come only from qualifying sales of the program’s offering."
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="enrollments">My enrollments</TabsTrigger>
        </TabsList>
        <TabsContent value="browse">
          <ProgramCatalogue />
        </TabsContent>
        <TabsContent value="enrollments">
          <MyEnrollments
            emptyAction={
              <Button variant="outline" onClick={() => setTab('browse')}>
                Browse programs
              </Button>
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProgramCatalogue() {
  const list = useCursorList<MemberProgramDto>({ queryKey: queryKeys.programs.list(), path: MEMBER_PROGRAMS_PATH, pageSize: 24 });

  if (list.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <CardSkeleton key={i} lines={4} />
        ))}
      </div>
    );
  }
  if (list.error && list.rows.length === 0) return <ErrorState error={list.error} onRetry={list.refetch} />;
  if (list.rows.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="No programs available right now"
        description="When a program opens for enrollment it will appear here."
      />
    );
  }
  return (
    <div className="space-y-4">
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {list.rows.map((p) => (
          <li key={p.id}>
            <ProgramCard program={p} />
          </li>
        ))}
      </ul>
      {list.pagination.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={list.pagination.fetchNextPage} disabled={list.pagination.isFetchingNextPage}>
            {list.pagination.isFetchingNextPage ? <Spinner aria-hidden /> : null}
            Load more
          </Button>
        </div>
      ) : null}
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Prices are shown in each program’s currency. There are no guaranteed or projected earnings on this platform.
      </p>
    </div>
  );
}
