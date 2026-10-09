/**
 * Human labels + visual tone for every enum in `@app/shared` (statuses and other enumerations).
 * Used by `<StatusBadge>`, filter selects (`enumOptions`) and table cells (`enumLabel`).
 * TypeScript enforces that every enum value has an entry — adding a value to `@app/shared` without a
 * label here fails the typecheck.
 */
import {
  BillingFrequency,
  ChallengePurpose,
  EligibilityStatus,
  EnrollmentStatus,
  EntryDirection,
  FlagStatus,
  IneligibleAncestorBehavior,
  LedgerAccountType,
  LedgerTransactionType,
  OfferingKind,
  OfferingStatus,
  PolicyStatus,
  ProgramStatus,
  QualifyingEventSource,
  QualifyingEventStatus,
  QualifyingEventType,
  RenewalPolicy,
  RewardCalcType,
  RewardStatus,
  RewardUnit,
  RoleKey,
  ROLE_LABELS,
  RoundingMode,
  UserStatus,
} from '@app/shared';

export type StatusTone =
  | 'neutral'
  | 'muted'
  | 'primary'
  | 'info'
  | 'success'
  | 'warning'
  | 'destructive'
  /** Outlined red — for terminal "undone" states (REVERSED) that are not errors. */
  | 'destructive-outline';

export interface EnumMeta {
  label: string;
  tone: StatusTone;
  /** Optional longer explanation (tooltips, select descriptions). */
  description?: string;
}

/** Enum name → value union. */
export interface EnumValueMap {
  UserStatus: UserStatus;
  RewardUnit: RewardUnit;
  OfferingKind: OfferingKind;
  OfferingStatus: OfferingStatus;
  ProgramStatus: ProgramStatus;
  BillingFrequency: BillingFrequency;
  RenewalPolicy: RenewalPolicy;
  EnrollmentStatus: EnrollmentStatus;
  EligibilityStatus: EligibilityStatus;
  PolicyStatus: PolicyStatus;
  RewardCalcType: RewardCalcType;
  IneligibleAncestorBehavior: IneligibleAncestorBehavior;
  RoundingMode: RoundingMode;
  QualifyingEventType: QualifyingEventType;
  QualifyingEventSource: QualifyingEventSource;
  QualifyingEventStatus: QualifyingEventStatus;
  RewardStatus: RewardStatus;
  LedgerAccountType: LedgerAccountType;
  LedgerTransactionType: LedgerTransactionType;
  EntryDirection: EntryDirection;
  FlagStatus: FlagStatus;
  ChallengePurpose: ChallengePurpose;
  RoleKey: RoleKey;
}

export type EnumKind = keyof EnumValueMap;

type EnumMetaTable = { [K in EnumKind]: Record<EnumValueMap[K], EnumMeta> };

const m = (label: string, tone: StatusTone = 'neutral', description?: string): EnumMeta =>
  description ? { label, tone, description } : { label, tone };

