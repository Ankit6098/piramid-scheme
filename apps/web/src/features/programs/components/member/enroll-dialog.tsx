'use client';

import { Hourglass, Info } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { MemberProgramDetailDto, MemberProgramOptionDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage, isApiError } from '@/lib/api-client';
import { enumLabel } from '@/lib/enum-labels';

import { useEnroll } from '../../api';

/** Terms review + acceptance, then enrollment in one plan. Mount per open. */
export function EnrollDialogContent({
  program,
  option,
  onDone,
}: {
  program: MemberProgramDetailDto;
  option: MemberProgramOptionDto;
  onDone: () => void;
}) {
  const enroll = useEnroll(program.id);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkboxId = useId();
  const free = option.priceMinor === '0';

  async function submit() {
    setError(null);
    try {
      const enrollment = await enroll.mutateAsync({ optionId: option.id, acceptTerms: true, termsVersion: program.termsVersion });
      if (enrollment.status === 'ACTIVE') {
        toast.success(enrollment.upcoming ? 'Renewal confirmed' : `You're enrolled in ${program.name}`, {
          description: enrollment.upcoming ? 'Your next period starts when the current one ends.' : `Your ${option.name} plan is active.`,
        });
      } else {
        toast.success('Enrollment received', { description: 'It will be activated once your payment has been confirmed.' });
      }
      onDone();
    } catch (e) {
      setError(
        isApiError(e) && e.code === 'CONFLICT' && e.message.includes('terms')
          ? 'The program terms were just updated. Close this dialog and review the latest terms.'
          : getErrorMessage(e),
      );
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Enroll in {program.name}</DialogTitle>
        <DialogDescription>Review the plan and the program terms before you continue.</DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border p-3 text-sm">
        <dt className="text-muted-foreground">Plan</dt>
        <dd className="font-medium">{option.name}</dd>
        <dt className="text-muted-foreground">Price</dt>
        <dd>
          {free ? 'Free' : <Amount kind="currency" value={option.priceMinor} format={{ currencyCode: option.currencyCode, minorUnits: program.currencyMinorUnits }} />}{' '}
          <span className="text-muted-foreground">· {enumLabel('BillingFrequency', option.billingFrequency).toLowerCase()}</span>
        </dd>
        <dt className="text-muted-foreground">Coverage</dt>
        <dd>{option.durationDays} days</dd>
      </dl>

      <div className="space-y-2">
        <p className="text-sm font-medium">Program terms · version {program.termsVersion}</p>
        <ScrollArea className="h-48 rounded-lg border">
          <div className="p-3 text-sm whitespace-pre-wrap text-muted-foreground">
            {program.termsText?.trim() || 'This program has no additional terms beyond the platform terms of use.'}
          </div>
        </ScrollArea>
      </div>

      <label htmlFor={checkboxId} className="flex cursor-pointer items-start gap-2.5 text-sm">
        <Checkbox id={checkboxId} checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} className="mt-0.5" />
        <span>
          I have read and accept the program terms (version {program.termsVersion}). I understand the price pays for access to{' '}
          {program.offering.name} and that enrolling does not earn rewards.
        </span>
      </label>

      {free ? (
        <p className="flex gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Free plans are activated immediately.
        </p>
      ) : (
        <p className="flex gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
          <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Payment is arranged offline with the program team. Your enrollment stays pending until they confirm it.
        </p>
      )}

      {error ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={enroll.isPending}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!accepted || enroll.isPending}>
          {enroll.isPending ? <Spinner aria-hidden /> : null}
          {free ? 'Enroll' : 'Request enrollment'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
