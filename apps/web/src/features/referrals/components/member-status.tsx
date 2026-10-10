import { BadgeCheck } from 'lucide-react';
import type { MemberStatusBucket } from '@app/shared';

import { ToneBadge } from '@/components/app/status-badge';

/** Active / inactive account bucket (label, never color alone). */
export function MemberStatusBadge({ value, className }: { value: MemberStatusBucket; className?: string }) {
  return value === 'ACTIVE' ? (
    <ToneBadge tone="success" className={className}>
      Active
    </ToneBadge>
  ) : (
    <ToneBadge tone="muted" dot={false} className={className} title="Suspended or deactivated account">
      Inactive
    </ToneBadge>
  );
}

/** Whether the member currently holds an eligible enrollment. */
export function EnrollmentIndicator({ eligible, className }: { eligible: boolean; className?: string }) {
  return eligible ? (
    <ToneBadge tone="primary" dot={false} className={className} title="Currently holds an eligible program enrollment">
      <BadgeCheck className="size-3" aria-hidden />
      Enrolled
    </ToneBadge>
  ) : (
    <span className={className ?? 'text-xs text-muted-foreground'}>Not enrolled</span>
  );
}
