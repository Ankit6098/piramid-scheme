'use client';

import { FileQuestion } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import {
  Permission,
  type PolicyContextDto,
  type PolicyVersionDto,
  type PolicyVersionSummaryDto,
} from '@app/shared';

import { RelativeTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/use-session';
import { isApiError } from '@/lib/api-client';

import { usePolicyVersion } from '../api';
import { EffectiveRange, PolicyPhaseBadge } from './policy-badges';
import { PolicyDraftEditor } from './policy-draft-editor';
import { PolicyDetailSkeleton } from './policies-skeleton';
import { PolicyReadOnlyView } from './policy-readonly-view';
import { PolicyVersionActions } from './policy-version-actions';

export interface PolicyDetailPanelProps {
  policyId: string;
  programId: string;
  context: PolicyContextDto;
  versions: readonly PolicyVersionSummaryDto[];
  /** Select another version (`null` = default selection). */
  onSelect: (id: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Selected version: header + editor (DRAFT with `policies:write`) or read-only view + actions. */
export function PolicyDetailPanel({
  policyId,
  programId,
  context,
  versions,
  onSelect,
  onDirtyChange,
}: PolicyDetailPanelProps) {
  const { can } = useSession();
  const query = usePolicyVersion(policyId);
  const headingId = useId();

  if (query.isPending) return <PolicyDetailSkeleton />;

  const missing =
    (query.error && isApiError(query.error) && query.error.isNotFound) ||
    (query.data !== undefined && query.data.programId !== programId);
  if (missing) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Version not found"
        description="It may have been deleted (drafts can be deleted) or the link points to another program."
        action={
          <Button type="button" variant="outline" onClick={() => onSelect(null)}>
            Show the current version
          </Button>
        }
      />
    );
  }
  if (!query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const policy = query.data;
  const editable = policy.status === 'DRAFT' && can(Permission.PoliciesWrite);

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-6">
      <PolicyDetailHeader
        policy={policy}
        headingId={headingId}
        actions={
          policy.status !== 'DRAFT' ? (
            <PolicyVersionActions
              policy={policy}
              versions={versions}
              onCloned={(draft) => onSelect(draft.id)}
            />
          ) : null
        }
      />
      {editable ? (
        <PolicyDraftEditor
          key={policy.id}
          policy={policy}
          context={context}
          versions={versions}
          onDirtyChange={onDirtyChange}
          onDeleted={() => onSelect(null)}
          onPublished={(result) => onSelect(result.policy.id)}
        />
      ) : (
        <PolicyReadOnlyView policy={policy} context={context} />
      )}
    </section>
  );
}

function PolicyDetailHeader({
  policy,
  headingId,
  actions,
}: {
  policy: PolicyVersionDto;
  headingId: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Version {policy.version}
          </span>
          <PolicyPhaseBadge phase={policy.phase} />
        </div>
        <h2
          id={headingId}
          className="font-heading text-lg font-semibold tracking-tight break-words"
        >
          {policy.name}
        </h2>
        <p className="text-sm text-muted-foreground">
          {policy.status === 'DRAFT' ? (
            <>
              Draft · last saved{' '}
              <RelativeTime value={policy.updatedAt} timeZone={policy.program.timezone} />
              {policy.createdBy ? ` · created by ${policy.createdBy.fullName}` : ''}
            </>
          ) : (
            <EffectiveRange
              phase={policy.phase}
              effectiveFrom={policy.effectiveFrom}
              effectiveTo={policy.effectiveTo}
              timeZone={policy.program.timezone}
              showTimeZone
            />
          )}
        </p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
