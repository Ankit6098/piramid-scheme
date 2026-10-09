-- ════════════════════════════════════════════════════════════════════════════
-- Integrity constraints that Prisma cannot express.
-- These are the database's last line of defence for business-critical invariants.
-- Application code must still validate first and produce friendly errors; these
-- constraints exist so that bugs, races and manual SQL cannot corrupt the data.
-- See docs/database.md for the rationale of each group.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Shared helper: reject any UPDATE / DELETE on append-only tables.
CREATE OR REPLACE FUNCTION app_forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table "%" is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ─── platform_settings ─────────────────────────────────────────────────────
ALTER TABLE "platform_settings"
  ADD CONSTRAINT "ck_platform_settings_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "ck_platform_settings_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ck_platform_settings_minor_units" CHECK ("currency_minor_units" BETWEEN 0 AND 4),
  ADD CONSTRAINT "ck_platform_settings_points_rate" CHECK ("points_per_currency_unit" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "ck_platform_settings_budget" CHECK ("default_reward_budget_bps" BETWEEN 1 AND 5000),
  ADD CONSTRAINT "ck_platform_settings_points_label" CHECK (length(btrim("points_label")) > 0),
  ADD CONSTRAINT "ck_platform_settings_version" CHECK ("version" >= 1);

-- ─── users / auth ──────────────────────────────────────────────────────────
ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_email_normalized" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "ck_users_full_name" CHECK (length(btrim("full_name")) > 0),
  ADD CONSTRAINT "ck_users_failed_login_nonneg" CHECK ("failed_login_count" >= 0);

ALTER TABLE "sessions"
  ADD CONSTRAINT "ck_sessions_expiry" CHECK ("expires_at" > "created_at");

ALTER TABLE "email_challenges"
  ADD CONSTRAINT "ck_email_challenges_attempts" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts"),
  ADD CONSTRAINT "ck_email_challenges_send_count" CHECK ("send_count" >= 1),
  ADD CONSTRAINT "ck_email_challenges_expiry" CHECK ("expires_at" > "created_at");

-- ─── offerings / programs / options ────────────────────────────────────────
ALTER TABLE "offerings"
  ADD CONSTRAINT "ck_offerings_name" CHECK (length(btrim("name")) > 0);

ALTER TABLE "programs"
  ADD CONSTRAINT "ck_programs_code_slug" CHECK ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "ck_programs_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ck_programs_dates" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  ADD CONSTRAINT "ck_programs_enrollment_window" CHECK ("enrollment_closes_at" IS NULL OR "enrollment_closes_at" > "enrollment_opens_at"),
  ADD CONSTRAINT "ck_programs_enrollment_within_program" CHECK (
    "ends_at" IS NULL
    OR ("enrollment_opens_at" < "ends_at" AND ("enrollment_closes_at" IS NULL OR "enrollment_closes_at" <= "ends_at"))
  ),
  ADD CONSTRAINT "ck_programs_max_depth" CHECK ("max_reward_depth" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ck_programs_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "ck_programs_published_at" CHECK ("status" = 'DRAFT' OR "published_at" IS NOT NULL);

-- Unit and currency are frozen once a program leaves DRAFT.
CREATE OR REPLACE FUNCTION app_programs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' AND (
       NEW."reward_unit" IS DISTINCT FROM OLD."reward_unit"
    OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
    OR NEW."offering_id" IS DISTINCT FROM OLD."offering_id"
  ) THEN
    RAISE EXCEPTION 'Program % is published; reward unit, currency and offering are immutable', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'DRAFT' AND OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Program % cannot return to DRAFT', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_programs_guard" BEFORE UPDATE ON "programs"
  FOR EACH ROW EXECUTE FUNCTION app_programs_guard();

CREATE OR REPLACE FUNCTION app_programs_forbid_delete_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Only DRAFT programs can be deleted (program %)', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "trg_programs_forbid_delete" BEFORE DELETE ON "programs"
  FOR EACH ROW EXECUTE FUNCTION app_programs_forbid_delete_published();

ALTER TABLE "program_options"
  ADD CONSTRAINT "ck_program_options_price" CHECK ("price_minor" >= 0),
  ADD CONSTRAINT "ck_program_options_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ck_program_options_duration" CHECK ("duration_days" BETWEEN 1 AND 3660),
  ADD CONSTRAINT "ck_program_options_name" CHECK (length(btrim("name")) > 0);

-- ─── enrollments ───────────────────────────────────────────────────────────
-- At most one open (PENDING / ACTIVE) enrollment per member per program. This is the
-- authoritative guard against concurrent double-enrollment.
CREATE UNIQUE INDEX "uq_enrollments_one_open_per_program"
  ON "program_enrollments" ("user_id", "program_id")
  WHERE "status" IN ('PENDING', 'ACTIVE');

ALTER TABLE "program_enrollments"
  ADD CONSTRAINT "ck_enrollments_effective_range" CHECK ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" > "effective_from"),
  ADD CONSTRAINT "ck_enrollments_not_self_sponsored" CHECK ("sponsor_user_id" IS NULL OR "sponsor_user_id" <> "user_id"),
  ADD CONSTRAINT "ck_enrollments_active_has_start" CHECK ("status" <> 'ACTIVE' OR "effective_from" IS NOT NULL);

-- The option snapshot and attribution are historical facts and never change.
CREATE OR REPLACE FUNCTION app_enrollments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."option_snapshot" IS DISTINCT FROM OLD."option_snapshot"
     OR NEW."option_id" IS DISTINCT FROM OLD."option_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."program_id" IS DISTINCT FROM OLD."program_id"
     OR NEW."terms_version" IS DISTINCT FROM OLD."terms_version"
     OR NEW."sponsor_user_id" IS DISTINCT FROM OLD."sponsor_user_id"
  THEN
    RAISE EXCEPTION 'Enrollment % terms and attribution are immutable', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'EXPIRED', 'REJECTED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Enrollment % is in terminal status %', OLD."id", OLD."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_enrollments_guard" BEFORE UPDATE ON "program_enrollments"
  FOR EACH ROW EXECUTE FUNCTION app_enrollments_guard();

-- ─── referral codes / relationships / closure table ───────────────────────
CREATE UNIQUE INDEX "uq_referral_codes_global_per_user"
  ON "referral_codes" ("user_id")
  WHERE "program_id" IS NULL AND "is_active";

ALTER TABLE "referral_codes"
  ADD CONSTRAINT "ck_referral_codes_format" CHECK ("code" ~ '^[A-Z0-9]{6,16}$');

ALTER TABLE "referral_relationships"
  ADD CONSTRAINT "ck_referral_relationships_not_self" CHECK ("child_user_id" <> "sponsor_user_id");

ALTER TABLE "referral_paths"
  ADD CONSTRAINT "ck_referral_paths_depth" CHECK ("depth" >= 0 AND "depth" <= 1000),
  ADD CONSTRAINT "ck_referral_paths_self_row" CHECK (("depth" = 0) = ("ancestor_id" = "descendant_id"));

-- Referral attribution is immutable by default. The audited admin-correction workflow sets
-- the transaction-local flag `app.referral_correction = 'on'` (SET LOCAL) before changing rows.
CREATE OR REPLACE FUNCTION app_referral_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.referral_correction', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Referral attribution on "%" is immutable outside the audited correction workflow', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_referral_relationships_guard" BEFORE UPDATE OR DELETE ON "referral_relationships"
  FOR EACH ROW EXECUTE FUNCTION app_referral_guard();
CREATE TRIGGER "trg_referral_paths_guard" BEFORE UPDATE OR DELETE ON "referral_paths"
  FOR EACH ROW EXECUTE FUNCTION app_referral_guard();

CREATE TRIGGER "trg_referral_corrections_append_only" BEFORE UPDATE OR DELETE ON "referral_corrections"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

ALTER TABLE "referral_corrections"
  ADD CONSTRAINT "ck_referral_corrections_not_self" CHECK ("child_user_id" <> "new_sponsor_id"),
  ADD CONSTRAINT "ck_referral_corrections_reason" CHECK (length(btrim("reason")) >= 10);

-- ─── reward policy versions & rules ────────────────────────────────────────
ALTER TABLE "reward_policy_versions"
  ADD CONSTRAINT "ck_policy_versions_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "ck_policy_versions_max_depth" CHECK ("max_depth" BETWEEN 1 AND 10),
  -- HARD CAP: total rewards can never exceed 50% of the qualifying sale amount.
  ADD CONSTRAINT "ck_policy_versions_budget" CHECK ("budget_bps" BETWEEN 1 AND 5000),
  ADD CONSTRAINT "ck_policy_versions_max_total" CHECK ("max_total_per_event_minor" IS NULL OR "max_total_per_event_minor" > 0),
  ADD CONSTRAINT "ck_policy_versions_min_amount" CHECK ("min_event_amount_minor" >= 0),
  ADD CONSTRAINT "ck_policy_versions_effective_range" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  ADD CONSTRAINT "ck_policy_versions_triggers" CHECK (cardinality("trigger_event_types") >= 1),
  ADD CONSTRAINT "ck_policy_versions_published_at" CHECK ("status" = 'DRAFT' OR "published_at" IS NOT NULL),
  ADD CONSTRAINT "ck_policy_versions_retired_at" CHECK ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL);

