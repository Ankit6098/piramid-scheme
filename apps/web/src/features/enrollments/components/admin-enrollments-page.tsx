'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { AdminProgramSummaryDto } from '@app/shared';

import { PageHeader } from '@/components/app/page-header';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { AdminEnrollmentsTable } from './admin-enrollments-table';

/** /admin/enrollments — queue of enrollments to activate (offline payments) or reject. */
export function AdminEnrollmentsPage() {
  // Programs the admin may see, for the program filter (program admins: assigned ones only).
  const programs = useQuery({
    queryKey: queryKeys.admin.programs({ purpose: 'enrollment-filter' }),
    queryFn: ({ signal }) => api.getPage<AdminProgramSummaryDto>('/admin/programs', { query: { limit: 100 }, signal }),
    staleTime: 60_000,
  });
  const programOptions = useMemo(
    () => (programs.data?.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [programs.data],
  );

  return (
    <div>
      <PageHeader
        title="Enrollments"
        description="Members enroll in program plans. Free plans activate immediately; paid plans wait here until you record the offline payment. Plan payments never generate rewards."
      />
      <AdminEnrollmentsTable programOptions={programOptions} />
    </div>
  );
}
