'use client';

import { Info, Network } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { routes } from '@/config/routes';

import { DirectReferralsTable } from './direct-referrals-table';
import { ReferralLinkCard } from './referral-link-card';

/** `/referrals`: the member's link + direct referrals. */
export function ReferralsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Referrals"
        description="Your referral link and the members who registered with it."
        actions={
          <Button asChild variant="outline">
            <Link href={routes.member.team}>
              <Network aria-hidden />
              View team tree
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <ReferralLinkCard className="lg:col-span-2" />
        <Card size="sm" className="bg-muted/40">
          <CardContent className="flex gap-3 text-sm">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="space-y-2 text-muted-foreground">
              <p className="font-medium text-foreground">How attribution works</p>
              <p>
                A sign-up is linked to you once, when the new member verifies their email using your
                link or code. It cannot be changed later except by an audited administrator correction.
              </p>
              <p>Rewards are calculated only from qualifying sales of approved offerings — never from sign-ups.</p>
            </div>
          </CardContent>
        </Card>
      </div>
      <DirectReferralsTable />
    </div>
  );
}
