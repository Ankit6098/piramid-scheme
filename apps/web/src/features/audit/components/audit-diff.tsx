'use client';

import type { AuditFieldChangeDto } from '@app/shared';

import { ToneBadge } from '@/components/app/status-badge';
import { cn } from '@/lib/utils';

const KIND_META: Record<AuditFieldChangeDto['kind'], { label: string; tone: 'success' | 'destructive-outline' | 'info' }> = {
  added: { label: 'Added', tone: 'success' },
  removed: { label: 'Removed', tone: 'destructive-outline' },
  changed: { label: 'Changed', tone: 'info' },
};

/** Compact, readable rendering of a JSON value from an audit snapshot. */
export function AuditValue({ value, muted }: { value: unknown; muted?: boolean }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">empty</span>;
  }
  if (typeof value === 'boolean') return <span className="font-mono text-xs">{value ? 'true' : 'false'}</span>;
  if (typeof value === 'number') return <span className="font-mono text-xs tabular-nums">{value}</span>;
  if (typeof value === 'string') {
    return <span className={cn('break-all', muted && 'text-muted-foreground')}>{value === '' ? '""' : value}</span>;
  }
  return (
    <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap break-all">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * Field-level before → after table. Emails/phones arrive masked and secrets are never stored
 * (business rules §13), so values can be shown as-is.
 */
export function AuditDiff({ changes }: { changes: readonly AuditFieldChangeDto[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-muted-foreground">No field changes were recorded for this action.</p>;
  }
  return (
    <ul className="divide-y rounded-lg border">
      {changes.map((c) => {
        const meta = KIND_META[c.kind];
        return (
          <li key={c.path} className="space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-xs font-medium break-all">{c.path}</code>
              <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">Before</p>
                <div className={cn(c.kind === 'changed' && 'line-through decoration-destructive/50')}>
                  <AuditValue value={c.before} muted />
                </div>
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">After</p>
                <AuditValue value={c.after} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
