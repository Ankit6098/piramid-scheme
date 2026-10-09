/**
 * Central navigation config: every member/admin route with its label, icon and required permission.
 * Drives the sidebar, the ⌘K command menu, breadcrumbs and admin permission filtering.
 *
 * Slices: add new routes here (and in `src/config/routes.ts`) instead of hard-coding links.
 * Hiding a nav item is UX only — the API enforces every permission.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Boxes,
  ClipboardCheck,
  Flag,
  Gauge,
  Gift,
  Handshake,
  Layers,
  LayoutDashboard,
  Network,
  ReceiptText,
  Scale,
  ScrollText,
  Settings,
  Share2,
  ShoppingBag,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react';
import { Permission } from '@app/shared';

import { routes } from '@/config/routes';

export type AppArea = 'member' | 'admin';

export interface NavItem {
  /** Visible label (also the breadcrumb label for this route). */
  title: string;
  href: string;
  icon: LucideIcon;
  /** Short description used in the command menu. */
  description?: string;
  /** Required permission(s) — the user needs ANY of them. Omit for "every user of this area". */
  permission?: Permission | readonly Permission[];
  /** Extra search terms for the command menu. */
  keywords?: readonly string[];
  /** Active only on an exact path match (e.g. `/admin` overview). */
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export const memberNav: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Dashboard',
        href: routes.member.dashboard,
        icon: LayoutDashboard,
        description: 'Your activity at a glance',
        keywords: ['home', 'overview'],
      },
    ],
  },
  {
    label: 'Programs & rewards',
    items: [
      {
        title: 'Programs',
        href: routes.member.programs,
        icon: Layers,
        description: 'Browse programs and manage enrollments',
        keywords: ['enroll', 'plans', 'offerings'],
      },
      {
        title: 'Rewards',
        href: routes.member.rewards,
        icon: Gift,
        description: 'Earnings from qualifying sales',
        keywords: ['earnings', 'points', 'history'],
      },
    ],
  },
  {
    label: 'Network',
    items: [
      {
        title: 'Referrals',
        href: routes.member.referrals,
        icon: Share2,
        description: 'Your referral link and code',
        keywords: ['invite', 'link', 'code', 'share'],
      },
      {
        title: 'Team',
        href: routes.member.team,
        icon: Network,
        description: 'Members who joined through your network',
        keywords: ['tree', 'downline', 'network'],
      },
      {
        title: 'Sponsor',
        href: routes.member.sponsor,
        icon: Handshake,
        description: 'The member who referred you',
        keywords: ['upline', 'referrer'],
      },
    ],
  },
  {
    label: 'Account',
    items: [
      {
        title: 'Profile',
        href: routes.member.profile,
        icon: UserRound,
        description: 'Personal details, email and password',
        keywords: ['account', 'password', 'email', 'security'],
      },
      {
        title: 'Notifications',
        href: routes.member.notifications,
        icon: Bell,
        description: 'Messages about your account and rewards',
        keywords: ['inbox', 'alerts'],
      },
    ],
  },
];

export const adminNav: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Overview',
        href: routes.admin.overview,
        icon: Gauge,
        description: 'Platform health and pending work',
        exact: true,
        keywords: ['admin', 'home', 'metrics'],
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      {
        title: 'Offerings',
        href: routes.admin.offerings,
        icon: ShoppingBag,
        description: 'Approved products and services',
        permission: Permission.OfferingsWrite,
        keywords: ['products', 'services'],
      },
      {
        title: 'Programs',
        href: routes.admin.programs,
        icon: Boxes,
        description: 'Programs, options and reward policies',
        permission: Permission.ProgramsRead,
        keywords: ['policies', 'options', 'plans'],
      },
      {
        title: 'Enrollments',
        href: routes.admin.enrollments,
        icon: ClipboardCheck,
        description: 'Activate and review enrollments',
        permission: Permission.EnrollmentsManage,
        keywords: ['activate', 'pending', 'payments'],
      },
    ],
  },
  {
    label: 'Members',
    items: [
      {
        title: 'Members',
        href: routes.admin.members,
        icon: Users,
        description: 'Member accounts and referral tree',
        permission: Permission.MembersRead,
        keywords: ['users', 'accounts', 'suspend'],
      },
      {
        title: 'Flags',
        href: routes.admin.flags,
        icon: Flag,
        description: 'Suspicious-activity signals',
        permission: Permission.FlagsManage,
        keywords: ['fraud', 'risk'],
      },
    ],
  },
  {
    label: 'Rewards & finance',
    items: [
      {
        title: 'Events',
        href: routes.admin.events,
        icon: ReceiptText,
        description: 'Qualifying sale events',
        permission: [Permission.EventsWrite, Permission.EventsReverse],
        keywords: ['sales', 'refunds', 'chargebacks'],
      },
      {
        title: 'Rewards',
        href: routes.admin.rewards,
        icon: Gift,
        description: 'Review, approve and reverse rewards',
        permission: Permission.RewardsRead,
        keywords: ['approve', 'reject', 'reverse'],
      },
      {
        title: 'Ledger',
        href: routes.admin.ledger,
        icon: Wallet,
        description: 'Double-entry reward ledger',
        permission: Permission.LedgerRead,
        keywords: ['transactions', 'balances', 'accounting'],
      },
      {
        title: 'Reconciliation',
        href: routes.admin.reconciliation,
        icon: Scale,
        description: 'Ledger vs. reward consistency checks',
        permission: Permission.ReconciliationRead,
        keywords: ['exceptions', 'mismatch'],
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        title: 'Audit log',
        href: routes.admin.audit,
        icon: ScrollText,
        description: 'Who changed what, and why',
        permission: Permission.AuditRead,
        keywords: ['history', 'changes'],
      },
      {
        title: 'Settings',
        href: routes.admin.settings,
        icon: Settings,
        description: 'Reward unit, currency and platform settings',
        permission: Permission.SettingsWrite,
        keywords: ['currency', 'points', 'configuration'],
      },
    ],
  },
];

export function navForArea(area: AppArea): readonly NavGroup[] {
  return area === 'admin' ? adminNav : memberNav;
}

/** True when the user satisfies the item's permission requirement. */
export function canSeeNavItem(item: NavItem, permissions: readonly string[]): boolean {
  if (!item.permission) return true;
  const required = typeof item.permission === 'string' ? [item.permission] : item.permission;
  return required.some((p) => permissions.includes(p));
}

/** Removes items the user may not see, and groups that end up empty. */
export function filterNav(groups: readonly NavGroup[], permissions: readonly string[]): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canSeeNavItem(item, permissions)),
    }))
    .filter((group) => group.items.length > 0);
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Flat list of every nav item. */
export const allNavItems: readonly NavItem[] = [...memberNav, ...adminNav].flatMap((g) => g.items);

/** Finds the nav item for a path (longest matching href wins). */
export function findNavItem(pathname: string): NavItem | undefined {
  return allNavItems
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/**
 * Breadcrumb labels by path. Exact paths come from the nav config; slices may add labels for nested
 * static routes and dynamic patterns (use `[param]` for a dynamic segment), e.g.
 * `"/admin/programs/new": "New program"` or `"/admin/programs/[id]": "Program"`.
 * A page can override the label of its own crumb at runtime with `useBreadcrumbLabel()`.
 */
export const ROUTE_LABELS: Record<string, string> = {
  ...Object.fromEntries(allNavItems.map((item) => [item.href, item.title])),
  [routes.admin.overview]: 'Admin',
};