-- Effective ranges of non-draft versions never overlap within a program, so exactly one
-- version applies to any instant.
ALTER TABLE "reward_policy_versions"
  ADD CONSTRAINT "ex_policy_versions_no_overlap" EXCLUDE USING gist (
    "program_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" IN ('PUBLISHED', 'RETIRED'));

-- Published versions are immutable, except: retiring them, and closing (shortening) the
-- effective range to a point that is not in the past.
CREATE OR REPLACE FUNCTION app_policy_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Published policy version % cannot be deleted', OLD."id" USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'A DRAFT policy version cannot be retired directly' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Policy version % cannot return to DRAFT', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
    RAISE EXCEPTION 'Policy version % is retired', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."program_id" IS DISTINCT FROM OLD."program_id"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."trigger_event_types" IS DISTINCT FROM OLD."trigger_event_types"
     OR NEW."max_depth" IS DISTINCT FROM OLD."max_depth"
     OR NEW."budget_bps" IS DISTINCT FROM OLD."budget_bps"
     OR NEW."max_total_per_event_minor" IS DISTINCT FROM OLD."max_total_per_event_minor"
     OR NEW."min_event_amount_minor" IS DISTINCT FROM OLD."min_event_amount_minor"
     OR NEW."ineligible_ancestor_behavior" IS DISTINCT FROM OLD."ineligible_ancestor_behavior"
     OR NEW."rounding_mode" IS DISTINCT FROM OLD."rounding_mode"
     OR NEW."requires_approval" IS DISTINCT FROM OLD."requires_approval"
     OR NEW."require_active_enrollment" IS DISTINCT FROM OLD."require_active_enrollment"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
     OR NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
     OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
  THEN
    RAISE EXCEPTION 'Published policy version % is immutable; create a new version instead', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."effective_to" IS DISTINCT FROM OLD."effective_to" THEN
    IF NEW."effective_to" IS NULL
       OR (OLD."effective_to" IS NOT NULL AND NEW."effective_to" > OLD."effective_to")
       OR NEW."effective_to" < now() - interval '1 minute'
    THEN
      RAISE EXCEPTION 'Policy version % effective range may only be closed, and not in the past', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_policy_versions_guard" BEFORE UPDATE OR DELETE ON "reward_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION app_policy_versions_guard();

