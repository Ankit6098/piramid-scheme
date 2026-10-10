'use client';

import { ArrowLeft, Globe, Plus, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatBps, Permission, POLICY_HARD_CAP_BPS } from '@app/shared';

import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState, NotFoundState, PermissionDenied } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';
import { isApiError } from '@/lib/api-client';

import { usePolicyContext, usePolicyVersions } from '../api';
import { usePolicySelection } from '../hooks';
import { PolicyComplianceCallout } from './compliance-callout';
import { NewDraftDialog } from './new-draft-dialog';
import { PolicyDetailPanel } from './policy-detail-panel';
import { PolicyTimeline } from './policy-timeline';
import {
  PoliciesPageSkeleton,
  PolicyDetailSkeleton,
  PolicyTimelineSkeleton,
} from './policies-skeleton';

const DETAIL_ID = 'policy-version-detail';
const DISCARD_MESSAGE = 'You have unsaved changes in this draft. Discard them and switch versions?';

/** /admin/programs/[id]/policies — versions timeline + detail/editor for one program. */
export function PoliciesPage() {
  const params = useParams<{ id: string }>();
  const programId = params.id;
  const { can } = useSession();
  const canWrite = can(Permission.PoliciesWrite);
  const contextQuery = usePolicyContext(programId);
  const versions = usePolicyVersions(programId, contextQuery.isSuccess);
  const { selectedId: requestedId, select, hrefFor } = usePolicySelection();
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);

  const programHref = `${routes.admin.programs}/${encodeURIComponent(programId)}`;

  /** Programmatic selection (after create / clone): asks before dropping unsaved draft edits. */
  const guardedSelect = (id: string | null) => {
    if (editorDirty && !window.confirm(DISCARD_MESSAGE)) return;
    select(id);
  };

  if (contextQuery.isPending) return <PoliciesPageSkeleton />;

  if (!contextQuery.data) {
    const error = contextQuery.error;
    if (isApiError(error) && error.isNotFound) {
      return (
        <NotFoundState
          title="Program not found"
          description="It may have been deleted, or the link might be wrong."
          backHref={routes.admin.programs}
          backLabel="Back to programs"
        />
      );
    }
    if (isApiError(error) && error.isForbidden && !error.isMfaRequired) {
      return (
        <PermissionDenied
          title="You don't have access to this program"
          description="Program admins can only manage programs they are assigned to. Ask a Super Admin if you need access."
          backHref={routes.admin.programs}
          backLabel="Back to programs"
        />
      );
    }
    return <ErrorState error={error} onRetry={() => void contextQuery.refetch()} />;
  }

  const context = contextQuery.data;
  const program = context.program;
  const hardCapBps = context.hardCapBps || POLICY_HARD_CAP_BPS;
  const rows = versions.rows;
  const selectedId =
    requestedId ??
    context.currentVersionId ??
    context.nextScheduledVersionId ??
    rows[0]?.id ??
    null;

  return (
    <div>
      <PageHeader
        title="Reward policies"
        description={
          <>
            Effective-dated rules that decide how the reward budget of a qualifying sale of{' '}
            <Link href={programHref} className="font-medium text-foreground hover:underline">
              {program.name}
            </Link>{' '}
            is shared across levels.
          </>
        }
        meta={
          <>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{program.code}</code>
            <StatusBadge kind="ProgramStatus" value={program.status} />
            <ToneBadge tone="neutral" dot={false}>
              {program.rewardUnit === 'POINTS'
                ? `Rewards in ${context.pointsLabel}`
                : `Rewards in ${program.currencyCode}`}
            </ToneBadge>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Globe className="size-3.5" aria-hidden />
              {program.timezone}
            </span>
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={programHref}>
                <ArrowLeft aria-hidden />
                Program
              </Link>
            </Button>
            {canWrite ? (
              <Button type="button" onClick={() => setNewDraftOpen(true)}>
                <Plus aria-hidden />
                New draft
              </Button>
            ) : null}
          </>
        }
      />

      <PolicyComplianceCallout hardCapLabel={formatBps(hardCapBps)} className="mb-6" />

      {versions.isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <PolicyTimelineSkeleton />
          <PolicyDetailSkeleton />
        </div>
      ) : versions.error && rows.length === 0 ? (
        <ErrorState error={versions.error} onRetry={versions.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No reward policy yet"
          description={
            canWrite
              ? 'Create a draft, define how the reward budget of a sale is shared across levels, then publish it. Sales are rejected until a version is in effect.'
              : 'No policy has been created for this program yet. Sales are rejected until a version is in effect.'
          }
          action={
            canWrite ? (
              <Button type="button" onClick={() => setNewDraftOpen(true)}>
                <Plus aria-hidden />
                Create first draft
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <PolicyTimeline
            className="lg:sticky lg:top-20 lg:max-h-[calc(100svh-6rem)] lg:overflow-y-auto lg:p-1"
            versions={rows}
            selectedId={selectedId}
            hrefFor={(id) => hrefFor(id)}
            timeZone={program.timezone}
            detailId={DETAIL_ID}
            hasNextPage={versions.pagination.hasNextPage}
            isFetchingNextPage={versions.pagination.isFetchingNextPage}
            fetchNextPage={versions.pagination.fetchNextPage}
            isFetching={versions.isFetching}
          />
          <div id={DETAIL_ID} className="min-w-0 scroll-mt-20">
            {selectedId ? (
              <PolicyDetailPanel
                key={selectedId}
                policyId={selectedId}
                programId={program.id}
                context={context}
                versions={rows}
                onSelect={select}
                onDirtyChange={setEditorDirty}
              />
            ) : null}
          </div>
        </div>
      )}

      {canWrite ? (
        <NewDraftDialog
          open={newDraftOpen}
          onOpenChange={setNewDraftOpen}
          programId={programId}
          versions={rows}
          defaultSourceId={
            context.currentVersionId ?? context.nextScheduledVersionId ?? rows[0]?.id
          }
          onCreated={(draft) => guardedSelect(draft.id)}
        />
      ) : null}
    </div>
  );
}
