-- Extensions required by trigram search indexes and exclusion constraints.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ChallengePurpose" AS ENUM ('EMAIL_VERIFICATION', 'LOGIN_MFA', 'PASSWORD_RESET', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "MfaMethod" AS ENUM ('EMAIL_OTP', 'TOTP');

-- CreateEnum
CREATE TYPE "MfaFactorKind" AS ENUM ('TOTP');

-- CreateEnum
CREATE TYPE "RewardUnit" AS ENUM ('MONEY', 'POINTS');

-- CreateEnum
CREATE TYPE "OfferingKind" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "OfferingStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProgramStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BillingFrequency" AS ENUM ('ONE_TIME', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "RenewalPolicy" AS ENUM ('NONE', 'MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('ELIGIBLE', 'INELIGIBLE', 'PENDING_REVIEW');

-- CreateEnum
CREATE TYPE "ReferralSource" AS ENUM ('REGISTRATION', 'ADMIN_CORRECTION');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "RewardCalcType" AS ENUM ('FIXED', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "IneligibleAncestorBehavior" AS ENUM ('FORFEIT', 'COMPRESS');

-- CreateEnum
CREATE TYPE "RoundingMode" AS ENUM ('HALF_UP', 'HALF_EVEN', 'DOWN');

-- CreateEnum
CREATE TYPE "QualifyingEventType" AS ENUM ('PRODUCT_SALE', 'SERVICE_COMPLETED', 'SUBSCRIPTION_RENEWAL');

-- CreateEnum
CREATE TYPE "QualifyingEventSource" AS ENUM ('ADMIN_MANUAL', 'API', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "QualifyingEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CalculationOutcome" AS ENUM ('REWARDS_CREATED', 'NO_ELIGIBLE_RECIPIENTS');

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('PLATFORM_REWARD_EXPENSE', 'MEMBER_REWARDS_PAYABLE');

-- CreateEnum
CREATE TYPE "LedgerTransactionType" AS ENUM ('REWARD_POSTING', 'REWARD_REVERSAL');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "currencies" (
    "code" CHAR(3) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "minor_units" SMALLINT NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "reward_unit" "RewardUnit" NOT NULL DEFAULT 'POINTS',
    "currency_code" CHAR(3) NOT NULL DEFAULT 'INR',
    "currency_minor_units" SMALLINT NOT NULL DEFAULT 2,
    "points_label" VARCHAR(32) NOT NULL DEFAULT 'Points',
    "points_per_currency_unit" INTEGER NOT NULL DEFAULT 1,
    "default_reward_budget_bps" INTEGER NOT NULL DEFAULT 2000,
    "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "password_hash" VARCHAR(255),
    "password_changed_at" TIMESTAMPTZ(3),
    "phone" VARCHAR(20),
    "phone_verified_at" TIMESTAMPTZ(3),
    "avatar_url" VARCHAR(2048),
    "last_login_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "suspension_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "mfa_verified_at" TIMESTAMPTZ(3),
    "mfa_method" "MfaMethod",
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" VARCHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "session_id" UUID,
    "email" VARCHAR(254) NOT NULL,
    "purpose" "ChallengePurpose" NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "send_count" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "pending_full_name" VARCHAR(120),
    "pending_password_hash" VARCHAR(255),
    "pending_referral_code_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "MfaFactorKind" NOT NULL,
    "label" VARCHAR(64) NOT NULL DEFAULT 'Authenticator app',
    "secret_enc" BYTEA NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "last_used_step" BIGINT,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "program_admin_assignments" (
    "user_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_admin_assignments_pkey" PRIMARY KEY ("user_id","program_id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "actor_user_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "route" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" SMALLINT,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("actor_user_id","key")
);

-- CreateTable
CREATE TABLE "offerings" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "kind" "OfferingKind" NOT NULL,
    "sku" VARCHAR(64),
    "status" "OfferingStatus" NOT NULL DEFAULT 'INACTIVE',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(5000),
    "status" "ProgramStatus" NOT NULL DEFAULT 'DRAFT',
    "offering_id" UUID NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "enrollment_opens_at" TIMESTAMPTZ(3) NOT NULL,
    "enrollment_closes_at" TIMESTAMPTZ(3),
    "max_reward_depth" SMALLINT NOT NULL DEFAULT 5,
    "late_event_grace_days" SMALLINT NOT NULL DEFAULT 30,
    "reward_unit" "RewardUnit" NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "currency_minor_units" SMALLINT NOT NULL,
    "eligibility" JSONB NOT NULL DEFAULT '{}',
    "terms_version" VARCHAR(32) NOT NULL DEFAULT '1.0',
    "terms_text" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_status_changes" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "from_status" "ProgramStatus",
    "to_status" "ProgramStatus" NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by_id" UUID,
    "reason" VARCHAR(1000),

    CONSTRAINT "program_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_options" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "price_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "billing_frequency" "BillingFrequency" NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "renewal_policy" "RenewalPolicy" NOT NULL DEFAULT 'MANUAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "program_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_enrollments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "option_snapshot" JSONB NOT NULL,
    "terms_version" VARCHAR(32) NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "eligibility_status" "EligibilityStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "sponsor_user_id" UUID,
    "effective_from" TIMESTAMPTZ(3),
    "effective_to" TIMESTAMPTZ(3),
    "payment_reference" VARCHAR(128),
    "payment_amount_minor" BIGINT,
    "payment_recorded_by_id" UUID,
    "payment_recorded_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "status_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "program_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "program_id" UUID,
    "code" VARCHAR(16) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_relationships" (
    "id" UUID NOT NULL,
    "child_user_id" UUID NOT NULL,
    "sponsor_user_id" UUID NOT NULL,
    "referral_code_id" UUID,
    "source" "ReferralSource" NOT NULL DEFAULT 'REGISTRATION',
    "registration_ip" INET,
    "registration_user_agent" VARCHAR(512),
    "attributed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "referral_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_paths" (
    "ancestor_id" UUID NOT NULL,
    "descendant_id" UUID NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "referral_paths_pkey" PRIMARY KEY ("ancestor_id","descendant_id")
);

-- CreateTable
CREATE TABLE "referral_corrections" (
    "id" UUID NOT NULL,
    "child_user_id" UUID NOT NULL,
    "previous_sponsor_id" UUID,
    "new_sponsor_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "performed_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_policy_versions" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "name" VARCHAR(160) NOT NULL,
    "notes" VARCHAR(2000),
    "trigger_event_types" "QualifyingEventType"[],
    "max_depth" SMALLINT NOT NULL,
    "budget_bps" INTEGER NOT NULL,
    "max_total_per_event_minor" BIGINT,
    "min_event_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "points_per_currency_unit" INTEGER NOT NULL DEFAULT 1,
    "ineligible_ancestor_behavior" "IneligibleAncestorBehavior" NOT NULL DEFAULT 'FORFEIT',
    "rounding_mode" "RoundingMode" NOT NULL DEFAULT 'HALF_UP',
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "require_active_enrollment" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reward_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_rules" (
    "id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "level" SMALLINT NOT NULL,
    "calc_type" "RewardCalcType" NOT NULL,
    "fixed_amount_minor" BIGINT,
    "percentage_bps" INTEGER,
    "cap_minor" BIGINT,

    CONSTRAINT "reward_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_clients" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "program_id" UUID NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualifying_events" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "type" "QualifyingEventType" NOT NULL,
    "source" "QualifyingEventSource" NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "revision" SMALLINT NOT NULL DEFAULT 0,
    "supersedes_event_id" UUID,
    "request_hash" CHAR(64) NOT NULL,
    "customer_reference" VARCHAR(128) NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "QualifyingEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "policy_version_id" UUID,
    "processed_at" TIMESTAMPTZ(3),
    "rejection_reason" VARCHAR(500),
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" VARCHAR(500),
    "description" VARCHAR(500),
    "recorded_by_id" UUID,
    "api_client_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "qualifying_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_calculations" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "outcome" "CalculationOutcome" NOT NULL,
    "reward_unit" "RewardUnit" NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "currency_minor_units" SMALLINT NOT NULL,
    "points_per_currency_unit" INTEGER NOT NULL,
    "base_minor" BIGINT NOT NULL,
    "budget_bps" INTEGER NOT NULL,
    "budget_minor" BIGINT NOT NULL,
    "total_allocated_minor" BIGINT NOT NULL,
    "trace" JSONB NOT NULL,
    "engine_version" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_calculations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rewards" (
    "id" UUID NOT NULL,
    "calculation_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "level" SMALLINT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reward_unit" "RewardUnit" NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "status" "RewardStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "rejection_reason" VARCHAR(500),
    "posted_at" TIMESTAMPTZ(3),
    "reversed_by_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "user_id" UUID,
    "reward_unit" "RewardUnit" NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "type" "LedgerTransactionType" NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "reward_id" UUID NOT NULL,
    "reverses_transaction_id" UUID,
    "entry_count" SMALLINT NOT NULL,
    "debit_total_minor" BIGINT NOT NULL,
    "description" VARCHAR(500),
    "posted_by_id" UUID,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reward_unit" "RewardUnit" NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_roles" TEXT[],
    "action" VARCHAR(96) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(64),
    "program_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(1000),
    "request_id" VARCHAR(64),
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "data" JSONB,
    "source_key" VARCHAR(160),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(96) NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" VARCHAR(160),
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(2000),
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_flags" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "details" VARCHAR(2000) NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "dedupe_key" VARCHAR(160),
    "created_by_id" UUID,
    "resolved_by_id" UUID,
    "resolution" VARCHAR(1000),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "member_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_currencies_code_minor_units" ON "currencies"("code", "minor_units");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "ix_users_full_name_trgm" ON "users" USING GIN ("full_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ix_users_email_trgm" ON "users" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "email_challenges_email_purpose_created_at_idx" ON "email_challenges"("email", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "email_challenges_user_id_purpose_idx" ON "email_challenges"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "user_mfa_factors_user_id_idx" ON "user_mfa_factors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "program_admin_assignments_program_id_idx" ON "program_admin_assignments"("program_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "offerings_sku_key" ON "offerings"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "programs_code_key" ON "programs"("code");

-- CreateIndex
CREATE INDEX "programs_status_idx" ON "programs"("status");

-- CreateIndex
CREATE INDEX "program_status_changes_program_id_changed_at_idx" ON "program_status_changes"("program_id", "changed_at");

-- CreateIndex
CREATE INDEX "program_options_program_id_is_active_idx" ON "program_options"("program_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "program_enrollments_payment_reference_key" ON "program_enrollments"("payment_reference");

-- CreateIndex
CREATE INDEX "program_enrollments_user_id_program_id_idx" ON "program_enrollments"("user_id", "program_id");

-- CreateIndex
CREATE INDEX "program_enrollments_program_id_status_idx" ON "program_enrollments"("program_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_user_id_idx" ON "referral_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_relationships_child_user_id_key" ON "referral_relationships"("child_user_id");

-- CreateIndex
CREATE INDEX "referral_relationships_sponsor_user_id_attributed_at_idx" ON "referral_relationships"("sponsor_user_id", "attributed_at");

-- CreateIndex
CREATE INDEX "referral_relationships_sponsor_user_id_registration_ip_attr_idx" ON "referral_relationships"("sponsor_user_id", "registration_ip", "attributed_at");

-- CreateIndex
CREATE INDEX "referral_paths_ancestor_id_depth_idx" ON "referral_paths"("ancestor_id", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "uq_referral_paths_descendant_depth" ON "referral_paths"("descendant_id", "depth");

-- CreateIndex
CREATE INDEX "referral_corrections_child_user_id_idx" ON "referral_corrections"("child_user_id");

-- CreateIndex
CREATE INDEX "reward_policy_versions_program_id_status_effective_from_idx" ON "reward_policy_versions"("program_id", "status", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "reward_policy_versions_program_id_version_key" ON "reward_policy_versions"("program_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "reward_rules_policy_version_id_level_key" ON "reward_rules"("policy_version_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_key_hash_key" ON "api_clients"("key_hash");

-- CreateIndex
CREATE INDEX "api_clients_program_id_idx" ON "api_clients"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "qualifying_events_supersedes_event_id_key" ON "qualifying_events"("supersedes_event_id");

-- CreateIndex
CREATE INDEX "qualifying_events_program_id_status_occurred_at_idx" ON "qualifying_events"("program_id", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "qualifying_events_subject_user_id_idx" ON "qualifying_events"("subject_user_id");

-- CreateIndex
CREATE INDEX "qualifying_events_created_at_idx" ON "qualifying_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_events_sale_revision" ON "qualifying_events"("offering_id", "external_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "reward_calculations_event_id_key" ON "reward_calculations"("event_id");

-- CreateIndex
CREATE INDEX "rewards_recipient_user_id_status_created_at_idx" ON "rewards"("recipient_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "rewards_status_created_at_idx" ON "rewards"("status", "created_at");

-- CreateIndex
CREATE INDEX "rewards_program_id_status_created_at_idx" ON "rewards"("program_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "rewards_created_at_idx" ON "rewards"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rewards_event_id_level_key" ON "rewards"("event_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rewards_event_recipient" ON "rewards"("event_id", "recipient_user_id");

-- CreateIndex
CREATE INDEX "ledger_accounts_user_id_idx" ON "ledger_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_reverses_transaction_id_key" ON "ledger_transactions"("reverses_transaction_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_posted_at_idx" ON "ledger_transactions"("posted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ledger_txn_reward_type" ON "ledger_transactions"("reward_id", "type");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_created_at_idx" ON "ledger_entries"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_created_at_idx" ON "audit_logs"("resource_type", "resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_program_id_created_at_idx" ON "audit_logs"("program_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_source_key_key" ON "notifications"("source_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_dedupe_key_key" ON "outbox_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_messages_status_available_at_idx" ON "outbox_messages"("status", "available_at");

-- CreateIndex
CREATE INDEX "member_flags_status_created_at_idx" ON "member_flags"("status", "created_at");

-- CreateIndex
CREATE INDEX "member_flags_user_id_idx" ON "member_flags"("user_id");

-- AddForeignKey
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_currency_code_currency_minor_units_fkey" FOREIGN KEY ("currency_code", "currency_minor_units") REFERENCES "currencies"("code", "minor_units") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_challenges" ADD CONSTRAINT "email_challenges_pending_referral_code_id_fkey" FOREIGN KEY ("pending_referral_code_id") REFERENCES "referral_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_mfa_factors" ADD CONSTRAINT "user_mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_admin_assignments" ADD CONSTRAINT "program_admin_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_admin_assignments" ADD CONSTRAINT "program_admin_assignments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_currency_code_currency_minor_units_fkey" FOREIGN KEY ("currency_code", "currency_minor_units") REFERENCES "currencies"("code", "minor_units") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_status_changes" ADD CONSTRAINT "program_status_changes_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_status_changes" ADD CONSTRAINT "program_status_changes_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_options" ADD CONSTRAINT "program_options_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "program_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_sponsor_user_id_fkey" FOREIGN KEY ("sponsor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_enrollments" ADD CONSTRAINT "program_enrollments_payment_recorded_by_id_fkey" FOREIGN KEY ("payment_recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_child_user_id_fkey" FOREIGN KEY ("child_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_sponsor_user_id_fkey" FOREIGN KEY ("sponsor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referral_code_id_fkey" FOREIGN KEY ("referral_code_id") REFERENCES "referral_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_paths" ADD CONSTRAINT "referral_paths_ancestor_id_fkey" FOREIGN KEY ("ancestor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_paths" ADD CONSTRAINT "referral_paths_descendant_id_fkey" FOREIGN KEY ("descendant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_corrections" ADD CONSTRAINT "referral_corrections_child_user_id_fkey" FOREIGN KEY ("child_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_corrections" ADD CONSTRAINT "referral_corrections_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_policy_versions" ADD CONSTRAINT "reward_policy_versions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_policy_versions" ADD CONSTRAINT "reward_policy_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_policy_versions" ADD CONSTRAINT "reward_policy_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "reward_policy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "reward_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_api_client_id_fkey" FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifying_events" ADD CONSTRAINT "qualifying_events_supersedes_event_id_fkey" FOREIGN KEY ("supersedes_event_id") REFERENCES "qualifying_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_calculations" ADD CONSTRAINT "reward_calculations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "qualifying_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_calculations" ADD CONSTRAINT "reward_calculations_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "reward_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_calculation_id_fkey" FOREIGN KEY ("calculation_id") REFERENCES "reward_calculations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "qualifying_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "reward_policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reward_id_fkey" FOREIGN KEY ("reward_id") REFERENCES "rewards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reverses_transaction_id_fkey" FOREIGN KEY ("reverses_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_flags" ADD CONSTRAINT "member_flags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_flags" ADD CONSTRAINT "member_flags_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_flags" ADD CONSTRAINT "member_flags_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

