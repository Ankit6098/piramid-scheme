import type { LucideIcon } from 'lucide-react';
import { Bell, ClipboardCheck, Gift, Megaphone, ShieldCheck, Users } from 'lucide-react';
import { ANNOUNCEMENT_NOTIFICATION_PREFIX } from '@app/shared';

import { routes } from '@/config/routes';

export interface NotificationMeta {
  icon: LucideIcon;
  /** Short category label shown next to the time. */
  category: string;
  /** Where "View" goes (member area), when there is an obvious destination. */
  href?: string;
}

/** Visual category of a notification, derived from its `type` prefix (`reward.status` → Rewards). */
export function notificationMeta(type: string): NotificationMeta {
  if (type.startsWith(ANNOUNCEMENT_NOTIFICATION_PREFIX)) return { icon: Megaphone, category: 'Announcement' };
  if (type.startsWith('reward')) return { icon: Gift, category: 'Rewards', href: routes.member.rewards };
  if (type.startsWith('enrollment')) return { icon: ClipboardCheck, category: 'Enrollments', href: routes.member.programs };
  if (type.startsWith('referral') || type.startsWith('team')) return { icon: Users, category: 'Team', href: routes.member.team };
  if (type.startsWith('account') || type.startsWith('security') || type.startsWith('auth')) {
    return { icon: ShieldCheck, category: 'Account', href: routes.member.profile };
  }
  return { icon: Bell, category: 'Update' };
}
