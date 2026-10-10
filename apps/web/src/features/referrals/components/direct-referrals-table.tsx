'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { DirectReferralDto, MemberStatusBucket } from '@app/shared';

import { DataTable } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { SectionHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { routes } from '@/config/routes';

import { useDirectReferrals } from '../api';
import { EnrollmentIndicator, MemberStatusBadge } from './member-status';

const columns: ColumnDef<DirectReferralDto>[] = [
  {
    id: 'member',
    header: 'Member',
    cell: ({ row }) => (
      <div className="flex items-center gap-2.5">
        <UserAvatar name={row.original.displayName} size="sm" />
        <Link
          href={`${routes.member.team}?focus=${row.original.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {row.original.displayName}
        </Link>
      </div>
    ),
  },
  {
    id: 'attributedAt',
    header: 'Joined your network',
    cell: ({ row }) => <DateTime value={row.original.attributedAt} style="date" />,
  },
  {
    id: 'status',
    header: 'Account',
    cell: ({ row }) => <MemberStatusBadge value={row.original.statusBucket} />,
  },
  {
    id: 'enrollment',
    header: 'Enrollment',
    cell: ({ row }) => <EnrollmentIndicator eligible={row.original.hasEligibleEnrollment} />,
  },
  {
    id: 'childCount',
    header: 'Their referrals',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="tabular-nums">{row.original.childCount}</span>,
  },
];

type StatusFilter = MemberStatusBucket | 'ALL';

/** The member's direct referrals (privacy-filtered), with a mobile card layout. */
export function DirectReferralsTable() {
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const list = useDirectReferrals(status === 'ALL' ? {} : { status });

  return (
    <section aria-labelledby="direct-referrals-heading">
      <SectionHeader
        title={<span id="direct-referrals-heading">Direct referrals</span>}
        description="Members who registered with your link. Only first names and last initials are shown."
      />
      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        caption="Your direct referrals"
        toolbar={
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Filter by account status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All accounts</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="INACTIVE">Inactive</SelectItem>
            </SelectContent>
          </Select>
        }
        emptyState={
          status === 'ALL' ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={UserPlus}
              title="No direct referrals yet"
              description="When someone registers with your link, they appear here."
            />
          ) : (
            <EmptyState
              variant="plain"
              size="sm"
              title="No matching referrals"
              description="No direct referrals have this account status."
              action={
                <Button variant="outline" size="sm" onClick={() => setStatus('ALL')}>
                  Show all
                </Button>
              }
            />
          )
        }
        renderCard={(r) => (
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <UserAvatar name={r.displayName} size="sm" />
              <div className="min-w-0">
                <Link href={`${routes.member.team}?focus=${r.id}`} className="font-medium hover:underline">
                  {r.displayName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  Joined <DateTime value={r.attributedAt} style="date" /> · {r.childCount} referral
                  {r.childCount === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <MemberStatusBadge value={r.statusBucket} />
              <EnrollmentIndicator eligible={r.hasEligibleEnrollment} className="text-xs text-muted-foreground" />
            </div>
          </div>
        )}
      />
    </section>
  );
}
