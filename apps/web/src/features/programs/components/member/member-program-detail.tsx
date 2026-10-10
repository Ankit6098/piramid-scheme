'use client';

import { ArrowLeft, CalendarClock, CheckCircle2, FileText, Info, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { MemberProgramDetailDto, MemberProgramOptionDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader, SectionHeader } from '@/components/app/page-header';
import { useBreadcrumbLabel } from '@/components/app/shell/breadcrumb-store';
import { CardSkeleton } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { MyEnrollments } from '@/features/enrollments/components/my-enrollments';
import { useNow } from '@/hooks/use-now';
import { enumLabel } from '@/lib/enum-labels';

import { useMemberProgram } from '../../api';
import { EnrollDialogContent } from './enroll-dialog';
import { enrollmentOpensOn, isEnrollmentClosed } from './program-card';

/** /programs/[id] — program details, plans with prices, terms and enrollment. */
export function MemberProgramDetail() {
  const { id } = useParams<{ id: string }>();
  const query = useMemberProgram(id);
  useBreadcrumbLabel(query.data?.name);

  if (query.isPending) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading program">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={3} />
          <CardSkeleton lines={3} />
        </div>
      </div>
    );
  }
  if (query.error || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <ProgramDetail program={query.data} />;
}

function ProgramDetail({ program }: { program: MemberProgramDetailDto }) {
  const [choice, setChoice] = useState<{ option: MemberProgramOptionDto; session: number } | null>(null);
  const now = useNow();
  const tz = program.timezone;
  const hasPending = program.myEnrollments.some((e) => e.status === 'PENDING');
  const canEnroll = program.enrollmentOpen && program.myEligibility.eligible && !hasPending;
  const hasEnrollments = program.myEnrollments.length > 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title={program.name}
        description={program.description ?? undefined}
        meta={
          <>
            {program.status === 'ACTIVE' ? null : <StatusBadge kind="ProgramStatus" value={program.status} />}
            <ToneBadge tone="neutral" dot={false}>
              {program.offering.name} · {enumLabel('OfferingKind', program.offering.kind)}
            </ToneBadge>
          </>
        }
        actions={
          <Button variant="outline" asChild>
            <Link href="/programs">
              <ArrowLeft aria-hidden />
              All programs
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <InfoTile icon={CalendarClock} label="Program period">
          <DateTime value={program.startsAt} timeZone={tz} style="date" />
          {' → '}
          {program.endsAt ? <DateTime value={program.endsAt} timeZone={tz} style="date" /> : 'ongoing'}
        </InfoTile>
        <InfoTile icon={CalendarClock} label="Enrollment">
          {program.enrollmentOpen ? (
            program.enrollmentClosesAt ? (
              <>
                Open until <DateTime value={program.enrollmentClosesAt} timeZone={tz} showTimeZone />
              </>
            ) : (
              'Open'
            )
          ) : isEnrollmentClosed(program, now) ? (
            'Closed'
          ) : (
            <>
              Opens <DateTime value={enrollmentOpensOn(program)} timeZone={tz} showTimeZone />
            </>
          )}
        </InfoTile>
        <InfoTile icon={FileText} label="Terms">
          Version {program.termsVersion} · <TermsDialog program={program} />
        </InfoTile>
      </div>

      {!program.myEligibility.eligible ? (
        <Alert>
          <ShieldAlert aria-hidden />
          <AlertTitle>You can’t enroll in this program yet</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {program.myEligibility.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="plans-heading" className="space-y-3">
        <SectionHeader title={<span id="plans-heading">Plans</span>} description={`Prices in ${program.currencyCode}.`} />
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {program.options.map((o) => (
            <li key={o.id}>
              <PlanCard
                program={program}
                option={o}
                disabled={!canEnroll}
                disabledReason={
                  hasPending
                    ? 'You already have an enrollment waiting for activation.'
                    : !program.enrollmentOpen
                      ? 'Enrollment is not open right now.'
                      : !program.myEligibility.eligible
                        ? 'You don’t meet the eligibility rules yet.'
                        : undefined
                }
                renewal={program.myEnrollments.some((e) => e.status === 'ACTIVE')}
                onChoose={() => setChoice((c) => ({ option: o, session: (c?.session ?? 0) + 1 }))}
              />
            </li>
          ))}
        </ul>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          A plan price pays for access to {program.offering.name}. It is not an investment or a deposit, and enrolling never earns
          rewards. Rewards come only from qualifying sales of the offering to end customers, and there are no guaranteed earnings.
        </p>
      </section>

      {hasEnrollments ? (
        <section aria-labelledby="mine-heading" className="space-y-3">
          <SectionHeader title={<span id="mine-heading">Your enrollments</span>} />
          <MyEnrollments programId={program.id} compact />
        </section>
      ) : null}

      <Dialog open={choice !== null} onOpenChange={(open) => !open && setChoice(null)}>
        {choice ? <EnrollDialogContent key={choice.session} program={program} option={choice.option} onDone={() => setChoice(null)} /> : null}
      </Dialog>
    </div>
  );
}

function InfoTile({ icon: Icon, label, children }: { icon: typeof Info; label: string; children: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardContent className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 text-sm">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-0.5">{children}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function PlanCard({
  program,
  option,
  disabled,
  disabledReason,
  renewal,
  onChoose,
}: {
  program: MemberProgramDetailDto;
  option: MemberProgramOptionDto;
  disabled: boolean;
  disabledReason?: string;
  renewal: boolean;
  onChoose: () => void;
}) {
  const free = option.priceMinor === '0';
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{option.name}</CardTitle>
        <CardDescription>
          {enumLabel('BillingFrequency', option.billingFrequency)} · {option.durationDays} days
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-3">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {free ? 'Free' : <Amount kind="currency" value={option.priceMinor} format={{ currencyCode: option.currencyCode, minorUnits: program.currencyMinorUnits }} />}
        </p>
        {option.description ? <p className="text-sm text-muted-foreground">{option.description}</p> : null}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {enumLabel('RenewalPolicy', option.renewalPolicy)}
        </p>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-1.5">
        <Button onClick={onChoose} disabled={disabled}>
          {renewal ? 'Renew with this plan' : free ? 'Enroll for free' : 'Choose this plan'}
        </Button>
        {disabled && disabledReason ? <p className="text-center text-xs text-muted-foreground">{disabledReason}</p> : null}
      </CardFooter>
    </Card>
  );
}

function TermsDialog({ program }: { program: MemberProgramDetailDto }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="h-auto p-0">
          Read terms
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{program.name} — terms</DialogTitle>
          <DialogDescription>Version {program.termsVersion}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] rounded-lg border">
          <div className="p-4 text-sm whitespace-pre-wrap">
            {program.termsText?.trim() || 'This program has no additional terms beyond the platform terms of use.'}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
