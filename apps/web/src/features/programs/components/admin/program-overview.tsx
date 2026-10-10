'use client';

import { CalendarRange, CheckCircle2, ClipboardCheck, Layers, ScrollText, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import type { AdminProgramDetailDto, ProgramPublishCheckKey } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { SectionHeader } from '@/components/app/page-header';
import { StatCard } from '@/components/app/stat-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { enumLabel } from '@/lib/enum-labels';

import { useAdminProgram } from '../../api';
import { programHref } from './program-links';
import { StatusTimeline } from './status-timeline';

const CHECK_LINK: Record<ProgramPublishCheckKey, { label: string; href: (id: string) => string } | null> = {
  ACTIVE_OPTION: { label: 'Add an option', href: (id) => programHref(id, 'options') },
  OFFERING_ACTIVE: { label: 'Review offerings', href: () => '/admin/offerings' },
  DATES_VALID: { label: 'Edit dates', href: (id) => programHref(id, 'edit') },
  PUBLISHED_POLICY: { label: 'Open policies', href: (id) => programHref(id, 'policies') },
};

/** /admin/programs/[id] — key figures, publish readiness, configuration and recent status changes. */
export function ProgramOverview() {
  const { id } = useParams<{ id: string }>();
  const { data: program } = useAdminProgram(id);
  if (!program) return null;
  const tz = program.timezone;
  const policy = program.policySummary;

  return (
    <div className="space-y-6">
      {program.status === 'DRAFT' ? <PublishReadiness program={program} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active enrollments"
          value={<span className="tabular-nums">{program.enrollmentCounts.ACTIVE}</span>}
          hint={`${program.enrollmentCounts.PENDING} awaiting activation`}
          icon={ClipboardCheck}
        />
        <StatCard
          label="Plans"
          value={<span className="tabular-nums">{program.activeOptionCount}</span>}
          hint={`${program.options.length - program.activeOptionCount} inactive`}
          icon={Layers}
        />
        <StatCard
          label="Reward policy in effect"
          value={<span className="text-base">{policy.current ? `v${policy.current.version}` : 'None'}</span>}
          hint={
            policy.current
              ? policy.current.name
              : policy.upcoming
                ? `v${policy.upcoming.version} starts later`
                : `${policy.draftCount} draft(s)`
          }
          icon={ScrollText}
        />
        <StatCard
          label="Schedule"
          value={
            <span className="text-base">
              <DateTime value={program.startsAt} timeZone={tz} style="date" />
            </span>
          }
          hint={
            program.endsAt ? (
              <>
                until <DateTime value={program.endsAt} timeZone={tz} style="date" />
              </>
            ) : (
              'Open-ended'
            )
          }
          icon={CalendarRange}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Dates are shown in the program time zone ({tz}).</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Item label="Offering">
                {program.offering.name} · {enumLabel('OfferingKind', program.offering.kind)}
              </Item>
              <Item label="Rewards">
                {program.rewardUnit === 'POINTS' ? 'Points' : 'Money'} · prices in {program.currencyCode}
              </Item>
              <Item label="Starts">
                <DateTime value={program.startsAt} timeZone={tz} showTimeZone />
              </Item>
              <Item label="Ends">
                {program.endsAt ? <DateTime value={program.endsAt} timeZone={tz} showTimeZone /> : 'Open-ended'}
              </Item>
              <Item label="Enrollment opens">
                <DateTime value={program.enrollmentOpensAt} timeZone={tz} showTimeZone />
              </Item>
              <Item label="Enrollment closes">
                {program.enrollmentClosesAt ? (
                  <DateTime value={program.enrollmentClosesAt} timeZone={tz} showTimeZone />
                ) : (
                  'When the program ends'
                )}
              </Item>
              <Item label="Maximum reward depth">{program.maxRewardDepth} levels</Item>
              <Item label="Late sale grace period">{program.lateEventGraceDays} days</Item>
              <Item label="Eligibility">
                {program.eligibility.minAccountAgeDays || program.eligibility.requireSponsor ? (
                  <ul className="list-inside list-disc">
                    {program.eligibility.minAccountAgeDays ? (
                      <li>Account at least {program.eligibility.minAccountAgeDays} days old</li>
                    ) : null}
                    {program.eligibility.requireSponsor ? <li>Joined through a referral</li> : null}
                  </ul>
                ) : (
                  'Any active member'
                )}
              </Item>
              <Item label="Terms">Version {program.termsVersion}</Item>
              <Item label="Created">
                <DateTime value={program.createdAt} timeZone={tz} style="date" />
                {program.createdBy ? ` by ${program.createdBy.fullName}` : ''}
              </Item>
              <Item label="Published">
                {program.publishedAt ? <DateTime value={program.publishedAt} timeZone={tz} style="date" /> : 'Not yet'}
              </Item>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <SectionHeader
              title="Recent status changes"
              className="mb-0"
              actions={
                <Button variant="link" size="sm" asChild className="px-0">
                  <Link href={programHref(program.id, 'history')}>View all</Link>
                </Button>
              }
            />
          </CardHeader>
          <CardContent>
            <StatusTimeline changes={program.statusHistory.slice(0, 4)} timeZone={tz} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function PublishReadiness({ program }: { program: AdminProgramDetailDto }) {
  const ready = program.publishChecks.every((c) => c.ok);
  return (
    <Card className={ready ? 'ring-success/30' : undefined}>
      <CardHeader>
        <CardTitle>{ready ? 'Ready to publish' : 'Before you can publish'}</CardTitle>
        <CardDescription>
          {ready
            ? 'Every precondition is met. Publishing locks the code, offering, reward unit, currency and depth.'
            : 'A program needs an approved offering, at least one active option, valid dates and a published reward policy.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {program.publishChecks.map((c) => {
            const link = CHECK_LINK[c.key];
            return (
              <li key={c.key} className="flex items-start gap-2 rounded-lg border p-2.5">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                )}
                <div className="min-w-0 flex-1 text-sm">
                  <span className="sr-only">{c.ok ? 'Done: ' : 'To do: '}</span>
                  {c.message}
                  {!c.ok && link ? (
                    <Link href={link.href(program.id)} className="mt-0.5 block text-xs font-medium text-primary hover:underline">
                      {link.label}
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
