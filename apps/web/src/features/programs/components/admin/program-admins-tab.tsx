'use client';

import { ShieldCheck, UserCog, Users } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Permission, reasonSchema, type ProgramAdminDto } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { SectionHeader } from '@/components/app/page-header';
import { CardSkeleton, EmptyState } from '@/components/app/states';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useSession } from '@/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';

import { useProgramAdminCandidates, useProgramAdmins, useSetProgramAdmins } from '../../api';

/** /admin/programs/[id]/admins — PROGRAM_ADMINs assigned to this program. */
export function ProgramAdminsTab() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const canAssign = can(Permission.RolesAssign);
  const admins = useProgramAdmins(id);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);

  const manage = canAssign ? (
    <Button
      variant="outline"
      onClick={() => {
        setSession((s) => s + 1);
        setOpen(true);
      }}
    >
      <UserCog aria-hidden />
      Manage admins
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Program admins"
        description="Program admins manage this program’s options, policies, lifecycle and enrollments, and only see programs they are assigned to."
        actions={manage}
      />
      <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Super Admins and Finance Reviewers have access through their roles and are not listed here. Changes apply on the admin’s next
        request and are recorded in the audit log.
      </p>
      {admins.isPending ? (
        <CardSkeleton lines={3} />
      ) : admins.error ? (
        <ErrorState error={admins.error} onRetry={() => void admins.refetch()} />
      ) : admins.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No program admins assigned"
          description={canAssign ? 'Assign users with the Program Admin role to delegate day-to-day management.' : 'Ask a Super Admin to assign program admins.'}
          action={manage}
        />
      ) : (
        <Card className="py-0">
          <CardContent className="divide-y px-0">
            {admins.data.map((a) => (
              <div key={a.userId} className="flex items-center gap-3 px-4 py-3">
                <UserAvatar name={a.fullName} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{a.fullName}</p>
                  <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                </div>
                <p className="hidden text-xs text-muted-foreground sm:block">
                  Assigned <DateTime value={a.assignedAt} style="date" />
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        {open && admins.data ? (
          <ManageAdminsDialog key={session} programId={id} current={admins.data} onDone={() => setOpen(false)} />
        ) : null}
      </Dialog>
    </div>
  );
}

function ManageAdminsDialog({ programId, current, onDone }: { programId: string; current: ProgramAdminDto[]; onDone: () => void }) {
  const candidates = useProgramAdminCandidates(programId, true);
  const save = useSetProgramAdmins(programId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current.map((a) => a.userId)));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  // Assigned admins who are no longer candidates (suspended, deactivated or the role was removed):
  // still listed so they can be removed — the API keeps unchanged assignments without re-checking.
  const candidateIds = new Set((candidates.data ?? []).map((c) => c.userId));
  const formerAdmins = candidates.data ? current.filter((a) => !candidateIds.has(a.userId)) : [];
  const reasonCheck = reason.trim() ? reasonSchema.safeParse(reason) : null;
  const reasonError = reasonCheck && !reasonCheck.success ? (reasonCheck.error.issues[0]?.message ?? null) : null;

  const toggle = (userId: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });

  async function submit() {
    if (reasonError) return;
    setError(null);
    try {
      await save.mutateAsync({ userIds: [...selected], reason: reason.trim() || undefined });
      toast.success('Program admins updated');
      onDone();
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Manage program admins</DialogTitle>
        <DialogDescription>Choose which Program Admins manage this program.</DialogDescription>
      </DialogHeader>
      <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-1">
        {candidates.isPending ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : candidates.error ? (
          <p className="p-3 text-sm text-destructive">{getErrorMessage(candidates.error)}</p>
        ) : (
          <>
            {candidates.data.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No active users hold the Program Admin role. Grant the role from the member’s profile first.
              </p>
            ) : (
              candidates.data.map((c) => (
                <AdminCheckbox key={c.userId} admin={c} checked={selected.has(c.userId)} onCheckedChange={(on) => toggle(c.userId, on)} />
              ))
            )}
            {formerAdmins.length > 0 ? (
              <div role="group" aria-labelledby={`${reasonId}-former`} className="border-t pt-1">
                <p id={`${reasonId}-former`} className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                  No longer active Program Admins (suspended or role removed). Uncheck to remove; they can’t be re-added until
                  they are eligible again.
                </p>
                {formerAdmins.map((a) => (
                  <AdminCheckbox
                    key={a.userId}
                    admin={a}
                    checked={selected.has(a.userId)}
                    onCheckedChange={(on) => toggle(a.userId, on)}
                    note="Not eligible"
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
      <Field data-invalid={reasonError ? true : undefined}>
        <FieldLabel htmlFor={reasonId}>Note (optional)</FieldLabel>
        <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />
        <FieldDescription>Recorded in the audit log (at least 10 characters if given).</FieldDescription>
        {reasonError ? <FieldError>{reasonError}</FieldError> : null}
      </Field>
      {error ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={save.isPending || Boolean(reasonError) || candidates.isPending}>
          {save.isPending ? <Spinner aria-hidden /> : null}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function AdminCheckbox({
  admin,
  checked,
  onCheckedChange,
  note,
}: {
  admin: { userId: string; fullName: string; email: string };
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  note?: string;
}) {
  const checkboxId = `admin-${admin.userId}`;
  return (
    <label htmlFor={checkboxId} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60">
      <Checkbox id={checkboxId} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{admin.fullName}</span>
        <span className="block truncate text-xs text-muted-foreground">{admin.email}</span>
      </span>
      {note ? <span className="shrink-0 text-xs text-muted-foreground">{note}</span> : null}
    </label>
  );
}
