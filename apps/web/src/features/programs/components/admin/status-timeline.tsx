'use client';

import { ArrowRight, Bot, UserRound } from 'lucide-react';
import type { ProgramStatusChangeDto } from '@app/shared';

import { DateTime, RelativeTime } from '@/components/app/date-time';
import { StatusBadge } from '@/components/app/status-badge';

/** Vertical timeline of program status changes (newest first). */
export function StatusTimeline({ changes, timeZone }: { changes: readonly ProgramStatusChangeDto[]; timeZone: string }) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">No status changes yet.</p>;
  return (
    <ol className="relative space-y-5 border-l pl-5">
      {changes.map((c) => (
        <li key={c.id} className="relative">
          <span
            aria-hidden
            className="absolute top-1 -left-[1.6875rem] flex size-3 items-center justify-center rounded-full border-2 border-background bg-primary"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {c.fromStatus ? (
              <>
                <StatusBadge kind="ProgramStatus" value={c.fromStatus} />
                <ArrowRight className="size-3.5 text-muted-foreground" aria-label="to" />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Created as</span>
            )}
            <StatusBadge kind="ProgramStatus" value={c.toStatus} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <DateTime value={c.changedAt} timeZone={timeZone} showTimeZone />
            <span aria-hidden>·</span>
            <RelativeTime value={c.changedAt} />
            <span aria-hidden>·</span>
            {c.changedBy ? (
              <span className="inline-flex items-center gap-1">
                <UserRound className="size-3" aria-hidden />
                {c.changedBy.fullName}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Bot className="size-3" aria-hidden />
                Automatic (scheduler)
              </span>
            )}
          </p>
          {c.reason ? <p className="mt-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-sm">{c.reason}</p> : null}
        </li>
      ))}
    </ol>
  );
}
