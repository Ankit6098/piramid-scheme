// String-literal mirrors of the database enums. Keep in sync with apps/api/prisma/schema.prisma.
// (The API maps Prisma enums to these; the web app never imports Prisma.)

export const UserStatus = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof UserStatus)[number];

export const RewardUnit = ['MONEY', 'POINTS'] as const;
export type RewardUnit = (typeof RewardUnit)[number];

export const OfferingKind = ['PRODUCT', 'SERVICE'] as const;
export type OfferingKind = (typeof OfferingKind)[number];

export const OfferingStatus = ['ACTIVE', 'INACTIVE'] as const;
export type OfferingStatus = (typeof OfferingStatus)[number];

export const ProgramStatus = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
export type ProgramStatus = (typeof ProgramStatus)[number];

export const BillingFrequency = ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] as const;
export type BillingFrequency = (typeof BillingFrequency)[number];

export const RenewalPolicy = ['NONE', 'MANUAL', 'AUTOMATIC'] as const;
export type RenewalPolicy = (typeof RenewalPolicy)[number];

export const EnrollmentStatus = ['PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED', 'REJECTED'] as const;
export type EnrollmentStatus = (typeof EnrollmentStatus)[number];

export const EligibilityStatus = ['ELIGIBLE', 'INELIGIBLE', 'PENDING_REVIEW'] as const;
export type EligibilityStatus = (typeof EligibilityStatus)[number];

export const PolicyStatus = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type PolicyStatus = (typeof PolicyStatus)[number];

export const RewardCalcType = ['FIXED', 'PERCENTAGE'] as const;
export type RewardCalcType = (typeof RewardCalcType)[number];

export const IneligibleAncestorBehavior = ['FORFEIT', 'COMPRESS'] as const;
export type IneligibleAncestorBehavior = (typeof IneligibleAncestorBehavior)[number];

export const RoundingMode = ['HALF_UP', 'HALF_EVEN', 'DOWN'] as const;
export type RoundingMode = (typeof RoundingMode)[number];

/** Reward triggers. Enrollment / joining is intentionally absent — see docs/business-rules.md §0. */
export const QualifyingEventType = ['PRODUCT_SALE', 'SERVICE_COMPLETED', 'SUBSCRIPTION_RENEWAL'] as const;
export type QualifyingEventType = (typeof QualifyingEventType)[number];

export const QualifyingEventSource = ['ADMIN_MANUAL', 'API', 'WEBHOOK'] as const;
export type QualifyingEventSource = (typeof QualifyingEventSource)[number];

export const QualifyingEventStatus = ['RECEIVED', 'PROCESSED', 'REJECTED', 'REVERSED'] as const;
export type QualifyingEventStatus = (typeof QualifyingEventStatus)[number];

export const RewardStatus = ['PENDING_APPROVAL', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED'] as const;
export type RewardStatus = (typeof RewardStatus)[number];

export const LedgerAccountType = ['PLATFORM_REWARD_EXPENSE', 'MEMBER_REWARDS_PAYABLE'] as const;
export type LedgerAccountType = (typeof LedgerAccountType)[number];

export const LedgerTransactionType = ['REWARD_POSTING', 'REWARD_REVERSAL'] as const;
export type LedgerTransactionType = (typeof LedgerTransactionType)[number];

export const EntryDirection = ['DEBIT', 'CREDIT'] as const;
export type EntryDirection = (typeof EntryDirection)[number];

export const FlagStatus = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type FlagStatus = (typeof FlagStatus)[number];

export const ChallengePurpose = ['EMAIL_VERIFICATION', 'LOGIN_MFA', 'PASSWORD_RESET', 'EMAIL_CHANGE'] as const;
export type ChallengePurpose = (typeof ChallengePurpose)[number];
