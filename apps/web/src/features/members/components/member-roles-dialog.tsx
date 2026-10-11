'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ROLE_LABELS, reasonSchema, RoleKey, type AdminMemberDetailDto } from '@app/shared';

import { applyApiFieldErrors, FormTextarea } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';

import { useUpdateMemberRoles } from '../api';

const ASSIGNABLE: ReadonlyArray<{ role: Exclude<RoleKey, 'MEMBER'>; description: string }> = [
  { role: 'SUPER_ADMIN', description: 'Full access: settings, roles, offering approval, audit and flags.' },
  {
    role: 'PROGRAM_ADMIN',
    description: "Manages assigned programs only. Assign programs on each program's admins page.",
  },
  {
    role: 'FINANCE_REVIEWER',
    description: 'Approves, rejects and reverses rewards; reads the ledger, reconciliation and audit log.',
  },
];

const schema = z.object({
  roles: z.array(z.enum(RoleKey)),
  reason: reasonSchema,
});
type FormValues = z.input<typeof schema>;

/** Replace a member's administrative roles (Super Admins only; never your own account). */
export function MemberRolesDialog({ member }: { member: AdminMemberDetailDto }) {
  const [open, setOpen] = useState(false);
  const mutation = useUpdateMemberRoles(member.id);
  const current = member.roles.map((r) => r.role).filter((r) => r !== 'MEMBER');
  const form = useForm<FormValues, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { roles: current, reason: '' },
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const selected = useWatch({ control: form.control, name: 'roles' });
  const changed =
    selected.length !== current.length || selected.some((r) => !current.includes(r as Exclude<RoleKey, 'MEMBER'>));

  const onOpenChange = (next: boolean) => {
    if (mutation.isPending) return;
    if (next) form.reset({ roles: current, reason: '' });
    setSubmitError(null);
    setOpen(next);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await mutation.mutateAsync({ roles: values.roles, reason: values.reason });
      const changes = [
        ...result.granted.map((r) => `granted ${ROLE_LABELS[r]}`),
        ...result.revoked.map((r) => `removed ${ROLE_LABELS[r]}`),
      ];
      toast.success(changes.length ? `Roles updated: ${changes.join(', ')}` : 'No role changes', {
        description: result.sessionsRevoked > 0 ? 'The member was signed out and must sign in again.' : undefined,
      });
      setOpen(false);
    } catch (error) {
      if (!applyApiFieldErrors(error, form)) setSubmitError(getErrorMessage(error));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ShieldCheck aria-hidden />
          Manage roles
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} noValidate className="contents">
          <DialogHeader>
            <DialogTitle>Roles for {member.fullName}</DialogTitle>
            <DialogDescription>
              Everyone keeps the Member role. Saving changes signs the member out of all sessions; administrators
              must use an authenticator app to open the admin console.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <FieldSet>
              <FieldLegend variant="label">Administrative roles</FieldLegend>
              <Controller
                control={form.control}
                name="roles"
                render={({ field }) => (
                  <div className="grid gap-2">
                    {ASSIGNABLE.map(({ role, description }) => {
                      const id = `role-${role}`;
                      const checked = field.value.includes(role);
                      return (
                        <FieldLabel key={role} htmlFor={id}>
                          <Field orientation="horizontal">
                            <Checkbox
                              id={id}
                              checked={checked}
                              disabled={mutation.isPending}
                              onCheckedChange={(value) =>
                                field.onChange(
                                  value ? [...field.value, role] : field.value.filter((r) => r !== role),
                                )
                              }
                            />
                            <FieldContent>
                              <FieldTitle>{ROLE_LABELS[role]}</FieldTitle>
                              <FieldDescription>{description}</FieldDescription>
                            </FieldContent>
                          </Field>
                        </FieldLabel>
                      );
                    })}
                  </div>
                )}
              />
            </FieldSet>
            <FormTextarea
              control={form.control}
              name="reason"
              label="Reason"
              required
              rows={3}
              maxLength={1000}
              placeholder="Why are these roles changing? This is recorded in the audit log."
              disabled={mutation.isPending}
            />
          </FieldGroup>

          {submitError ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {submitError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || !changed}>
              {mutation.isPending ? <Spinner aria-hidden /> : null}
              Save roles
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