ALTER TABLE "reward_rules"
  ADD CONSTRAINT "ck_reward_rules_level" CHECK ("level" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ck_reward_rules_calc" CHECK (
    ("calc_type" = 'FIXED' AND "fixed_amount_minor" IS NOT NULL AND "fixed_amount_minor" > 0 AND "percentage_bps" IS NULL)
    OR
    ("calc_type" = 'PERCENTAGE' AND "percentage_bps" IS NOT NULL AND "percentage_bps" BETWEEN 1 AND 5000 AND "fixed_amount_minor" IS NULL)
  ),
  ADD CONSTRAINT "ck_reward_rules_cap" CHECK ("cap_minor" IS NULL OR "cap_minor" > 0);

-- Rules can only change while their policy version is a DRAFT.
CREATE OR REPLACE FUNCTION app_reward_rules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status "PolicyStatus";
  v_policy_id uuid;
BEGIN
  v_policy_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."policy_version_id" ELSE NEW."policy_version_id" END;
  SELECT "status" INTO v_status FROM "reward_policy_versions" WHERE "id" = v_policy_id;
  -- Parent already gone (cascade delete of a DRAFT version) → allow.
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Rules of published policy version % are immutable', v_policy_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."policy_version_id" <> OLD."policy_version_id" THEN
    RAISE EXCEPTION 'Rules cannot move between policy versions' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_reward_rules_guard" BEFORE INSERT OR UPDATE OR DELETE ON "reward_rules"
  FOR EACH ROW EXECUTE FUNCTION app_reward_rules_guard();

