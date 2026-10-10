'use client';

import { Archive, Ban, CheckCircle2, CirclePause, CirclePlay, Flag, MoreHorizontal, Pencil, Rocket, Trash2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Permission, type AdminProgramDetailDto, type ProgramLifecycleAction } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DateTime } from '@/components/app/date-time';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useNow } from '@/hooks/use-now';
import { useSession } from '@/hooks/use-session';
import { isApiError } from '@/lib/api-client';

import { useDeleteProgram, useProgramLifecycle } from '../../api';
import { programHref, PROGRAMS_HREF } from './program-links';

interface ActionCopy {
  label: string;
  title: string;
  description: string;
  confirm: string;
  icon: typeof Rocket;
  destructive?: boolean;
  reason: 'required' | 'optional';
  /** Toast after success (default: "Program <new status>"). */
  done?: string;
}

function actionCopy(action: ProgramLifecycleAction, program: AdminProgramDetailDto, now: number): ActionCopy {
  const scheduled = Date.parse(program.startsAt) > now;
  switch (action) {
    case 'publish':
      return {
        label: 'Publish',
        title: `Publish “${program.name}”?`,
        description: scheduled
          ? 'The program becomes Scheduled and starts automatically at its start date. Code, offering, unit, currency and reward depth are locked from now on.'
          : 'The program becomes Active right away and members can enroll while the enrollment window is open. Code, offering, unit, currency and reward depth are locked from now on.',
        confirm: scheduled ? 'Publish and schedule' : 'Publish now',
        icon: Rocket,
        reason: 'optional',
      };
    case 'pause':
      return {
        label: 'Pause',
        title: 'Pause this program?',
        description: 'While paused, members cannot enroll and sales that happen are not eligible for rewards. You can resume it later.',
        confirm: 'Pause program',
        icon: CirclePause,
        destructive: true,
        reason: 'required',
      };
    case 'resume':
      return {
        label: 'Resume',
        title: 'Resume this program?',
        description: 'Enrollment reopens (within its window) and new sales become eligible for rewards again.',
        confirm: 'Resume program',
        icon: CirclePlay,
        reason: 'optional',
      };
    case 'complete':
      return {
        label: 'Complete',
        title: 'Complete this program now?',
        description:
          'The program ends now (its end date is set to now if it was later). Enrollment closes, dates are frozen and it can only be archived afterwards. Sales that happened before the end can still be recorded during the grace period.',
        confirm: 'Complete program',
        icon: Flag,
        destructive: true,
        reason: 'optional',
      };
    case 'archive':
      return {
        label: 'Archive',
        title: 'Archive this program?',
        description: 'Archived programs are read-only and hidden from members. This cannot be undone.',
        confirm: 'Archive program',
        icon: Archive,
        reason: 'optional',
      };
    case 'cancel':
      return {
        label: 'Cancel program',
        title: `Cancel “${program.name}” before it starts?`,
        description:
          'The scheduled program is withdrawn and archived: it never starts, is removed from the member catalogue and cannot be reactivated. No one can have enrolled yet and no sales can be recorded for it. To run it later, create a new program.',
        confirm: 'Cancel program',
        icon: Ban,
        destructive: true,
        reason: 'required',
        done: 'Program cancelled',
      };
  }
}

/** Header actions: edit, lifecycle transitions (with confirm dialogs) and deleting drafts. */
export function ProgramLifecycleActions({ program }: { program: AdminProgramDetailDto }) {
  const router = useRouter();
  const { can } = useSession();
  const now = useNow() ?? 0;
  const lifecycle = useProgramLifecycle(program.id);
  const remove = useDeleteProgram();
  const [pending, setPending] = useState<ProgramLifecycleAction | 'delete' | null>(null);

  const canPublish = can(Permission.ProgramsPublish);
  const canWrite = can(Permission.ProgramsWrite);
  const actions = canPublish ? program.allowedActions : [];
  const failingChecks = program.publishChecks.filter((c) => !c.ok);
  // Withdrawing a scheduled program is never the highlighted (filled) action.
  const primary = actions[0] === 'cancel' ? undefined : actions[0];
  const secondary = actions[0] === 'cancel' ? actions : actions.slice(1);
  // The API refuses once the start has passed (the scheduler is about to activate the program).
  const started = Date.parse(program.startsAt) <= now;
  const copy = pending && pending !== 'delete' ? actionCopy(pending, program, now) : null;

  async function run(action: ProgramLifecycleAction, reason?: string) {
    try {
      const updated = await lifecycle.mutateAsync({ action, reason, expectedVersion: program.version });
      toast.success(actionCopy(action, program, now).done ?? `Program ${updated.status.toLowerCase()}`);
    } catch (error) {
      if (isApiError(error) && error.code === 'STALE_VERSION') {
        throw new Error('This program was changed by someone else. Close this dialog and try again with the latest version.');
      }
      throw error;
    }
  }

  const button = (action: ProgramLifecycleAction, variant: 'default' | 'outline') => {
    const c = actionCopy(action, program, now);
    const Icon = c.icon;
    const notReady = action === 'publish' && failingChecks.length > 0;
    const tooLate = action === 'cancel' && started;
    const title = notReady
      ? `Not ready: ${failingChecks.map((f) => f.message).join('; ')}`
      : tooLate
        ? 'The start date has passed and the program is starting; pause or complete it once it is active.'
        : undefined;
    return (
      <Button key={action} variant={variant} onClick={() => setPending(action)} disabled={notReady || tooLate} title={title}>
        <Icon aria-hidden />
        {c.label}
      </Button>
    );
  };

  return (
    <>
      {canWrite && program.editableFields.length > 0 ? (
        <Button variant="outline" asChild>
          <Link href={programHref(program.id, 'edit')}>
            <Pencil aria-hidden />
            Edit
          </Link>
        </Button>
      ) : null}
      {secondary.map((a) => button(a, 'outline'))}
      {primary ? button(primary, 'default') : null}
      {canWrite && program.canDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More program actions">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setPending('delete')}>
              <Trash2 aria-hidden />
              Delete draft
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <ConfirmDialog
        open={copy !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={copy?.title ?? ''}
        description={copy?.description}
        confirmLabel={copy?.confirm}
        cancelLabel={pending === 'cancel' ? 'Keep program' : undefined}
        variant={copy?.destructive ? 'destructive' : 'default'}
        reason={copy ? (copy.reason === 'required' ? true : { required: false, label: 'Note (optional)' }) : undefined}
        onConfirm={({ reason }) => (pending && pending !== 'delete' ? run(pending, reason) : undefined)}
      >
        {pending === 'publish' ? <PublishSummary program={program} /> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={pending === 'delete'}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Delete the draft “${program.name}”?`}
        description="The draft, its options and draft policies are removed permanently."
        confirmLabel="Delete draft"
        variant="destructive"
        typedConfirmation={program.code}
        onConfirm={async () => {
          await remove.mutateAsync(program.id);
          toast.success('Draft deleted');
          router.push(PROGRAMS_HREF);
        }}
      />
    </>
  );
}

function PublishSummary({ program }: { program: AdminProgramDetailDto }) {
  return (
    <ul className="space-y-1.5">
      {program.publishChecks.map((c) => (
        <li key={c.key} className="flex items-start gap-2">
          {c.ok ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          )}
          <span>
            <span className="sr-only">{c.ok ? 'Passed: ' : 'Failed: '}</span>
            {c.message}
          </span>
        </li>
      ))}
      <li className="pt-1 text-xs text-muted-foreground">
        Starts <DateTime value={program.startsAt} timeZone={program.timezone} showTimeZone />
      </li>
    </ul>
  );
}
