'use client';

import { History, ShieldCheck, UserRound } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { CardSkeleton, FormSkeleton } from '@/components/app/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EarningsSummary } from '@/features/rewards/components/earnings-summary';

import { useProfile } from '../api';
import { ActivityCard } from './activity-card';
import { ProfileDetailsCard } from './profile-details-card';
import { EmailCard, PasswordCard, TwoFactorCard } from './security-cards';
import { SessionsCard } from './sessions-card';

const TABS = ['profile', 'security', 'activity'] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

/** /profile — personal details, security (password, email, authenticator, sessions) and activity. */
export function ProfilePage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: Tab = isTab(requested) ? requested : 'profile';
  const profile = useProfile();

  const selectTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'profile') params.delete('tab');
    else params.set('tab', value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your personal details, sign-in security and account activity."
      />
      <div className="space-y-6">
        <section aria-label="Earned to date">
          <EarningsSummary variant="card" />
        </section>

        <Tabs value={tab} onValueChange={selectTab} className="gap-4">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="profile">
              <UserRound aria-hidden />
              Profile
            </TabsTrigger>
            <TabsTrigger value="security">
              <ShieldCheck aria-hidden />
              Security
            </TabsTrigger>
            <TabsTrigger value="activity">
              <History aria-hidden />
              Activity
            </TabsTrigger>
          </TabsList>

          {profile.isPending ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <FormSkeleton fields={3} />
              <CardSkeleton lines={4} />
            </div>
          ) : profile.error ? (
            <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
          ) : (
            <>
              {/* Kept mounted (hidden while another tab is open) so unsaved edits survive a tab
                  switch, and the unsaved-changes warning still guards leaving the page. */}
              <TabsContent value="profile" forceMount className="max-w-2xl data-[state=inactive]:hidden">
                <ProfileDetailsCard profile={profile.data} />
              </TabsContent>
              <TabsContent value="security" className="space-y-6">
                <div className="grid gap-6 lg:grid-cols-2">
                  <PasswordCard profile={profile.data} />
                  <EmailCard profile={profile.data} />
                </div>
                {profile.data.isAdmin ? <TwoFactorCard profile={profile.data} /> : null}
                <SessionsCard />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityCard />
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>
    </>
  );
}
