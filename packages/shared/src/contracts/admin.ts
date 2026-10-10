// Contracts (Zod request schemas + response types) for admin operations (overview, members, audit)
// and the member-facing notifications + dashboard endpoints (slice 6 — admin operations).
// Amounts are integer minor units transported as decimal strings; dates are UTC ISO strings.

import { z } from 'zod';
import { cursorPageQuerySchema, reasonSchema } from '../api';
import {
  EligibilityStatus,
  EnrollmentStatus,
  FlagStatus,
  ProgramStatus,
  RewardStatus,
  RewardUnit,
  UserStatus,
} from '../enums';
import { RoleKey } from '../permissions';

// ─── Shared fragments ────────────────────────────────────────────────────────

/** Totals per (reward unit, currency) — never summed across units or currencies. */
export interface AmountBucketDto {
  rewardUnit: RewardUnit;
  currencyCode: string;
  count: number;
  amountMinor: string;
}

/** Reward totals of one member per (unit, currency) — docs/business-rules.md §10. */
export interface RewardSummaryBucketDto {
  rewardUnit: RewardUnit;
  currencyCode: string;
  /** Σ CREDIT − Σ DEBIT on the member's payable ledger accounts (posted minus reversed). */
  earnedMinor: string;
  /** Σ PENDING_APPROVAL + APPROVED rewards. */
  pendingMinor: string;
  /** Σ REVERSED rewards. */
  reversedMinor: string;
}

export interface UserRefDto {
  id: string;
  fullName: string;
}

export interface ProgramRefDto {
  id: string;
  code: string;
  name: string;
}

// ─── Admin overview (GET /admin/overview) ────────────────────────────────────

export interface AdminOverviewSalesBucketDto {
  currencyCode: string;
  count: number;
  amountMinor: string;
}

export interface AdminOverviewDailyPointDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  registrations: number;
  sales: number;
  rewardsPosted: number;
}

export interface AdminOverviewDto {
  generatedAt: string;
  /**
   * `ALL` = platform-wide figures; `PROGRAMS` = limited to the caller's assigned programs (PROGRAM_ADMIN):
   * members = members with an enrollment in those programs.
   */
  scope: 'ALL' | 'PROGRAMS';
  /** Number of programs in scope when `scope = PROGRAMS`. */
  scopedProgramCount: number | null;
  users: { total: number; verified: number; suspended: number };
  activePrograms: number;
  pendingEnrollments: number;
  /** Qualifying sales (RECEIVED/PROCESSED) that occurred in the last 30 days. */
  sales30d: { count: number; byCurrency: AdminOverviewSalesBucketDto[] };
  pendingRewardApprovals: { count: number; byUnit: AmountBucketDto[] };
  /** Rewards currently POSTED (posted and not reversed), per unit/currency. */
  postedRewards: AmountBucketDto[];
  reconciliation: {
    exceptionCount: number;
    /** `reconciliation` = from the reconciliation module; `basic` = built-in subset of checks. */
    source: 'reconciliation' | 'basic';
  };
  /** OPEN member flags (null when the caller is limited to assigned programs). */
  openFlags: number | null;
  /** DEAD outbox messages (SUPER_ADMIN only, otherwise null). */
  deadOutboxMessages: number | null;
  recentActions: AuditLogListItemDto[];
  /** 30 UTC days, oldest first, ending today. */
  daily: AdminOverviewDailyPointDto[];
}

// ─── Admin members ──────────────────────────────────────────────────────────

export const adminMemberListQuerySchema = cursorPageQuerySchema.extend({
  /** Name or email fragment (trigram-indexed ILIKE). */
  q: z.string().trim().max(120).optional(),
  status: z.enum(UserStatus).optional(),
  role: z.enum(RoleKey).optional(),
  programId: z.uuid().optional(),
});
export type AdminMemberListQuery = z.infer<typeof adminMemberListQuerySchema>;