-- ─── qualifying events ─────────────────────────────────────────────────────
ALTER TABLE "qualifying_events"
  ADD CONSTRAINT "ck_events_amount" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ck_events_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ck_events_external_id" CHECK (length(btrim("external_id")) > 0),
  ADD CONSTRAINT "ck_events_processed" CHECK ("status" NOT IN ('PROCESSED', 'REVERSED') OR "processed_at" IS NOT NULL),
  ADD CONSTRAINT "ck_events_rejected" CHECK ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL),
  ADD CONSTRAINT "ck_events_reversed" CHECK ("status" <> 'REVERSED' OR "reversed_at" IS NOT NULL);

-- The facts of an event never change; only its processing state moves forward.
CREATE OR REPLACE FUNCTION app_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Qualifying events cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."program_id" IS DISTINCT FROM OLD."program_id"
     OR NEW."offering_id" IS DISTINCT FROM OLD."offering_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
     OR NEW."subject_user_id" IS DISTINCT FROM OLD."subject_user_id"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
     OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
     OR NEW."recorded_by_id" IS DISTINCT FROM OLD."recorded_by_id"
     OR (OLD."policy_version_id" IS NOT NULL AND NEW."policy_version_id" IS DISTINCT FROM OLD."policy_version_id")
  THEN
    RAISE EXCEPTION 'Qualifying event % facts are immutable', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'RECEIVED' AND NEW."status" IN ('PROCESSED', 'REJECTED'))
    OR (OLD."status" = 'PROCESSED' AND NEW."status" = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'Invalid event status transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_events_guard" BEFORE UPDATE OR DELETE ON "qualifying_events"
  FOR EACH ROW EXECUTE FUNCTION app_events_guard();

-- ─── reward calculations (append-only) ────────────────────────────────────
ALTER TABLE "reward_calculations"
  ADD CONSTRAINT "ck_calculations_amounts" CHECK (
    "budget_minor" >= 0 AND "total_allocated_minor" >= 0 AND "total_allocated_minor" <= "budget_minor"
  ),
  ADD CONSTRAINT "ck_calculations_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');

CREATE TRIGGER "trg_calculations_append_only" BEFORE UPDATE OR DELETE ON "reward_calculations"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

-- ─── rewards ───────────────────────────────────────────────────────────────
ALTER TABLE "rewards"
  ADD CONSTRAINT "ck_rewards_amount" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ck_rewards_level" CHECK ("level" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ck_rewards_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ck_rewards_approved" CHECK ("status" NOT IN ('APPROVED', 'POSTED', 'REVERSED') OR "approved_at" IS NOT NULL),
  ADD CONSTRAINT "ck_rewards_posted" CHECK ("status" NOT IN ('POSTED', 'REVERSED') OR "posted_at" IS NOT NULL),
  ADD CONSTRAINT "ck_rewards_rejected" CHECK ("status" <> 'REJECTED' OR ("rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL)),
  ADD CONSTRAINT "ck_rewards_reversed" CHECK ("status" <> 'REVERSED' OR ("reversed_at" IS NOT NULL AND "reversal_reason" IS NOT NULL));

-- Calculated facts are immutable; status follows a strict state machine:
--   PENDING_APPROVAL → APPROVED | REJECTED
--   APPROVED         → POSTED   | REJECTED
--   POSTED           → REVERSED
CREATE OR REPLACE FUNCTION app_rewards_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rewards cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."calculation_id" IS DISTINCT FROM OLD."calculation_id"
     OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."program_id" IS DISTINCT FROM OLD."program_id"
     OR NEW."policy_version_id" IS DISTINCT FROM OLD."policy_version_id"
     OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
     OR NEW."level" IS DISTINCT FROM OLD."level"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."reward_unit" IS DISTINCT FROM OLD."reward_unit"
     OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
  THEN
    RAISE EXCEPTION 'Reward % calculated values are immutable', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('APPROVED', 'REJECTED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('POSTED', 'REJECTED'))
    OR (OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED')
  ) THEN
    RAISE EXCEPTION 'Invalid reward status transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_rewards_guard" BEFORE UPDATE OR DELETE ON "rewards"
  FOR EACH ROW EXECUTE FUNCTION app_rewards_guard();

-- ─── ledger (append-only, double-entry) ───────────────────────────────────
-- One account per (type, owner, unit, currency). Split into two partial indexes because the
-- platform accounts have a NULL owner.
CREATE UNIQUE INDEX "uq_ledger_accounts_member"
  ON "ledger_accounts" ("type", "user_id", "reward_unit", "currency_code")
  WHERE "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "uq_ledger_accounts_platform"
  ON "ledger_accounts" ("type", "reward_unit", "currency_code")
  WHERE "user_id" IS NULL;

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ck_ledger_accounts_owner" CHECK (("type" = 'MEMBER_REWARDS_PAYABLE') = ("user_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_ledger_accounts_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');

CREATE TRIGGER "trg_ledger_accounts_append_only" BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ck_ledger_txn_reversal_ref" CHECK (("type" = 'REWARD_REVERSAL') = ("reverses_transaction_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_ledger_txn_not_self_reversal" CHECK ("reverses_transaction_id" IS NULL OR "reverses_transaction_id" <> "id");

CREATE TRIGGER "trg_ledger_transactions_append_only" BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ck_ledger_entries_amount" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ck_ledger_entries_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');

CREATE TRIGGER "trg_ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

-- An entry's unit/currency must match its account's.
CREATE OR REPLACE FUNCTION app_ledger_entry_currency_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_unit "RewardUnit";
  v_currency char(3);
BEGIN
  SELECT "reward_unit", "currency_code" INTO v_unit, v_currency FROM "ledger_accounts" WHERE "id" = NEW."account_id";
  IF v_unit IS DISTINCT FROM NEW."reward_unit" OR v_currency IS DISTINCT FROM NEW."currency_code" THEN
    RAISE EXCEPTION 'Ledger entry unit/currency (% %) does not match account % (% %)',
      NEW."reward_unit", NEW."currency_code", NEW."account_id", v_unit, v_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_ledger_entries_currency" BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION app_ledger_entry_currency_guard();

-- Every transaction must have ≥ 2 entries and balance (Σ debits = Σ credits) per unit and
-- currency. Checked at COMMIT (deferred) so entries can be inserted one by one.
CREATE OR REPLACE FUNCTION app_ledger_assert_balanced(p_transaction_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
  v_unbalanced int;
BEGIN
  SELECT count(*) INTO v_count FROM "ledger_entries" WHERE "transaction_id" = p_transaction_id;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % must have at least two entries (has %)', p_transaction_id, v_count
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_unbalanced FROM (
    SELECT "reward_unit", "currency_code"
    FROM "ledger_entries"
    WHERE "transaction_id" = p_transaction_id
    GROUP BY "reward_unit", "currency_code"
    HAVING sum(CASE WHEN "direction" = 'DEBIT' THEN "amount_minor" ELSE 0 END)
        <> sum(CASE WHEN "direction" = 'CREDIT' THEN "amount_minor" ELSE 0 END)
  ) unbalanced;
  IF v_unbalanced > 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced', p_transaction_id USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_ledger_txn_balanced_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_ledger_assert_balanced(NEW."id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_ledger_transactions_balanced"
  AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_ledger_txn_balanced_trigger();

CREATE OR REPLACE FUNCTION app_ledger_entry_balanced_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_ledger_assert_balanced(NEW."transaction_id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_ledger_entry_balanced_trigger();

-- Balances per account (credit-normal for member payables, debit-normal for expense).
CREATE VIEW "ledger_account_balances" AS
SELECT
  a."id" AS "account_id",
  a."type",
  a."user_id",
  a."reward_unit",
  a."currency_code",
  coalesce(sum(CASE WHEN e."direction" = 'CREDIT' THEN e."amount_minor" ELSE 0 END), 0)::bigint AS "credits_minor",
  coalesce(sum(CASE WHEN e."direction" = 'DEBIT' THEN e."amount_minor" ELSE 0 END), 0)::bigint AS "debits_minor"
FROM "ledger_accounts" a
LEFT JOIN "ledger_entries" e ON e."account_id" = a."id"
GROUP BY a."id";

-- ─── audit (append-only) ───────────────────────────────────────────────────
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "ck_audit_logs_action" CHECK (length(btrim("action")) > 0);

CREATE TRIGGER "trg_audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

-- ─── outbox / flags ────────────────────────────────────────────────────────
ALTER TABLE "outbox_messages"
  ADD CONSTRAINT "ck_outbox_attempts" CHECK ("attempts" >= 0 AND "max_attempts" >= 1);

ALTER TABLE "member_flags"
  ADD CONSTRAINT "ck_member_flags_resolved" CHECK ("status" = 'OPEN' OR "resolved_at" IS NOT NULL);