export const ENUM_META: EnumMetaTable = {
  UserStatus: {
    PENDING_VERIFICATION: m('Pending verification', 'warning', 'Email address not verified yet'),
    ACTIVE: m('Active', 'success'),
    SUSPENDED: m('Suspended', 'destructive', 'Suspended by an administrator'),
    DEACTIVATED: m('Deactivated', 'muted'),
  },
  RewardUnit: {
    MONEY: m('Money'),
    POINTS: m('Points'),
  },
  OfferingKind: {
    PRODUCT: m('Product'),
    SERVICE: m('Service'),
  },
  OfferingStatus: {
    ACTIVE: m('Active', 'success'),
    INACTIVE: m('Inactive', 'muted'),
  },
  ProgramStatus: {
    DRAFT: m('Draft', 'neutral', 'Fully editable, not visible to members'),
    SCHEDULED: m('Scheduled', 'info', 'Published; starts automatically at its start date'),
    ACTIVE: m('Active', 'success'),
    PAUSED: m('Paused', 'warning', 'No enrollments; events are rejected'),
    COMPLETED: m('Completed', 'muted'),
    ARCHIVED: m('Archived', 'muted'),
  },
  BillingFrequency: {
    ONE_TIME: m('One-time'),
    MONTHLY: m('Monthly'),
    QUARTERLY: m('Quarterly'),
    HALF_YEARLY: m('Half-yearly'),
    YEARLY: m('Yearly'),
  },
  RenewalPolicy: {
    NONE: m('No renewal'),
    MANUAL: m('Manual renewal'),
    AUTOMATIC: m('Automatic renewal'),
  },
  EnrollmentStatus: {
    PENDING: m('Pending', 'warning', 'Awaiting activation by an administrator'),
    ACTIVE: m('Active', 'success'),
    CANCELLED: m('Cancelled', 'muted'),
    EXPIRED: m('Expired', 'muted'),
    REJECTED: m('Rejected', 'destructive'),
  },
  EligibilityStatus: {
    ELIGIBLE: m('Eligible', 'success'),
    INELIGIBLE: m('Ineligible', 'destructive-outline'),
    PENDING_REVIEW: m('Pending review', 'warning'),
  },
  PolicyStatus: {
    DRAFT: m('Draft', 'neutral'),
    PUBLISHED: m('Published', 'success'),
    RETIRED: m('Retired', 'muted'),
  },
  RewardCalcType: {
    FIXED: m('Fixed amount'),
    PERCENTAGE: m('Percentage of sale'),
  },
  IneligibleAncestorBehavior: {
    FORFEIT: m('Forfeit', 'neutral', "An ineligible ancestor's level is skipped"),
    COMPRESS: m('Compress', 'neutral', 'The next eligible ancestor moves up a level'),
  },
  RoundingMode: {
    HALF_UP: m('Half up'),
    HALF_EVEN: m("Half even (banker's)"),
    DOWN: m('Round down'),
  },
  QualifyingEventType: {
    PRODUCT_SALE: m('Product sale'),
    SERVICE_COMPLETED: m('Service completed'),
    SUBSCRIPTION_RENEWAL: m('Subscription renewal'),
  },
  QualifyingEventSource: {
    ADMIN_MANUAL: m('Manual entry'),
    API: m('API'),
    WEBHOOK: m('Webhook'),
  },
  QualifyingEventStatus: {
    RECEIVED: m('Received', 'info'),
    PROCESSED: m('Processed', 'success'),
    REJECTED: m('Rejected', 'destructive'),
    REVERSED: m('Reversed', 'destructive-outline', 'Refunded or charged back'),
  },
  RewardStatus: {
    PENDING_APPROVAL: m('Pending approval', 'warning'),
    APPROVED: m('Approved', 'info'),
    POSTED: m('Posted', 'success', 'Recorded in the ledger'),
    REJECTED: m('Rejected', 'destructive'),
    REVERSED: m('Reversed', 'destructive-outline', 'Reversed with a compensating ledger entry'),
  },
  LedgerAccountType: {
    PLATFORM_REWARD_EXPENSE: m('Platform reward expense'),
    MEMBER_REWARDS_PAYABLE: m('Member rewards payable'),
  },
  LedgerTransactionType: {
    REWARD_POSTING: m('Reward posting', 'success'),
    REWARD_REVERSAL: m('Reward reversal', 'destructive-outline'),
  },
  EntryDirection: {
    DEBIT: m('Debit'),
    CREDIT: m('Credit'),
  },
  FlagStatus: {
    OPEN: m('Open', 'warning'),
    RESOLVED: m('Resolved', 'success'),
    DISMISSED: m('Dismissed', 'muted'),
  },
  ChallengePurpose: {
    EMAIL_VERIFICATION: m('Email verification'),
    LOGIN_MFA: m('Sign-in verification'),
    PASSWORD_RESET: m('Password reset'),
    EMAIL_CHANGE: m('Email change'),
  },
  RoleKey: {
    SUPER_ADMIN: m(ROLE_LABELS.SUPER_ADMIN, 'primary'),
    PROGRAM_ADMIN: m(ROLE_LABELS.PROGRAM_ADMIN, 'info'),
    FINANCE_REVIEWER: m(ROLE_LABELS.FINANCE_REVIEWER, 'info'),
    MEMBER: m(ROLE_LABELS.MEMBER, 'neutral'),
  },
};

/** Value order for each enum (same order as `@app/shared`). */
export const ENUM_VALUES: { [K in EnumKind]: readonly EnumValueMap[K][] } = {
  UserStatus,
  RewardUnit,
  OfferingKind,
  OfferingStatus,
  ProgramStatus,
  BillingFrequency,
  RenewalPolicy,
  EnrollmentStatus,
  EligibilityStatus,
  PolicyStatus,
  RewardCalcType,
  IneligibleAncestorBehavior,
  RoundingMode,
  QualifyingEventType,
  QualifyingEventSource,
  QualifyingEventStatus,
  RewardStatus,
  LedgerAccountType,
  LedgerTransactionType,
  EntryDirection,
  FlagStatus,
  ChallengePurpose,
  RoleKey,
};

/** "PENDING_APPROVAL" → "Pending approval" (fallback for values the UI doesn't know yet). */
export function humanizeEnum(value: string): string {
  const words = value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return value;
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Label + tone for an enum value; unknown values degrade to a humanized neutral label. */
export function enumMeta<K extends EnumKind>(kind: K, value: EnumValueMap[K] | string): EnumMeta {
  const table = ENUM_META[kind] as Record<string, EnumMeta>;
  return table[value] ?? { label: humanizeEnum(String(value)), tone: 'neutral' };
}

export function enumLabel<K extends EnumKind>(kind: K, value: EnumValueMap[K] | string): string {
  return enumMeta(kind, value).label;
}

/** `[{ value, label, description }]` for selects and filters, in canonical order. */
export function enumOptions<K extends EnumKind>(
  kind: K,
  options: { exclude?: readonly EnumValueMap[K][] } = {},
): { value: EnumValueMap[K]; label: string; description?: string }[] {
  return ENUM_VALUES[kind]
    .filter((value) => !options.exclude?.includes(value))
    .map((value) => {
      const meta = enumMeta(kind, value);
      return { value, label: meta.label, description: meta.description };
    });
}