export interface AdminMemberListItemDto {
  id: string;
  fullName: string;
  email: string;
  status: UserStatus;
  emailVerified: boolean;
  roles: RoleKey[];
  /** ACTIVE enrollments (within the caller's program scope). */
  activeEnrollments: number;
  /** OPEN flags (0 when the caller may not see flags). */
  openFlags: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AdminMemberRoleDto {
  role: RoleKey;
  grantedAt: string;
  grantedBy: UserRefDto | null;
}

export interface AdminMemberEnrollmentDto {
  id: string;
  program: ProgramRefDto & { status: ProgramStatus; currencyCode: string };
  optionName: string;
  priceMinor: string | null;
  status: EnrollmentStatus;
  eligibilityStatus: EligibilityStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
}

export interface AdminMemberFlagDto {
  id: string;
  kind: string;
  details: string;
  status: FlagStatus;
  createdAt: string;
}

export interface AdminMemberDetailDto {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  emailVerifiedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  roles: AdminMemberRoleDto[];
  /** Programs assigned to this member as PROGRAM_ADMIN. */
  programScopes: ProgramRefDto[];
  /** Has a confirmed TOTP authenticator (required for admin roles). */
  hasTotpFactor: boolean;
  referralCode: string | null;
  sponsor: (UserRefDto & { email: string }) | null;
  team: { directReferrals: number; totalDescendants: number };
  /** Within the caller's program scope. */
  enrollments: AdminMemberEnrollmentDto[];
  /** Within the caller's program scope. */
  rewardSummary: RewardSummaryBucketDto[];
  /** OPEN flags; null when the caller is limited to assigned programs. */
  openFlags: AdminMemberFlagDto[] | null;
  /** What the caller may do with this member (UX hints; the API re-checks every action). */
  can: { suspend: boolean; reactivate: boolean; changeRoles: boolean };
}

export const adminMemberStatusChangeSchema = z.object({ reason: reasonSchema });
export type AdminMemberStatusChangeInput = z.infer<typeof adminMemberStatusChangeSchema>;

export const adminMemberRolesUpdateSchema = z.object({
  /** The complete set of roles the member should hold (MEMBER is always kept). */
  roles: z.array(z.enum(RoleKey)).max(RoleKey.length),
  reason: reasonSchema,
});
export type AdminMemberRolesUpdateInput = z.infer<typeof adminMemberRolesUpdateSchema>;

export interface AdminMemberRolesResultDto {
  roles: RoleKey[];
  granted: RoleKey[];
  revoked: RoleKey[];
  /** Sessions of the member that were revoked (0 when nothing changed). */
  sessionsRevoked: number;
}

export interface AdminMemberStatusResultDto {
  id: string;
  status: UserStatus;
  sessionsRevoked: number;
}

// ─── Audit log (GET /admin/audit) ───────────────────────────────────────────

export const auditLogListQuerySchema = cursorPageQuerySchema.extend({
  actorId: z.uuid().optional(),
  /** Action prefix, e.g. `member.` or `reward.approve`. */
  action: z.string().trim().max(96).optional(),
  resourceType: z.string().trim().max(64).optional(),
  resourceId: z.string().trim().max(64).optional(),
  programId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

export interface AuditLogListItemDto {
  id: string;
  createdAt: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  program: ProgramRefDto | null;
  /** null = system action (scheduler/worker). */
  actor: UserRefDto | null;
  actorRoles: string[];
  reason: string | null;
  /** Top-level keys present in before/after. */
  changedFields: string[];
}

export interface AuditFieldChangeDto {
  /** Dotted path of the changed field (`status`, `rules.0.percentageBps`). */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before: unknown;
  after: unknown;
}

export interface AuditLogDetailDto extends AuditLogListItemDto {
  before: unknown;
  after: unknown;
  changes: AuditFieldChangeDto[];
  requestId: string | null;
  ipAddress: string | null;
}

// ─── Notifications (/users/me/notifications) ────────────────────────────────

export const notificationListQuerySchema = cursorPageQuerySchema.extend({
  /** `true` = unread only. */
  unread: z.stringbool().optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationUnreadCountDto {
  count: number;
}

export interface NotificationReadAllResultDto {
  updated: number;
}

/** Notification types starting with this prefix are shown as announcements on the dashboard. */
export const ANNOUNCEMENT_NOTIFICATION_PREFIX = 'announcement';

// ─── Member dashboard (GET /users/me/dashboard) ─────────────────────────────

export interface MemberDashboardEnrollmentDto {
  id: string;
  program: ProgramRefDto;
  optionName: string;
  status: Extract<EnrollmentStatus, 'ACTIVE' | 'PENDING'>;
  eligibilityStatus: EligibilityStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** Privacy-safe reward activity (never the sale's subject, amount, customer or trace). */
export interface MemberDashboardRewardActivityDto {
  kind: 'REWARD';
  id: string;
  at: string;
  rewardId: string;
  programName: string;
  level: number;
  amountMinor: string;
  rewardUnit: RewardUnit;
  currencyCode: string;
  status: RewardStatus;
}

export interface MemberDashboardNotificationActivityDto {
  kind: 'NOTIFICATION';
  id: string;
  at: string;
  notificationId: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
}

export type MemberDashboardActivityDto = MemberDashboardRewardActivityDto | MemberDashboardNotificationActivityDto;

export interface MemberDashboardDto {
  user: {
    id: string;
    fullName: string;
    firstName: string;
    status: UserStatus;
    emailVerified: boolean;
    memberSince: string;
  };
  enrollments: {
    active: number;
    pending: number;
    /** Up to 5 ACTIVE/PENDING enrollments, most recent first. */
    items: MemberDashboardEnrollmentDto[];
  };
  referrals: {
    directCount: number;
    /** Descendants up to depth 10 (the depth members can see). */
    teamSize: number;
  };
  rewards: RewardSummaryBucketDto[];
  unreadNotifications: number;
  /** Latest notifications and reward status changes, newest first (≤ 10). */
  recentActivity: MemberDashboardActivityDto[];
  /** Unread notifications of an `announcement*` type (≤ 3). */
  announcements: NotificationDto[];
}
