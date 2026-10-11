'use client';

import { ClipboardList, Flag, Gift, Network, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Permission, ROLE_LABELS, type AdminMemberDetailDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { DateTime, RelativeTime } from '@/components/app/date-time';
import { CardSkeleton, EmptyState } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';

import { useAdminMember } from '../api';

/** Overview tab of a member: profile, roles, team, reward totals, enrollments, open flags. */
export function MemberOverview() {
  const { id } = useParams<{ id: string }>();
  const { data: member, isPending, error } = useAdminMember(id);

  // Errors are rendered by the layout (MemberDetailShell).
  if (error) return null;
  if (isPending || !member) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <CardSkeleton lines={6} />
        <CardSkeleton lines={4} className="lg:col-span-2" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {member.status === 'SUSPENDED' ? (
        <Alert role="status" className="border-destructive/30 bg-destructive/10 text-foreground">
          <ShieldAlert className="text-destructive" aria-hidden />
          <AlertTitle>
            Suspended{member.suspendedAt ? <> <RelativeTime value={member.suspendedAt} /></> : null}
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            {member.suspensionReason ?? 'No reason recorded.'}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <ProfileCard member={member} />
        <div className="space-y-6 lg:col-span-2">
          <RewardSummaryCard member={member} />
          <div className="grid gap-6 md:grid-cols-2">
            <RolesCard member={member} />
            <TeamCard member={member} />
          </div>
        </div>
      </div>

      <EnrollmentsCard member={member} />
      {member.openFlags !== null ? <FlagsCard flags={member.openFlags} /> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function ProfileCard({ member }: { member: AdminMemberDetailDto }) {
  const isAdmin = member.roles.some((r) => r.role !== 'MEMBER');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          <Row label="Email">
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="truncate">{member.email}</span>
              <CopyButton value={member.email} label="email" variant="ghost" size="icon-xs" />
            </span>
          </Row>
          <Row label="Email verified">
            {member.emailVerifiedAt ? (
              <DateTime value={member.emailVerifiedAt} style="date" />
            ) : (
              <ToneBadge tone="warning">Not verified</ToneBadge>
            )}
          </Row>
          <Row label="Phone">{member.phone ?? <span className="text-muted-foreground">—</span>}</Row>
          <Row label="Joined">
            <DateTime value={member.createdAt} style="date" />
          </Row>
          <Row label="Last sign-in">
            {member.lastLoginAt ? <RelativeTime value={member.lastLoginAt} /> : <span className="text-muted-foreground">Never</span>}
          </Row>
          <Row label="Referral code">
            {member.referralCode ? (
              <span className="inline-flex items-center gap-1">
                <code className="font-mono text-xs">{member.referralCode}</code>
                <CopyButton value={member.referralCode} label="referral code" variant="ghost" size="icon-xs" />
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          <Row label="Sponsor">
            {member.sponsor?.inScope ? (
              <span className="block min-w-0">
                <Link href={`${routes.admin.members}/${member.sponsor.id}`} className="font-medium hover:underline">
                  {member.sponsor.fullName ?? member.sponsor.displayName}
                </Link>
                {member.sponsor.email ? (
                  <span className="block truncate text-xs text-muted-foreground">{member.sponsor.email}</span>
                ) : null}
              </span>
            ) : member.sponsor ? (
              // Outside a program-scoped admin's programs: display name only, no link (it would 404).
              <span className="block min-w-0">
                <span className="font-medium">{member.sponsor.displayName}</span>
                <span className="block text-xs text-muted-foreground">Not in your programs</span>
              </span>
            ) : (
              <span className="text-muted-foreground">No sponsor (joined directly)</span>
            )}
          </Row>
          {isAdmin ? (
            <Row label="Authenticator">
              {member.hasTotpFactor ? (
                <ToneBadge tone="success">Enrolled</ToneBadge>
              ) : (
                <ToneBadge tone="warning">Not enrolled yet</ToneBadge>
              )}
            </Row>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

function RewardSummaryCard({ member }: { member: AdminMemberDetailDto }) {
  const { can } = useSession();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rewards</CardTitle>
        <CardDescription>Recorded rewards per unit and currency. Earned to date comes from the ledger.</CardDescription>
        {can(Permission.RewardsRead) ? (
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <Link href={`${routes.admin.rewards}?recipientUserId=${member.id}`}>View rewards</Link>
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {member.rewardSummary.length === 0 ? (
          <EmptyState variant="plain" size="sm" icon={Gift} title="No rewards recorded" />
        ) : (
          <div className="space-y-4">
            {member.rewardSummary.map((b) => {
              const format = { unit: b.rewardUnit, currencyCode: b.currencyCode };
              return (
                <div key={`${b.rewardUnit}:${b.currencyCode}`} className="grid gap-4 sm:grid-cols-3">
                  {(
                    [
                      ['Earned to date', b.earnedMinor],
                      ['Pending', b.pendingMinor],
                      ['Reversed', b.reversedMinor],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {label}
                        {member.rewardSummary.length > 1 ? ` · ${b.rewardUnit === 'POINTS' ? 'Points' : b.currencyCode}` : ''}
                      </p>
                      <Amount value={value} format={format} className="text-lg font-semibold" />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RolesCard({ member }: { member: AdminMemberDetailDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Roles</CardTitle>
        <CardDescription>Role changes sign the member out everywhere.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {member.roles.map((r) => (
            <li key={r.role} className="flex items-start justify-between gap-2 text-sm">
              <StatusBadge kind="RoleKey" value={r.role} />
              <span className="text-right text-xs text-muted-foreground">
                {r.grantedBy ? `by ${r.grantedBy.fullName}, ` : ''}
                <DateTime value={r.grantedAt} style="date" />
              </span>
            </li>
          ))}
        </ul>
        {member.programScopes.length > 0 ? (
          <div className="space-y-1.5 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">{ROLE_LABELS.PROGRAM_ADMIN} of</p>
            <ul className="flex flex-wrap gap-1.5">
              {member.programScopes.map((p) => (
                <li key={p.id}>
                  <ToneBadge tone="neutral">{p.name}</ToneBadge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TeamCard({ member }: { member: AdminMemberDetailDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
        <CardDescription>Referral network below this member.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Direct referrals</p>
            <p className="text-lg font-semibold">{member.team.directReferrals.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">All levels</p>
            <p className="text-lg font-semibold">{member.team.totalDescendants.toLocaleString()}</p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href={`${routes.admin.members}/${member.id}/team`}>
            <Network aria-hidden />
            Open team tree
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function EnrollmentsCard({ member }: { member: AdminMemberDetailDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrollments</CardTitle>
        <CardDescription>Plans this member enrolled in (within the programs you can access).</CardDescription>
      </CardHeader>
      <CardContent>
        {member.enrollments.length === 0 ? (
          <EmptyState variant="plain" size="sm" icon={ClipboardList} title="No enrollments" />
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <caption className="sr-only">Enrollments of {member.fullName}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Program</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Coverage</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {member.enrollments.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <span className="font-medium">{e.program.name}</span>
                        <span className="block text-xs text-muted-foreground">{e.program.code}</span>
                      </TableCell>
                      <TableCell>{e.optionName}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <StatusBadge kind="EnrollmentStatus" value={e.status} />
                          {e.status === 'ACTIVE' ? <StatusBadge kind="EligibilityStatus" value={e.eligibilityStatus} /> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <Coverage from={e.effectiveFrom} to={e.effectiveTo} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Amount kind="currency" value={e.priceMinor} format={{ currencyCode: e.program.currencyCode }} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="space-y-3 md:hidden">
              {member.enrollments.map((e) => (
                <li key={e.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{e.program.name}</p>
                      <p className="text-xs text-muted-foreground">{e.optionName}</p>
                    </div>
                    <StatusBadge kind="EnrollmentStatus" value={e.status} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <Coverage from={e.effectiveFrom} to={e.effectiveTo} />
                    <Amount kind="currency" value={e.priceMinor} format={{ currencyCode: e.program.currencyCode }} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Coverage({ from, to }: { from: string | null; to: string | null }) {
  if (!from) return <span className="text-muted-foreground">Not started</span>;
  return (
    <span>
      <DateTime value={from} style="date" /> – {to ? <DateTime value={to} style="date" /> : 'open'}
    </span>
  );
}

function FlagsCard({ flags }: { flags: NonNullable<AdminMemberDetailDto['openFlags']> }) {
  const { can } = useSession();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open flags</CardTitle>
        <CardDescription>Advisory suspicious-activity signals. Flags never change balances.</CardDescription>
        {can(Permission.FlagsManage) ? (
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <Link href={routes.admin.flags}>Manage flags</Link>
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {flags.length === 0 ? (
          <EmptyState variant="plain" size="sm" icon={Flag} title="No open flags" />
        ) : (
          <ul className="divide-y">
            {flags.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{f.kind.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</p>
                  <p className="text-sm text-muted-foreground">{f.details}</p>
                </div>
                <span className="text-xs text-muted-foreground">
                  <RelativeTime value={f.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
