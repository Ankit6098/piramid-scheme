'use client';

/**
 * The member's referral link with copy / native share actions. Used by the referrals page and the
 * dashboard (keep the export name and props stable).
 *
 * Copy rules: a referral link is attribution only. Never suggest that sharing or sign-ups earn
 * rewards by themselves — rewards come only from qualifying sales.
 */
import { Share2 } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { CopyButton } from '@/components/app/copy-button';
import { ErrorState } from '@/components/app/error-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useReferralCode } from '../api';

export interface ReferralLinkCardProps {
  /** Smaller layout without the explanation text (dashboard side column). Default false. */
  compact?: boolean;
  className?: string;
}

const noopSubscribe = () => () => {};

/** `navigator.share` exists (mobile browsers, some desktops). False during prerender. */
function useCanShare(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    () => false,
  );
}

/** The member's referral link with copy/share actions. */
export function ReferralLinkCard({ compact = false, className }: ReferralLinkCardProps) {
  const query = useReferralCode();
  const canShare = useCanShare();
  const data = query.data;

  async function share() {
    if (!data) return;
    try {
      await navigator.share({
        title: 'Join me',
        text: `Sign up with my referral link (code ${data.code}).`,
        url: data.link,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user closed the sheet
      toast.error("Couldn't open the share sheet", { description: 'Copy the link instead.' });
    }
  }

  return (
    <Card size={compact ? 'sm' : 'default'} className={cn(className)} aria-busy={query.isPending}>
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
      <CardContent className="space-y-3">
        {query.isPending ? (
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="size-8" />
            <span className="sr-only">Loading referral link</span>
          </div>
        ) : query.error || !data ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            variant="plain"
            title="Couldn't load your referral link"
          />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <label htmlFor={compact ? 'referral-link-compact' : 'referral-link'} className="sr-only">
                Referral link
              </label>
              <Input
                id={compact ? 'referral-link-compact' : 'referral-link'}
                value={data.link}
                readOnly
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyButton value={data.link} label="referral link" />
              {canShare ? (
                <Button type="button" variant="outline" size="icon-sm" onClick={share} aria-label="Share referral link">
                  <Share2 aria-hidden />
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                Code
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm font-medium tracking-wider text-foreground">
                  {data.code}
                </code>
                <CopyButton value={data.code} label="referral code" variant="ghost" size="icon-xs" />
              </span>
              {compact ? null : <span>A referral code is attribution only, never a password.</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
