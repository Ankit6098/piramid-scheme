'use client';

import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { PolicyIssueDto } from '@app/shared';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export interface PolicyIssueListProps {
  issues: readonly PolicyIssueDto[];
  /** Human label for an issue path (`budgetBps` → "Total reward budget"). */
  labelFor: (path: string) => string;
  /** Makes labels clickable (focus / scroll to the field). Return false when the path has no target. */
  canSelectPath?: (path: string) => boolean;
  onSelectPath?: (path: string) => void;
  /** Title for the errors block. */
  errorTitle?: string;
  warningTitle?: string;
  /**
   * `false` for lists that update while typing (no `role="alert"`, so screen readers aren't
   * interrupted on every keystroke). Default true.
   */
  announce?: boolean;
  className?: string;
}

/** Validation issues grouped into Errors (block publishing) and Warnings (informational). */
export function PolicyIssueList({
  issues,
  labelFor,
  canSelectPath,
  onSelectPath,
  errorTitle,
  warningTitle,
  announce = true,
  className,
}: PolicyIssueListProps) {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity !== 'error');
  if (errors.length === 0 && warnings.length === 0) return null;

  const renderItem = (issue: PolicyIssueDto, index: number) => {
    const label = labelFor(issue.path);
    const selectable = onSelectPath && (canSelectPath ? canSelectPath(issue.path) : true);
    return (
      <li key={`${issue.path}-${issue.code ?? ''}-${index}`} className="leading-snug">
        {selectable ? (
          <button
            type="button"
            onClick={() => onSelectPath(issue.path)}
            className="font-medium text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid focus-visible:outline-2 focus-visible:outline-ring"
          >
            {label}
          </button>
        ) : (
          <span className="font-medium text-foreground">{label}</span>
        )}
        <span className="text-muted-foreground">: {issue.message}</span>
      </li>
    );
  };

  return (
    <div className={cn('space-y-3', className)}>
      {errors.length > 0 ? (
        <Alert variant="destructive" role={announce ? 'alert' : undefined}>
          <CircleAlert aria-hidden />
          <AlertTitle>
            {errorTitle ??
              `${errors.length} ${errors.length === 1 ? 'error' : 'errors'} to fix before publishing`}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{errors.map(renderItem)}</ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {warnings.length > 0 ? (
        <Alert className="border-warning/30 bg-warning/5" role={announce ? 'status' : undefined}>
          <TriangleAlert aria-hidden className="text-warning" />
          <AlertTitle className="text-warning">
            {warningTitle ??
              `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'} (publishing is still allowed)`}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{warnings.map(renderItem)}</ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
