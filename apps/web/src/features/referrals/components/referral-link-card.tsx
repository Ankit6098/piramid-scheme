'use client';

/**
 * STUB — owned by the referrals slice, which replaces the internals with the member's referral code
 * (`queryKeys.referrals.code()`), the link `${APP_PUBLIC_URL}/register?ref=CODE`, a `<CopyButton>`
 * and share actions. Keep the export name and props stable: the dashboard uses it.
 *
 * Copy rules: a referral link is attribution only. Never suggest that sharing or sign-ups earn
 * rewards by themselves — rewards come only from qualifying sales.
 */
import { Share2 } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface ReferralLinkCardProps {
  /** Smaller layout without the explanation text (dashboard side column). Default false. */
  compact?: boolean;
  className?: string;
}

/** The member's referral link with copy/share actions. */
export function ReferralLinkCard({ compact = false, className }: ReferralLinkCardProps) {
  return (
    <Card size={compact ? 'sm' : 'default'} className={cn(className)} aria-busy>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Share2 className="size-4 text-muted-foreground" aria-hidden />
          Your referral link
        </CardTitle>
        {compact ? null : (
          <CardDescription>
            Share it with people who may genuinely want the offering. Sign-ups through your link are
            attributed to you; rewards depend only on qualifying sales.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <Skeleton className="h-8 flex-1" />
        <Skeleton className="size-8" />
        <span className="sr-only">Loading referral link</span>
      </CardContent>
    </Card>
  );
}
