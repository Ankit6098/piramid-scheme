'use client';

import { ArrowRight, CalendarClock, CheckCircle2, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import type { MemberProgramDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useNow } from '@/hooks/use-now';
import { enumLabel } from '@/lib/enum-labels';

export function memberProgramHref(p: Pick<MemberProgramDto, 'code'>): string {
  return `/programs/${encodeURIComponent(p.code)}`;
}

/** When members can actually enroll: the later of the program start and the window opening. */
export function enrollmentOpensOn(p: Pick<MemberProgramDto, 'startsAt' | 'enrollmentOpensAt'>): string {
  return Date.parse(p.enrollmentOpensAt) > Date.parse(p.startsAt) ? p.enrollmentOpensAt : p.startsAt;
}

/** The enrollment window has already closed (as opposed to "not open yet"). */
export function isEnrollmentClosed(
  p: Pick<MemberProgramDto, 'enrollmentOpen' | 'enrollmentClosesAt' | 'endsAt' | 'status'>,
  now: number | null,
): boolean {
  if (p.enrollmentOpen) return false;
  if (p.status !== 'ACTIVE' && p.status !== 'SCHEDULED') return true;
  if (now === null) return false;
  const closesAt = p.enrollmentClosesAt ?? p.endsAt;
  return closesAt !== null && Date.parse(closesAt) <= now;
}

/** Lowest plan price (bigint compare, no floats). */
function cheapest(p: MemberProgramDto) {
  return p.options.reduce<MemberProgramDto['options'][number] | null>(
    (min, o) => (min === null || BigInt(o.priceMinor) < BigInt(min.priceMinor) ? o : min),
    null,
  );
}

/** Catalogue card: offering, window, plans from-price and the member's status in the program. */
export function ProgramCard({ program }: { program: MemberProgramDto }) {
  const now = useNow();
  const low = cheapest(program);
  const mine = program.myEnrollments;
  const active = mine.find((e) => e.status === 'ACTIVE');
  const pending = mine.find((e) => e.status === 'PENDING');

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">
            <Link href={memberProgramHref(program)} className="hover:underline">
              {program.name}
            </Link>
          </CardTitle>
          {program.status === 'SCHEDULED' ? <StatusBadge kind="ProgramStatus" value="SCHEDULED" label="Starting soon" /> : null}
        </div>
        <CardDescription>
          {program.offering.name} · {enumLabel('OfferingKind', program.offering.kind)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-3 text-sm">
        {program.description ? <p className="line-clamp-3 text-muted-foreground">{program.description}</p> : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="size-3.5" aria-hidden />
          {program.enrollmentOpen ? (
            program.enrollmentClosesAt ? (
              <span>
                Enrollment open until <DateTime value={program.enrollmentClosesAt} timeZone={program.timezone} style="date" />
              </span>
            ) : (
              <span>Enrollment open</span>
            )
          ) : isEnrollmentClosed(program, now) ? (
            <span>Enrollment closed</span>
          ) : (
            <span>
              Enrollment opens <DateTime value={enrollmentOpensOn(program)} timeZone={program.timezone} style="date" />
            </span>
          )}
        </div>
        {low ? (
          <p>
            <span className="text-muted-foreground">{program.options.length > 1 ? 'Plans from ' : 'Plan: '}</span>
            {low.priceMinor === '0' ? (
              <span className="font-medium">Free</span>
            ) : (
              <span className="font-medium">
                <Amount kind="currency" value={low.priceMinor} format={{ currencyCode: low.currencyCode, minorUnits: program.currencyMinorUnits }} />
              </span>
            )}
            <span className="text-muted-foreground"> · {enumLabel('BillingFrequency', low.billingFrequency).toLowerCase()}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {active ? (
            <ToneBadge tone="success">
              <CheckCircle2 className="size-3" aria-hidden />
              Enrolled
            </ToneBadge>
          ) : null}
          {pending ? <ToneBadge tone="warning">Awaiting activation</ToneBadge> : null}
          {!program.myEligibility.eligible && !active ? (
            <ToneBadge tone="muted" title={program.myEligibility.reasons.join(' ')}>
              <ShieldAlert className="size-3" aria-hidden />
              Not eligible yet
            </ToneBadge>
          ) : null}
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="outline" size="sm" asChild className="ml-auto">
          <Link href={memberProgramHref(program)}>
            View plans
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
