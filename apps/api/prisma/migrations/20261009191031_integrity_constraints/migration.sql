-- ════════════════════════════════════════════════════════════════════════════
-- Integrity constraints that Prisma cannot express.
--
-- These are the database's last line of defence for business-critical invariants: money,
-- the referral tree, segregation of duties and the compliance guardrails. Application code
-- must still validate first and produce friendly errors; these constraints exist so that
-- bugs, races and manual SQL cannot corrupt the data. Rationale: docs/database.md.
--
-- Conventions
--   * Every guard raises SQLSTATE 23001 (restrict_violation) or 23514 (check_violation);
--     the API maps both to HTTP 409 INVARIANT_VIOLATION.
--   * "Deferred" checks run at COMMIT so multi-statement use cases can build valid state.
--   * Rows created "in this transaction" are detected with xmin = pg_current_xact_id()::xid.
--     Code relying on that must not use SAVEPOINTs (Prisma interactive transactions don't).
-- ════════════════════════════════════════════════════════════════════════════

-- Extensions btree_gist and pg_trgm are created at the top of the init migration.

CREATE OR REPLACE FUNCTION app_forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table "%" is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION app_created_in_this_tx(p_xmin xid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT p_xmin = pg_current_xact_id()::xid $$;

-- ════ Reference data ═════════════════════════════════════════════════════════

INSERT INTO "currencies" ("code", "name", "minor_units") VALUES
  ('INR', 'Indian Rupee', 2), ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2),
  ('GBP', 'British Pound', 2), ('AED', 'UAE Dirham', 2), ('SGD', 'Singapore Dollar', 2),
  ('AUD', 'Australian Dollar', 2), ('CAD', 'Canadian Dollar', 2), ('JPY', 'Japanese Yen', 0),
  ('NPR', 'Nepalese Rupee', 2), ('LKR', 'Sri Lankan Rupee', 2), ('BDT', 'Bangladeshi Taka', 2)
ON CONFLICT ("code") DO NOTHING;

ALTER TABLE "currencies"
  ADD CONSTRAINT "ck_currencies_code" CHECK ("code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ck_currencies_minor_units" CHECK ("minor_units" BETWEEN 0 AND 4);

CREATE OR REPLACE FUNCTION app_currencies_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."minor_units" IS DISTINCT FROM OLD."minor_units" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'Currency definitions are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_currencies_guard" BEFORE UPDATE OR DELETE ON "currencies"
  FOR EACH ROW EXECUTE FUNCTION app_currencies_guard();

-- ════ Platform settings ═══════════════════════════════════════════════════════

ALTER TABLE "platform_settings"
  ADD CONSTRAINT "ck_platform_settings_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "ck_platform_settings_points_rate" CHECK ("points_per_currency_unit" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "ck_platform_settings_budget" CHECK ("default_reward_budget_bps" BETWEEN 1 AND 5000),
  ADD CONSTRAINT "ck_platform_settings_points_label" CHECK (length(btrim("points_label")) > 0),
  ADD CONSTRAINT "ck_platform_settings_version" CHECK ("version" >= 1),
  -- Compliance guardrail: payouts stay disabled until a reviewed migration drops this.
  ADD CONSTRAINT "ck_platform_settings_no_payouts" CHECK ("payouts_enabled" = false);

-- The platform currency cannot change while live programs use another currency.
CREATE OR REPLACE FUNCTION app_platform_settings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currency_code" IS DISTINCT FROM OLD."currency_code" AND EXISTS (
    SELECT 1 FROM "programs"
    WHERE "status" IN ('SCHEDULED', 'ACTIVE', 'PAUSED') AND "currency_code" <> NEW."currency_code"
  ) THEN
    RAISE EXCEPTION 'The platform currency cannot change while live programs use a different currency'
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW."version" := OLD."version" + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_platform_settings_guard" BEFORE UPDATE ON "platform_settings"
  FOR EACH ROW EXECUTE FUNCTION app_platform_settings_guard();

-- ════ Users, sessions, challenges, MFA, roles ════════════════════════════════

ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_email_normalized" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "ck_users_full_name" CHECK (length(btrim("full_name")) > 0),
  ADD CONSTRAINT "ck_users_active_verified" CHECK ("status" <> 'ACTIVE' OR "email_verified_at" IS NOT NULL);

-- Trigram search indexes on users are declared in schema.prisma (init migration).

ALTER TABLE "sessions"
  ADD CONSTRAINT "ck_sessions_expiry" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "ck_sessions_mfa" CHECK (("mfa_verified_at" IS NULL) = ("mfa_method" IS NULL));

ALTER TABLE "email_challenges"
  ADD CONSTRAINT "ck_email_challenges_attempts" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts"),
  ADD CONSTRAINT "ck_email_challenges_send_count" CHECK ("send_count" >= 1),
  ADD CONSTRAINT "ck_email_challenges_expiry" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "ck_email_challenges_mfa_session" CHECK ("purpose" <> 'LOGIN_MFA' OR ("session_id" IS NOT NULL AND "user_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_email_challenges_pending_payload" CHECK (
    ("pending_full_name" IS NULL AND "pending_password_hash" IS NULL AND "pending_referral_code_id" IS NULL)
    OR ("purpose" = 'EMAIL_VERIFICATION' AND "user_id" IS NULL AND "pending_full_name" IS NOT NULL AND "pending_password_hash" IS NOT NULL)
  );

-- At most one open code per address and purpose: a new code invalidates the old one first.
CREATE UNIQUE INDEX "uq_email_challenges_one_open"
  ON "email_challenges" ("email", "purpose")
  WHERE "consumed_at" IS NULL AND "invalidated_at" IS NULL;

CREATE UNIQUE INDEX "uq_mfa_factors_one_active"
  ON "user_mfa_factors" ("user_id", "kind")
  WHERE "revoked_at" IS NULL;

ALTER TABLE "user_roles"
  ADD CONSTRAINT "ck_user_roles_not_self_granted" CHECK ("granted_by_id" IS NULL OR "granted_by_id" <> "user_id");

-- At least one ACTIVE SUPER_ADMIN must always remain (role removal, suspension, deactivation).
-- Locking the SUPER_ADMIN roles row serializes concurrent removals (no write skew).
CREATE OR REPLACE FUNCTION app_assert_super_admin_exists() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "roles" WHERE "key" = 'SUPER_ADMIN' FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM "user_roles" ur
    JOIN "roles" r ON r."id" = ur."role_id"
    JOIN "users" u ON u."id" = ur."user_id"
    WHERE r."key" = 'SUPER_ADMIN' AND u."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'At least one ACTIVE SUPER_ADMIN must remain' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_user_roles_keep_super_admin"
  AFTER DELETE OR UPDATE ON "user_roles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_assert_super_admin_exists();
CREATE CONSTRAINT TRIGGER "trg_users_keep_super_admin"
  AFTER UPDATE OF "status" ON "users"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE')
  EXECUTE FUNCTION app_assert_super_admin_exists();

ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "ck_idempotency_keys_expiry" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "ck_idempotency_keys_completed" CHECK ("status" <> 'COMPLETED' OR "response_status" IS NOT NULL),
  ADD CONSTRAINT "ck_idempotency_keys_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

-- ════ Offerings, programs, options ═════════════════════════════════════════════

ALTER TABLE "offerings"
  ADD CONSTRAINT "ck_offerings_name" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "ck_offerings_approved" CHECK ("status" <> 'ACTIVE' OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL));

ALTER TABLE "programs"
  ADD CONSTRAINT "ck_programs_code_slug" CHECK ("code" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "ck_programs_dates" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  ADD CONSTRAINT "ck_programs_enrollment_window" CHECK ("enrollment_closes_at" IS NULL OR "enrollment_closes_at" > "enrollment_opens_at"),
  ADD CONSTRAINT "ck_programs_enrollment_within_program" CHECK (
    "ends_at" IS NULL
    OR ("enrollment_opens_at" < "ends_at" AND ("enrollment_closes_at" IS NULL OR "enrollment_closes_at" <= "ends_at"))
  ),
  ADD CONSTRAINT "ck_programs_max_depth" CHECK ("max_reward_depth" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ck_programs_grace" CHECK ("late_event_grace_days" BETWEEN 0 AND 365),
  ADD CONSTRAINT "ck_programs_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "ck_programs_published_at" CHECK ("status" = 'DRAFT' OR "published_at" IS NOT NULL),
  ADD CONSTRAINT "ck_programs_completed_has_end" CHECK ("status" NOT IN ('COMPLETED', 'ARCHIVED') OR "ends_at" IS NOT NULL);

-- Program lifecycle state machine, frozen fields after publication, optimistic version bump.
CREATE OR REPLACE FUNCTION app_programs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_offering_status "OfferingStatus";
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('SCHEDULED', 'ACTIVE'))
    OR (OLD."status" = 'SCHEDULED' AND NEW."status" = 'ACTIVE')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('PAUSED', 'COMPLETED'))
    OR (OLD."status" = 'PAUSED' AND NEW."status" IN ('ACTIVE', 'COMPLETED'))
    OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'Invalid program status transition % -> %', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT' THEN
    SELECT "status" INTO v_offering_status FROM "offerings" WHERE "id" = NEW."offering_id" FOR SHARE;
    IF v_offering_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'A program can only be published for an approved (ACTIVE) offering'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF OLD."status" <> 'DRAFT' AND (
       NEW."reward_unit" IS DISTINCT FROM OLD."reward_unit"
    OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
    OR NEW."currency_minor_units" IS DISTINCT FROM OLD."currency_minor_units"
    OR NEW."offering_id" IS DISTINCT FROM OLD."offering_id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."max_reward_depth" IS DISTINCT FROM OLD."max_reward_depth"
  ) THEN
    RAISE EXCEPTION 'Program % is published; code, offering, reward unit, currency and depth are immutable', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED') AND NEW."starts_at" IS DISTINCT FROM OLD."starts_at" THEN
    RAISE EXCEPTION 'The start of a started program cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
     AND NEW."ends_at" IS NOT NULL AND NEW."ends_at" < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'A published program''s end cannot be moved into the past' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'ARCHIVED') AND (
       NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
    OR NEW."enrollment_closes_at" IS DISTINCT FROM OLD."enrollment_closes_at"
    OR NEW."late_event_grace_days" IS DISTINCT FROM OLD."late_event_grace_days"
  ) THEN
    RAISE EXCEPTION 'Dates of a completed program are frozen' USING ERRCODE = 'restrict_violation';
  END IF;

  NEW."version" := OLD."version" + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_programs_guard" BEFORE UPDATE ON "programs"
  FOR EACH ROW EXECUTE FUNCTION app_programs_guard();

CREATE OR REPLACE FUNCTION app_programs_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Programs are created as DRAFT' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_programs_insert_guard" BEFORE INSERT ON "programs"
  FOR EACH ROW EXECUTE FUNCTION app_programs_insert_guard();

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

-- Status history: the app passes the acting user via updated_by_id and an optional reason via
-- SELECT set_config('app.status_reason', $reason, true).
CREATE OR REPLACE FUNCTION app_programs_log_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    INSERT INTO "program_status_changes" ("id", "program_id", "from_status", "to_status", "changed_at", "changed_by_id", "reason")
    VALUES (
      gen_random_uuid(), NEW."id",
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END,
      NEW."status", now(), NEW."updated_by_id",
      nullif(left(coalesce(current_setting('app.status_reason', true), ''), 1000), '')
    );
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "trg_programs_log_status" AFTER INSERT OR UPDATE OF "status" ON "programs"
  FOR EACH ROW EXECUTE FUNCTION app_programs_log_status();

CREATE TRIGGER "trg_program_status_changes_append_only" BEFORE UPDATE OR DELETE ON "program_status_changes"
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION app_forbid_modification();

ALTER TABLE "program_options"
  ADD CONSTRAINT "ck_program_options_price" CHECK ("price_minor" >= 0),
  ADD CONSTRAINT "ck_program_options_duration" CHECK ("duration_days" BETWEEN 1 AND 3660),
  ADD CONSTRAINT "ck_program_options_name" CHECK (length(btrim("name")) > 0);

-- Option prices are in the program currency; price/duration/frequency of an option already
-- used by an enrollment never change (create a new option instead).
CREATE OR REPLACE FUNCTION app_program_options_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_currency char(3);
BEGIN
  SELECT "currency_code" INTO v_currency FROM "programs" WHERE "id" = NEW."program_id";
  IF NEW."currency_code" IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION 'Option currency must equal the program currency (%)', v_currency USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW."price_minor" IS DISTINCT FROM OLD."price_minor"
    OR NEW."duration_days" IS DISTINCT FROM OLD."duration_days"
    OR NEW."billing_frequency" IS DISTINCT FROM OLD."billing_frequency"
    OR NEW."program_id" IS DISTINCT FROM OLD."program_id"
  ) AND EXISTS (SELECT 1 FROM "program_enrollments" WHERE "option_id" = OLD."id") THEN
    RAISE EXCEPTION 'Option % is in use; create a new option instead of changing its terms', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_program_options_guard" BEFORE INSERT OR UPDATE ON "program_options"
  FOR EACH ROW EXECUTE FUNCTION app_program_options_guard();

-- ════ Enrollments ══════════════════════════════════════════════════════════════

-- One PENDING enrollment per member per program; activated coverage periods never overlap
-- (allows a renewal that starts when the current period ends).
CREATE UNIQUE INDEX "uq_enrollments_one_pending"
  ON "program_enrollments" ("user_id", "program_id")
  WHERE "status" = 'PENDING';

ALTER TABLE "program_enrollments"
  ADD CONSTRAINT "ex_enrollments_no_overlap" EXCLUDE USING gist (
    "user_id" WITH =,
    "program_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" IN ('ACTIVE', 'EXPIRED', 'CANCELLED') AND "effective_from" IS NOT NULL);

CREATE INDEX "ix_enrollments_eligibility"
  ON "program_enrollments" ("program_id", "user_id", "effective_from")
  WHERE "eligibility_status" = 'ELIGIBLE';
CREATE INDEX "ix_enrollments_active_expiry"
  ON "program_enrollments" ("effective_to")
  WHERE "status" = 'ACTIVE';

ALTER TABLE "program_enrollments"
  ADD CONSTRAINT "ck_enrollments_effective_range" CHECK (
    "effective_to" IS NULL OR "effective_from" IS NULL OR "effective_to" > "effective_from"
    OR ("status" = 'CANCELLED' AND "effective_to" = "effective_from")
  ),
  ADD CONSTRAINT "ck_enrollments_not_self_sponsored" CHECK ("sponsor_user_id" IS NULL OR "sponsor_user_id" <> "user_id"),
  ADD CONSTRAINT "ck_enrollments_active_has_period" CHECK ("status" NOT IN ('ACTIVE', 'EXPIRED') OR ("effective_from" IS NOT NULL AND "effective_to" IS NOT NULL)),
  ADD CONSTRAINT "ck_enrollments_cancelled_at" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL),
  ADD CONSTRAINT "ck_enrollments_eligible_needs_period" CHECK ("eligibility_status" <> 'ELIGIBLE' OR "effective_from" IS NOT NULL),
  ADD CONSTRAINT "ck_enrollments_payment_amount" CHECK ("payment_amount_minor" IS NULL OR "payment_amount_minor" >= 0),
  ADD CONSTRAINT "ck_enrollments_payment_complete" CHECK (
    ("payment_reference" IS NULL) = ("payment_amount_minor" IS NULL)
    AND ("payment_reference" IS NULL) = ("payment_recorded_at" IS NULL)
  ),
  -- A paid option can only become ACTIVE with a recorded offline payment.
  ADD CONSTRAINT "ck_enrollments_paid_activation" CHECK (
    "status" NOT IN ('ACTIVE', 'EXPIRED')
    OR coalesce(("option_snapshot" ->> 'priceMinor')::numeric, 0) = 0
    OR "payment_reference" IS NOT NULL
  );

-- New enrollments: program ACTIVE with an open window (row-locked against pause/complete),
-- option belongs to the program and is active, member ACTIVE and verified.
CREATE OR REPLACE FUNCTION app_enrollments_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
  v_ok boolean;
BEGIN
  IF NEW."status" NOT IN ('PENDING', 'ACTIVE') THEN
    RAISE EXCEPTION 'Enrollments are created PENDING or ACTIVE' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "status", "enrollment_opens_at", "enrollment_closes_at" INTO p
  FROM "programs" WHERE "id" = NEW."program_id" FOR SHARE;
  IF p."status" IS DISTINCT FROM 'ACTIVE' OR now() < p."enrollment_opens_at"
     OR (p."enrollment_closes_at" IS NOT NULL AND now() >= p."enrollment_closes_at") THEN
    RAISE EXCEPTION 'Program % is not open for enrollment', NEW."program_id" USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT EXISTS (SELECT 1 FROM "program_options" WHERE "id" = NEW."option_id" AND "program_id" = NEW."program_id" AND "is_active")
    INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Option % is not an active option of program %', NEW."option_id", NEW."program_id" USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "status" = 'ACTIVE' AND "email_verified_at" IS NOT NULL)
    INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Only active, verified members can enroll' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."effective_from" IS NOT NULL AND NEW."effective_from" < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Coverage cannot start in the past' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_enrollments_insert_guard" BEFORE INSERT ON "program_enrollments"
  FOR EACH ROW EXECUTE FUNCTION app_enrollments_insert_guard();

-- Terms, attribution and payment records are historical facts; coverage dates are frozen once
-- set (cancellation may only shorten the period, never into the past).
CREATE OR REPLACE FUNCTION app_enrollments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Enrollments cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."option_snapshot" IS DISTINCT FROM OLD."option_snapshot"
     OR NEW."option_id" IS DISTINCT FROM OLD."option_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."program_id" IS DISTINCT FROM OLD."program_id"
     OR NEW."terms_version" IS DISTINCT FROM OLD."terms_version"
     OR NEW."sponsor_user_id" IS DISTINCT FROM OLD."sponsor_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'Enrollment % terms and attribution are immutable', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."payment_reference" IS NOT NULL AND (
       NEW."payment_reference" IS DISTINCT FROM OLD."payment_reference"
    OR NEW."payment_amount_minor" IS DISTINCT FROM OLD."payment_amount_minor"
    OR NEW."payment_recorded_at" IS DISTINCT FROM OLD."payment_recorded_at"
    OR NEW."payment_recorded_by_id" IS DISTINCT FROM OLD."payment_recorded_by_id"
  ) THEN
    RAISE EXCEPTION 'Enrollment % payment record is immutable', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'EXPIRED', 'REJECTED') AND (
       NEW."status" <> OLD."status"
    OR NEW."eligibility_status" IS DISTINCT FROM OLD."eligibility_status"
    OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
    OR NEW."effective_to" IS DISTINCT FROM OLD."effective_to"
    OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
  ) THEN
    RAISE EXCEPTION 'Enrollment % is in terminal status %', OLD."id", OLD."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('ACTIVE', 'REJECTED', 'CANCELLED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('EXPIRED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'Invalid enrollment status transition % -> %', OLD."status", NEW."status" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'EXPIRED' AND OLD."status" <> 'EXPIRED' AND NEW."effective_to" > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Enrollment % has not reached the end of its period', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."effective_from" IS NOT NULL AND NEW."effective_from" IS DISTINCT FROM OLD."effective_from" THEN
    RAISE EXCEPTION 'Enrollment coverage start is frozen' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."effective_from" IS NULL AND NEW."effective_from" IS NOT NULL AND NEW."effective_from" < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Coverage cannot start in the past' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."effective_to" IS NOT NULL AND NEW."effective_to" IS DISTINCT FROM OLD."effective_to" THEN
    IF NOT (
      NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED'
      AND NEW."effective_to" IS NOT NULL
      AND NEW."effective_to" < OLD."effective_to"
      AND NEW."effective_to" >= least(OLD."effective_to", greatest(NEW."effective_from", now() - interval '1 minute'))
    ) THEN
      RAISE EXCEPTION 'Enrollment coverage end may only be shortened by a cancellation, never into the past'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_enrollments_guard" BEFORE UPDATE OR DELETE ON "program_enrollments"
  FOR EACH ROW EXECUTE FUNCTION app_enrollments_guard();

-- ════ Referral tree ════════════════════════════════════════════════════════════
--
-- Write protocol (enforced below):
--   * Registration: in the transaction that INSERTs the users row, take
--     pg_advisory_xact_lock_shared(7301, 1), then insert the self path, the relationship (if any)
--     and the ancestor paths. Only rows for a user created in the same transaction are accepted.
--   * Correction: take pg_advisory_xact_lock(7301, 1) (exclusive) FIRST, insert the
--     referral_corrections row, SET LOCAL app.referral_correction_id = '<that id>', then rewrite.
--   * At COMMIT every touched descendant's closure rows must equal its sponsor's rows shifted by
--     one, plus the depth-0 self row.

CREATE UNIQUE INDEX "uq_referral_codes_global_per_user"
  ON "referral_codes" ("user_id")
  WHERE "program_id" IS NULL AND "is_active";

ALTER TABLE "referral_codes"
  ADD CONSTRAINT "ck_referral_codes_format" CHECK ("code" ~ '^[A-Z0-9]{6,16}$');

ALTER TABLE "referral_relationships"
  ADD CONSTRAINT "ck_referral_relationships_not_self" CHECK ("child_user_id" <> "sponsor_user_id"),
  ADD CONSTRAINT "ck_referral_relationships_code_source" CHECK ("source" = 'ADMIN_CORRECTION' OR "referral_code_id" IS NOT NULL);

ALTER TABLE "referral_paths"
  ADD CONSTRAINT "ck_referral_paths_depth" CHECK ("depth" >= 0 AND "depth" <= 1000),
  ADD CONSTRAINT "ck_referral_paths_self_row" CHECK (("depth" = 0) = ("ancestor_id" = "descendant_id"));

CREATE OR REPLACE FUNCTION app_referral_lock_mode() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN bool_or("mode" = 'ExclusiveLock') THEN 'exclusive'
    WHEN bool_or("mode" = 'ShareLock') THEN 'shared'
    ELSE NULL END
  FROM pg_locks
  WHERE "locktype" = 'advisory' AND "pid" = pg_backend_pid()
    AND "classid" = 7301 AND "objid" = 1 AND "objsubid" = 2 AND "granted"
$$;

-- True only inside the transaction that inserted the referral_corrections row named by
-- app.referral_correction_id (a leaked setting on a pooled connection is harmless).
CREATE OR REPLACE FUNCTION app_in_referral_correction() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_id text := nullif(current_setting('app.referral_correction_id', true), '');
BEGIN
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM "referral_corrections" c
    WHERE c."id" = v_id::uuid AND app_created_in_this_tx(c."xmin")
  ) AND app_referral_lock_mode() = 'exclusive';
END;
$$;

CREATE OR REPLACE FUNCTION app_user_created_in_this_tx(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT app_created_in_this_tx("xmin") FROM "users" WHERE "id" = p_user_id), false)
$$;

CREATE OR REPLACE FUNCTION app_referral_relationships_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF app_in_referral_correction() THEN
    IF EXISTS (SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = NEW."child_user_id" AND "descendant_id" = NEW."sponsor_user_id") THEN
      RAISE EXCEPTION 'Referral cycle: % is inside the subtree of %', NEW."sponsor_user_id", NEW."child_user_id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF app_referral_lock_mode() IS NULL OR NOT app_user_created_in_this_tx(NEW."child_user_id")
     OR NOT EXISTS (
       SELECT 1 FROM "referral_paths" sp
       WHERE sp."ancestor_id" = NEW."child_user_id" AND sp."descendant_id" = NEW."child_user_id"
         AND app_created_in_this_tx(sp."xmin")
     )
     OR EXISTS (SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = NEW."child_user_id" AND "depth" > 0)
  THEN
    RAISE EXCEPTION 'Referral attribution is only written by the registration that creates the member (self row first)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."source" <> 'REGISTRATION' THEN
    RAISE EXCEPTION 'Registration attribution must have source REGISTRATION' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "referral_codes" rc
    JOIN "users" s ON s."id" = rc."user_id"
    WHERE rc."id" = NEW."referral_code_id" AND rc."user_id" = NEW."sponsor_user_id" AND rc."is_active"
      AND s."status" = 'ACTIVE' AND s."email_verified_at" IS NOT NULL
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Attribution requires an active referral code owned by an active, verified sponsor'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_referral_relationships_insert_guard" BEFORE INSERT ON "referral_relationships"
  FOR EACH ROW EXECUTE FUNCTION app_referral_relationships_insert_guard();

CREATE OR REPLACE FUNCTION app_referral_paths_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_in_referral_correction() THEN
    RETURN NEW;
  END IF;
  IF app_referral_lock_mode() IS NULL OR NOT app_user_created_in_this_tx(NEW."descendant_id") THEN
    RAISE EXCEPTION 'Closure rows are only written by the registration that creates the member'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Ancestor rows require the member's self row to have been created in this same transaction.
  IF NEW."depth" > 0 AND NOT EXISTS (
    SELECT 1 FROM "referral_paths" sp
    WHERE sp."ancestor_id" = NEW."descendant_id" AND sp."descendant_id" = NEW."descendant_id"
      AND app_created_in_this_tx(sp."xmin")
  ) THEN
    RAISE EXCEPTION 'Closure rows are only written by the registration that creates the member (self row first)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_referral_paths_insert_guard" BEFORE INSERT ON "referral_paths"
  FOR EACH ROW EXECUTE FUNCTION app_referral_paths_insert_guard();

CREATE OR REPLACE FUNCTION app_referral_modify_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_in_referral_correction() THEN
    RAISE EXCEPTION 'Referral attribution on "%" is immutable outside the audited correction workflow', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'referral_relationships' AND TG_OP = 'UPDATE'
     AND EXISTS (SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = NEW."child_user_id" AND "descendant_id" = NEW."sponsor_user_id") THEN
    RAISE EXCEPTION 'Referral cycle: % is inside the subtree of %', NEW."sponsor_user_id", NEW."child_user_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_referral_relationships_guard" BEFORE UPDATE OR DELETE ON "referral_relationships"
  FOR EACH ROW EXECUTE FUNCTION app_referral_modify_guard();
CREATE TRIGGER "trg_referral_paths_guard" BEFORE UPDATE OR DELETE ON "referral_paths"
  FOR EACH ROW EXECUTE FUNCTION app_referral_modify_guard();

-- Commit-time consistency: closure rows of d = sponsor's closure rows shifted by one (+ self).
CREATE OR REPLACE FUNCTION app_referral_assert_consistent(p_descendant uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_sponsor uuid;
  v_bad int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = p_descendant) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = p_descendant AND "descendant_id" = p_descendant AND "depth" = 0) THEN
    RAISE EXCEPTION 'Member % is missing its depth-0 closure row', p_descendant USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "sponsor_user_id" INTO v_sponsor FROM "referral_relationships" WHERE "child_user_id" = p_descendant;
  SELECT count(*) INTO v_bad FROM (
    (SELECT "ancestor_id", "depth" FROM "referral_paths" WHERE "descendant_id" = p_descendant AND "depth" > 0
     EXCEPT
     SELECT "ancestor_id", "depth" + 1 FROM "referral_paths" WHERE "descendant_id" = v_sponsor)
    UNION ALL
    (SELECT "ancestor_id", "depth" + 1 FROM "referral_paths" WHERE "descendant_id" = v_sponsor
     EXCEPT
     SELECT "ancestor_id", "depth" FROM "referral_paths" WHERE "descendant_id" = p_descendant AND "depth" > 0)
  ) mismatches;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Referral closure rows of % do not match its sponsor chain', p_descendant
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_referral_paths_consistency_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app_referral_assert_consistent(OLD."descendant_id");
  ELSE
    PERFORM app_referral_assert_consistent(NEW."descendant_id");
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_referral_paths_consistent"
  AFTER INSERT OR DELETE ON "referral_paths"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_referral_paths_consistency_trigger();

CREATE OR REPLACE FUNCTION app_referral_relationships_consistency_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_referral_assert_consistent(NEW."child_user_id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_referral_relationships_consistent"
  AFTER INSERT OR UPDATE ON "referral_relationships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_referral_relationships_consistency_trigger();

-- Corrections: append-only, with segregation of duties.
ALTER TABLE "referral_corrections"
  ADD CONSTRAINT "ck_referral_corrections_not_self" CHECK ("child_user_id" <> "new_sponsor_id"),
  ADD CONSTRAINT "ck_referral_corrections_reason" CHECK (length(btrim("reason")) >= 10),
  ADD CONSTRAINT "ck_referral_corrections_sod" CHECK (
    "performed_by_id" <> "new_sponsor_id"
    AND "performed_by_id" <> "child_user_id"
    AND "performed_by_id" IS DISTINCT FROM "previous_sponsor_id"
  );

CREATE OR REPLACE FUNCTION app_referral_corrections_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_referral_lock_mode() IS DISTINCT FROM 'exclusive' THEN
    RAISE EXCEPTION 'Take the referral tree lock (pg_advisory_xact_lock(7301, 1)) before a correction'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = NEW."performed_by_id" AND "descendant_id" = NEW."new_sponsor_id") THEN
    RAISE EXCEPTION 'An administrator cannot move members under their own downline' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = NEW."child_user_id" AND "descendant_id" = NEW."new_sponsor_id") THEN
    RAISE EXCEPTION 'Referral cycle: the new sponsor is inside the member''s subtree' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_referral_corrections_insert_guard" BEFORE INSERT ON "referral_corrections"
  FOR EACH ROW EXECUTE FUNCTION app_referral_corrections_insert_guard();
CREATE TRIGGER "trg_referral_corrections_append_only" BEFORE UPDATE OR DELETE ON "referral_corrections"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

-- ════ Reward policy versions & rules ═══════════════════════════════════════════

ALTER TABLE "reward_policy_versions"
  ADD CONSTRAINT "ck_policy_versions_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "ck_policy_versions_max_depth" CHECK ("max_depth" BETWEEN 1 AND 10),
  -- HARD CAP: total rewards can never exceed 50% of the qualifying sale amount.
  ADD CONSTRAINT "ck_policy_versions_budget" CHECK ("budget_bps" BETWEEN 1 AND 5000),
  ADD CONSTRAINT "ck_policy_versions_max_total" CHECK ("max_total_per_event_minor" IS NULL OR "max_total_per_event_minor" > 0),
  ADD CONSTRAINT "ck_policy_versions_min_amount" CHECK ("min_event_amount_minor" >= 0),
  ADD CONSTRAINT "ck_policy_versions_points_rate" CHECK ("points_per_currency_unit" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "ck_policy_versions_effective_range" CHECK (
    "effective_to" IS NULL OR "effective_to" > "effective_from"
    OR ("status" = 'RETIRED' AND "effective_to" = "effective_from")
  ),
  ADD CONSTRAINT "ck_policy_versions_triggers" CHECK (cardinality("trigger_event_types") >= 1),
  ADD CONSTRAINT "ck_policy_versions_published_at" CHECK ("status" = 'DRAFT' OR ("published_at" IS NOT NULL AND "published_by_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_policy_versions_retired" CHECK ("status" <> 'RETIRED' OR ("retired_at" IS NOT NULL AND "effective_to" IS NOT NULL));

-- Effective ranges of non-draft versions never overlap within a program (checked at commit so
-- "close the current version, then publish the new one" can run in any order).
ALTER TABLE "reward_policy_versions"
  ADD CONSTRAINT "ex_policy_versions_no_overlap" EXCLUDE USING gist (
    "program_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE ("status" IN ('PUBLISHED', 'RETIRED'))
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION app_policy_versions_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Policy versions are created as DRAFT and published afterwards' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_policy_versions_insert_guard" BEFORE INSERT ON "reward_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION app_policy_versions_insert_guard();

CREATE OR REPLACE FUNCTION app_policy_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_program record;
  v_rule_count int;
  v_max_level int;
  v_pct_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Published policy version % cannot be deleted', OLD."id" USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."program_id" IS DISTINCT FROM OLD."program_id" OR NEW."version" IS DISTINCT FROM OLD."version" THEN
    RAISE EXCEPTION 'Policy version identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── DRAFT ──────────────────────────────────────────────────────────────
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'RETIRED' THEN
      RAISE EXCEPTION 'A DRAFT policy version cannot be retired; delete it instead' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'PUBLISHED' THEN
      SELECT "status", "max_reward_depth" INTO v_program FROM "programs" WHERE "id" = NEW."program_id" FOR SHARE;
      IF v_program."status" IN ('COMPLETED', 'ARCHIVED') THEN
        RAISE EXCEPTION 'Policies cannot be published for a % program', v_program."status" USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW."effective_from" < now() - interval '1 minute' THEN
        RAISE EXCEPTION 'Policies cannot take effect in the past' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW."max_depth" > v_program."max_reward_depth" THEN
        RAISE EXCEPTION 'Policy depth % exceeds the program maximum %', NEW."max_depth", v_program."max_reward_depth"
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT count(*), max("level"), coalesce(sum("percentage_bps"), 0)
        INTO v_rule_count, v_max_level, v_pct_total
        FROM "reward_rules" WHERE "policy_version_id" = NEW."id";
      IF v_rule_count = 0 THEN
        RAISE EXCEPTION 'A policy needs at least one reward level' USING ERRCODE = 'check_violation';
      END IF;
      IF v_max_level > NEW."max_depth" THEN
        RAISE EXCEPTION 'A reward level exceeds the policy depth' USING ERRCODE = 'check_violation';
      END IF;
      IF v_pct_total > NEW."budget_bps" THEN
        RAISE EXCEPTION 'Percentage levels (% bps) exceed the budget (% bps)', v_pct_total, NEW."budget_bps"
          USING ERRCODE = 'check_violation';
      END IF;
      -- Segregation of duties: auto-approving policies need a SUPER_ADMIN publisher.
      IF NOT NEW."requires_approval" AND NOT EXISTS (
        SELECT 1 FROM "user_roles" ur JOIN "roles" r ON r."id" = ur."role_id"
        WHERE ur."user_id" = NEW."published_by_id" AND r."key" = 'SUPER_ADMIN'
      ) THEN
        RAISE EXCEPTION 'Only a SUPER_ADMIN can publish a policy that skips reward approval'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- ── PUBLISHED / RETIRED ────────────────────────────────────────────────
  IF NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Policy version % cannot return to DRAFT', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'RETIRED' AND (
       NEW."status" <> 'RETIRED'
    OR NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
    OR NEW."effective_to" IS DISTINCT FROM OLD."effective_to"
  ) THEN
    RAISE EXCEPTION 'Policy version % is retired and frozen', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."trigger_event_types" IS DISTINCT FROM OLD."trigger_event_types"
     OR NEW."max_depth" IS DISTINCT FROM OLD."max_depth"
     OR NEW."budget_bps" IS DISTINCT FROM OLD."budget_bps"
     OR NEW."max_total_per_event_minor" IS DISTINCT FROM OLD."max_total_per_event_minor"
     OR NEW."min_event_amount_minor" IS DISTINCT FROM OLD."min_event_amount_minor"
     OR NEW."points_per_currency_unit" IS DISTINCT FROM OLD."points_per_currency_unit"
     OR NEW."ineligible_ancestor_behavior" IS DISTINCT FROM OLD."ineligible_ancestor_behavior"
     OR NEW."rounding_mode" IS DISTINCT FROM OLD."rounding_mode"
     OR NEW."requires_approval" IS DISTINCT FROM OLD."requires_approval"
     OR NEW."require_active_enrollment" IS DISTINCT FROM OLD."require_active_enrollment"
     OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
     OR NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
     OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'Published policy version % is immutable; create a new version instead', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."effective_to" IS DISTINCT FROM OLD."effective_to" THEN
    IF NEW."effective_to" IS NULL OR (OLD."effective_to" IS NOT NULL AND NEW."effective_to" > OLD."effective_to") THEN
      RAISE EXCEPTION 'A published policy range may only be closed or shortened' USING ERRCODE = 'restrict_violation';
    END IF;
    -- Either close at a time that is not in the past, or withdraw a not-yet-effective version
    -- (empty range [from, from)) while retiring it.
    IF NOT (
      NEW."effective_to" >= now() - interval '1 minute'
      OR (NEW."status" = 'RETIRED' AND NEW."effective_to" = OLD."effective_from" AND OLD."effective_from" > now())
    ) THEN
      RAISE EXCEPTION 'A policy range cannot be closed in the past' USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "qualifying_events"
      WHERE "policy_version_id" = OLD."id" AND "occurred_at" >= NEW."effective_to"
    ) THEN
      RAISE EXCEPTION 'Events already bound to policy version % fall after the new end', OLD."id"
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

-- Rules change only while their version is a DRAFT. FOR SHARE conflicts with the publishing
-- UPDATE, so a rule cannot slip in concurrently with publication.
CREATE OR REPLACE FUNCTION app_reward_rules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status "PolicyStatus";
  v_policy_id uuid;
BEGIN
  v_policy_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."policy_version_id" ELSE NEW."policy_version_id" END;
  SELECT "status" INTO v_status FROM "reward_policy_versions" WHERE "id" = v_policy_id FOR SHARE;
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

-- ════ API clients ══════════════════════════════════════════════════════════════

ALTER TABLE "api_clients"
  ADD CONSTRAINT "ck_api_clients_name" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "ck_api_clients_key_hash" CHECK ("key_hash" ~ '^[0-9a-f]{64}$');

-- ════ Qualifying events ════════════════════════════════════════════════════════

CREATE INDEX "ix_events_received" ON "qualifying_events" ("created_at") WHERE "status" = 'RECEIVED';

ALTER TABLE "qualifying_events"
  ADD CONSTRAINT "ck_events_amount" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ck_events_external_id" CHECK (length(btrim("external_id")) > 0),
  ADD CONSTRAINT "ck_events_customer_reference" CHECK (length(btrim("customer_reference")) > 0),
  ADD CONSTRAINT "ck_events_request_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ck_events_revision" CHECK ("revision" >= 0 AND ("revision" = 0) = ("supersedes_event_id" IS NULL)),
  ADD CONSTRAINT "ck_events_actor" CHECK (
    ("source" = 'ADMIN_MANUAL') = ("recorded_by_id" IS NOT NULL)
    AND ("source" <> 'ADMIN_MANUAL') = ("api_client_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "ck_events_processed" CHECK ("status" NOT IN ('PROCESSED', 'REVERSED') OR ("processed_at" IS NOT NULL AND "policy_version_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_events_rejected" CHECK ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL),
  ADD CONSTRAINT "ck_events_reversed" CHECK ("status" <> 'REVERSED' OR ("reversed_at" IS NOT NULL AND "reversal_reason" IS NOT NULL));

-- Checks that a policy version may price this event.
CREATE OR REPLACE FUNCTION app_assert_policy_applies(
  p_policy_id uuid, p_program_id uuid, p_type "QualifyingEventType", p_amount bigint, p_occurred_at timestamptz
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT * INTO v FROM "reward_policy_versions" WHERE "id" = p_policy_id FOR SHARE;
  IF NOT FOUND OR v."program_id" <> p_program_id THEN
    RAISE EXCEPTION 'Policy version % does not belong to program %', p_policy_id, p_program_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF v."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'A DRAFT policy version cannot price events' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (p_occurred_at <@ tstzrange(v."effective_from", v."effective_to", '[)')) THEN
    RAISE EXCEPTION 'The sale occurred outside the policy''s effective range' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (p_type = ANY (v."trigger_event_types")) THEN
    RAISE EXCEPTION 'The policy does not reward % events', p_type USING ERRCODE = 'restrict_violation';
  END IF;
  IF p_amount < v."min_event_amount_minor" THEN
    RAISE EXCEPTION 'The sale is below the policy minimum' USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_events_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
  prev record;
  v_client_program uuid;
  v_client_revoked timestamptz;
BEGIN
  SELECT "offering_id", "currency_code", "starts_at", "ends_at" INTO p
  FROM "programs" WHERE "id" = NEW."program_id" FOR SHARE;
  IF NEW."offering_id" IS DISTINCT FROM p."offering_id" THEN
    RAISE EXCEPTION 'Event offering must be the program''s offering' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."currency_code" IS DISTINCT FROM p."currency_code" THEN
    RAISE EXCEPTION 'Event currency must be the program currency (%)', p."currency_code" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" NOT IN ('RECEIVED', 'REJECTED') THEN
    RAISE EXCEPTION 'Events are created RECEIVED (or REJECTED with a reason)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."policy_version_id" IS NOT NULL THEN
    RAISE EXCEPTION 'The policy is bound when the event is processed' USING ERRCODE = 'restrict_violation';
  END IF;

  -- Recorder / client identity and segregation of duties.
  IF NEW."api_client_id" IS NOT NULL THEN
    SELECT "program_id", "revoked_at" INTO v_client_program, v_client_revoked FROM "api_clients" WHERE "id" = NEW."api_client_id";
    IF v_client_program IS DISTINCT FROM NEW."program_id" OR v_client_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'API client is revoked or not authorized for this program' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."recorded_by_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "referral_paths" WHERE "ancestor_id" = NEW."recorded_by_id" AND "descendant_id" = NEW."subject_user_id"
  ) THEN
    RAISE EXCEPTION 'An administrator cannot record sales for themselves or their own downline'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Re-records supersede a REVERSED/REJECTED revision of the same sale.
  IF NEW."supersedes_event_id" IS NOT NULL THEN
    SELECT "offering_id", "external_id", "revision", "status" INTO prev
    FROM "qualifying_events" WHERE "id" = NEW."supersedes_event_id" FOR SHARE;
    IF prev."offering_id" IS DISTINCT FROM NEW."offering_id" OR prev."external_id" IS DISTINCT FROM NEW."external_id"
       OR prev."revision" IS DISTINCT FROM NEW."revision" - 1 OR prev."status" NOT IN ('REVERSED', 'REJECTED') THEN
      RAISE EXCEPTION 'A re-record must supersede the previous REVERSED/REJECTED revision of the same sale'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW."status" = 'REJECTED' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "offerings" WHERE "id" = NEW."offering_id" AND "status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'Sales can only be recorded for an approved (ACTIVE) offering' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."occurred_at" < p."starts_at" OR (p."ends_at" IS NOT NULL AND NEW."occurred_at" >= p."ends_at")
     OR NEW."occurred_at" > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The sale date is outside the program period' USING ERRCODE = 'restrict_violation';
  END IF;

  -- Compliance: a member's own plan payment is never a qualifying sale.
  IF EXISTS (
    SELECT 1 FROM "program_enrollments"
    WHERE "program_id" = NEW."program_id" AND "payment_reference" = NEW."external_id"
  ) THEN
    RAISE EXCEPTION 'This id is a member plan payment, not a sale' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "program_enrollments"
    WHERE "program_id" = NEW."program_id" AND "user_id" = NEW."subject_user_id"
      AND "payment_amount_minor" = NEW."amount_minor"
      AND NEW."occurred_at" BETWEEN "payment_recorded_at" - interval '2 days' AND "payment_recorded_at" + interval '2 days'
  ) THEN
    RAISE EXCEPTION 'This looks like the member''s own plan payment; plan payments never earn rewards'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_events_insert_guard" BEFORE INSERT ON "qualifying_events"
  FOR EACH ROW EXECUTE FUNCTION app_events_insert_guard();

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
     OR NEW."revision" IS DISTINCT FROM OLD."revision"
     OR NEW."supersedes_event_id" IS DISTINCT FROM OLD."supersedes_event_id"
     OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."customer_reference" IS DISTINCT FROM OLD."customer_reference"
     OR NEW."subject_user_id" IS DISTINCT FROM OLD."subject_user_id"
     OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
     OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
     OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
     OR NEW."recorded_by_id" IS DISTINCT FROM OLD."recorded_by_id"
     OR NEW."api_client_id" IS DISTINCT FROM OLD."api_client_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
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
  IF OLD."policy_version_id" IS NULL AND NEW."policy_version_id" IS NOT NULL THEN
    IF OLD."status" <> 'RECEIVED' THEN
      RAISE EXCEPTION 'A policy can only be bound while the event is RECEIVED' USING ERRCODE = 'restrict_violation';
    END IF;
    PERFORM app_assert_policy_applies(NEW."policy_version_id", NEW."program_id", NEW."type", NEW."amount_minor", NEW."occurred_at");
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_events_guard" BEFORE UPDATE OR DELETE ON "qualifying_events"
  FOR EACH ROW EXECUTE FUNCTION app_events_guard();

-- A reversed event leaves no live rewards behind (checked at commit).
CREATE OR REPLACE FUNCTION app_events_reversal_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "rewards" WHERE "event_id" = NEW."id" AND "status" IN ('PENDING_APPROVAL', 'APPROVED', 'POSTED')
  ) THEN
    RAISE EXCEPTION 'Event % was reversed but still has live rewards', NEW."id" USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_events_reversal_complete"
  AFTER UPDATE ON "qualifying_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'REVERSED' AND OLD."status" <> 'REVERSED')
  EXECUTE FUNCTION app_events_reversal_complete();

-- ════ Reward calculations (append-only, budget-capped) ═════════════════════════

ALTER TABLE "reward_calculations"
  ADD CONSTRAINT "ck_calculations_amounts" CHECK (
    "base_minor" >= 0 AND "budget_minor" >= 0 AND "total_allocated_minor" >= 0
    AND "total_allocated_minor" <= "budget_minor"
  ),
  ADD CONSTRAINT "ck_calculations_budget_bps" CHECK ("budget_bps" BETWEEN 1 AND 5000),
  -- COMPLIANCE HARD CAP, independent of application code.
  ADD CONSTRAINT "ck_calculations_budget_cap" CHECK (
    "budget_minor"::numeric <= floor("base_minor"::numeric * "budget_bps" / 10000)
  ),
  ADD CONSTRAINT "ck_calculations_points_rate" CHECK ("points_per_currency_unit" BETWEEN 1 AND 1000000),
  ADD CONSTRAINT "ck_calculations_minor_units" CHECK ("currency_minor_units" BETWEEN 0 AND 4);

-- Every input of the calculation must match the event, its program and its policy.
CREATE OR REPLACE FUNCTION app_calculations_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e record;
  p record;
  v record;
  v_expected_base numeric;
BEGIN
  SELECT * INTO e FROM "qualifying_events" WHERE "id" = NEW."event_id" FOR SHARE;
  IF e."status" <> 'RECEIVED' THEN
    RAISE EXCEPTION 'Only a RECEIVED event can be calculated' USING ERRCODE = 'restrict_violation';
  END IF;
  IF e."policy_version_id" IS DISTINCT FROM NEW."policy_version_id" THEN
    RAISE EXCEPTION 'Calculation policy must be the policy bound to the event' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "reward_unit", "currency_code", "currency_minor_units" INTO p FROM "programs" WHERE "id" = e."program_id";
  SELECT "budget_bps", "points_per_currency_unit", "max_total_per_event_minor" INTO v
  FROM "reward_policy_versions" WHERE "id" = NEW."policy_version_id";
  IF NEW."reward_unit" <> p."reward_unit" OR NEW."currency_code" <> p."currency_code"
     OR NEW."currency_minor_units" <> p."currency_minor_units" THEN
    RAISE EXCEPTION 'Calculation unit/currency must match the program' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."budget_bps" <> v."budget_bps" OR NEW."points_per_currency_unit" <> v."points_per_currency_unit" THEN
    RAISE EXCEPTION 'Calculation budget/points rate must match the policy' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."reward_unit" = 'MONEY' THEN
    v_expected_base := e."amount_minor";
  ELSE
    v_expected_base := floor(e."amount_minor"::numeric * NEW."points_per_currency_unit" / (10::numeric ^ NEW."currency_minor_units"));
  END IF;
  IF NEW."base_minor"::numeric <> v_expected_base THEN
    RAISE EXCEPTION 'Calculation base % does not match the sale amount (expected %)', NEW."base_minor", v_expected_base
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF v."max_total_per_event_minor" IS NOT NULL AND NEW."budget_minor" > v."max_total_per_event_minor" THEN
    RAISE EXCEPTION 'Calculation budget exceeds the policy maximum per sale' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_calculations_insert_guard" BEFORE INSERT ON "reward_calculations"
  FOR EACH ROW EXECUTE FUNCTION app_calculations_insert_guard();

CREATE TRIGGER "trg_calculations_append_only" BEFORE UPDATE OR DELETE ON "reward_calculations"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

-- At commit: Σ rewards = total_allocated, and the outcome agrees with the reward count.
CREATE OR REPLACE FUNCTION app_calculation_assert_totals(p_calculation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  v_sum bigint;
  v_count int;
BEGIN
  SELECT "total_allocated_minor", "outcome" INTO c FROM "reward_calculations" WHERE "id" = p_calculation_id;
  SELECT coalesce(sum("amount_minor"), 0), count(*) INTO v_sum, v_count FROM "rewards" WHERE "calculation_id" = p_calculation_id;
  IF v_sum <> c."total_allocated_minor" OR (c."outcome" = 'REWARDS_CREATED') <> (v_count > 0) THEN
    RAISE EXCEPTION 'Rewards of calculation % do not add up to its total (% vs %)', p_calculation_id, v_sum, c."total_allocated_minor"
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_calculations_totals_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rewards' THEN
    PERFORM app_calculation_assert_totals(NEW."calculation_id");
  ELSE
    PERFORM app_calculation_assert_totals(NEW."id");
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_calculations_totals"
  AFTER INSERT ON "reward_calculations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_calculations_totals_trigger();
CREATE CONSTRAINT TRIGGER "trg_rewards_calculation_totals"
  AFTER INSERT ON "rewards"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_calculations_totals_trigger();

-- ════ Rewards ══════════════════════════════════════════════════════════════════

ALTER TABLE "rewards"
  ADD CONSTRAINT "ck_rewards_amount" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ck_rewards_level" CHECK ("level" BETWEEN 1 AND 10),
  ADD CONSTRAINT "ck_rewards_approved" CHECK ("status" NOT IN ('APPROVED', 'POSTED', 'REVERSED') OR "approved_at" IS NOT NULL),
  ADD CONSTRAINT "ck_rewards_posted" CHECK ("status" NOT IN ('POSTED', 'REVERSED') OR "posted_at" IS NOT NULL),
  ADD CONSTRAINT "ck_rewards_rejected" CHECK ("status" <> 'REJECTED' OR ("rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL)),
  ADD CONSTRAINT "ck_rewards_reversed" CHECK ("status" <> 'REVERSED' OR ("reversed_at" IS NOT NULL AND "reversal_reason" IS NOT NULL AND "reversed_by_id" IS NOT NULL)),
  -- Segregation of duties: nobody decides on their own reward.
  ADD CONSTRAINT "ck_rewards_sod" CHECK (
    ("approved_by_id" IS NULL OR "approved_by_id" <> "recipient_user_id")
    AND ("rejected_by_id" IS NULL OR "rejected_by_id" <> "recipient_user_id")
    AND ("reversed_by_id" IS NULL OR "reversed_by_id" <> "recipient_user_id")
  );

CREATE OR REPLACE FUNCTION app_rewards_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  e record;
  v record;
BEGIN
  IF NEW."status" NOT IN ('PENDING_APPROVAL', 'APPROVED') THEN
    RAISE EXCEPTION 'Rewards are created PENDING_APPROVAL (or APPROVED by an auto-approving policy)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "event_id", "policy_version_id", "reward_unit", "currency_code" INTO c
  FROM "reward_calculations" WHERE "id" = NEW."calculation_id";
  IF c."event_id" <> NEW."event_id" OR c."policy_version_id" <> NEW."policy_version_id"
     OR c."reward_unit" <> NEW."reward_unit" OR c."currency_code" <> NEW."currency_code" THEN
    RAISE EXCEPTION 'Reward must match its calculation' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "program_id", "subject_user_id", "source", "recorded_by_id", "status" INTO e
  FROM "qualifying_events" WHERE "id" = NEW."event_id";
  IF e."program_id" <> NEW."program_id" THEN
    RAISE EXCEPTION 'Reward program must be the event program' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."recipient_user_id" = e."subject_user_id" THEN
    RAISE EXCEPTION 'A member is never rewarded for their own sale' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "referral_paths"
    WHERE "ancestor_id" = NEW."recipient_user_id" AND "descendant_id" = e."subject_user_id" AND "depth" >= NEW."level"
  ) THEN
    RAISE EXCEPTION 'Reward recipient is not an upline of the subject at level %', NEW."level"
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "max_depth", "requires_approval" INTO v FROM "reward_policy_versions" WHERE "id" = NEW."policy_version_id";
  IF NEW."level" > v."max_depth" THEN
    RAISE EXCEPTION 'Reward level exceeds the policy depth' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."approved_by_id" IS NOT NULL OR NEW."rejected_by_id" IS NOT NULL OR NEW."reversed_by_id" IS NOT NULL THEN
    RAISE EXCEPTION 'Decisions are recorded after creation' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'APPROVED' AND (v."requires_approval" OR e."source" = 'ADMIN_MANUAL') THEN
    RAISE EXCEPTION 'This reward requires human approval' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_rewards_insert_guard" BEFORE INSERT ON "rewards"
  FOR EACH ROW EXECUTE FUNCTION app_rewards_insert_guard();

-- Calculated facts are immutable; status follows a strict state machine:
--   PENDING_APPROVAL → APPROVED | REJECTED
--   APPROVED         → POSTED   | REJECTED
--   POSTED           → REVERSED
-- Approving/posting row-locks the event (FOR SHARE) so it serializes with event reversal.
CREATE OR REPLACE FUNCTION app_rewards_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e record;
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
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
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
  -- Decision fields are written once.
  IF (OLD."approved_at" IS NOT NULL AND (NEW."approved_at" IS DISTINCT FROM OLD."approved_at" OR NEW."approved_by_id" IS DISTINCT FROM OLD."approved_by_id"))
     OR (OLD."posted_at" IS NOT NULL AND NEW."posted_at" IS DISTINCT FROM OLD."posted_at")
     OR (OLD."rejected_at" IS NOT NULL AND NEW."rejected_at" IS DISTINCT FROM OLD."rejected_at")
     OR (OLD."reversed_at" IS NOT NULL AND NEW."reversed_at" IS DISTINCT FROM OLD."reversed_at")
  THEN
    RAISE EXCEPTION 'Reward % decisions are immutable', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT "status", "recorded_by_id" INTO e FROM "qualifying_events" WHERE "id" = NEW."event_id" FOR SHARE;
  IF NEW."status" IN ('APPROVED', 'POSTED') AND NEW."status" IS DISTINCT FROM OLD."status"
     AND e."status" NOT IN ('RECEIVED', 'PROCESSED') THEN
    RAISE EXCEPTION 'Event % is no longer active; reward % cannot be approved or posted', NEW."event_id", NEW."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'APPROVED' THEN
    IF NEW."approved_by_id" IS NULL THEN
      RAISE EXCEPTION 'A manual approval must name the approver' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."approved_by_id" = e."recorded_by_id" THEN
      RAISE EXCEPTION 'The person who recorded the sale cannot approve its rewards' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_rewards_guard" BEFORE UPDATE OR DELETE ON "rewards"
  FOR EACH ROW EXECUTE FUNCTION app_rewards_guard();

-- ════ Ledger (append-only, double-entry, one posting + one reversal per reward) ═

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
  ADD CONSTRAINT "ck_ledger_txn_not_self_reversal" CHECK ("reverses_transaction_id" IS NULL OR "reverses_transaction_id" <> "id"),
  ADD CONSTRAINT "ck_ledger_txn_entry_count" CHECK ("entry_count" >= 2),
  ADD CONSTRAINT "ck_ledger_txn_debit_total" CHECK ("debit_total_minor" > 0),
  ADD CONSTRAINT "ck_ledger_txn_key" CHECK (
    "idempotency_key" = CASE "type"
      WHEN 'REWARD_POSTING' THEN 'reward-posting:' || "reward_id"::text
      ELSE 'reward-reversal:' || "reward_id"::text END
  );

CREATE OR REPLACE FUNCTION app_ledger_txn_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  IF NEW."type" = 'REWARD_REVERSAL' THEN
    SELECT "type", "reward_id" INTO t FROM "ledger_transactions" WHERE "id" = NEW."reverses_transaction_id";
    IF t."type" IS DISTINCT FROM 'REWARD_POSTING' OR t."reward_id" IS DISTINCT FROM NEW."reward_id" THEN
      RAISE EXCEPTION 'A reversal must compensate the posting of the same reward' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_ledger_transactions_insert_guard" BEFORE INSERT ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION app_ledger_txn_insert_guard();

CREATE TRIGGER "trg_ledger_transactions_append_only" BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ck_ledger_entries_amount" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "ck_ledger_entries_currency" CHECK ("currency_code" ~ '^[A-Z]{3}$');

CREATE TRIGGER "trg_ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

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

-- At COMMIT every transaction must: match its header (entry count, debit total), balance per
-- unit/currency, and have the exact shape of a posting (debit platform expense / credit the
-- recipient, both = reward amount) or of a mirror-image reversal of its posting. Appending
-- entries to an existing transaction therefore always fails.
CREATE OR REPLACE FUNCTION app_ledger_assert_transaction(p_transaction_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  r record;
  v_count int;
  v_debits bigint;
  v_credits bigint;
  v_unbalanced int;
  v_mismatch int;
BEGIN
  SELECT * INTO t FROM "ledger_transactions" WHERE "id" = p_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger entries reference a missing transaction %', p_transaction_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*),
         coalesce(sum("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0),
         coalesce(sum("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)
    INTO v_count, v_debits, v_credits
    FROM "ledger_entries" WHERE "transaction_id" = p_transaction_id;
  IF v_count <> t."entry_count" OR v_debits <> t."debit_total_minor" OR v_debits <> v_credits THEN
    RAISE EXCEPTION 'Ledger transaction % does not match its header or does not balance', p_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_unbalanced FROM (
    SELECT 1 FROM "ledger_entries" WHERE "transaction_id" = p_transaction_id
    GROUP BY "reward_unit", "currency_code"
    HAVING sum(CASE WHEN "direction" = 'DEBIT' THEN "amount_minor" ELSE -"amount_minor" END) <> 0
  ) u;
  IF v_unbalanced > 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced per unit/currency', p_transaction_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT "recipient_user_id", "amount_minor", "reward_unit", "currency_code" INTO r FROM "rewards" WHERE "id" = t."reward_id";
  IF t."type" = 'REWARD_POSTING' THEN
    IF t."entry_count" <> 2
       OR NOT EXISTS (
         SELECT 1 FROM "ledger_entries" le JOIN "ledger_accounts" a ON a."id" = le."account_id"
         WHERE le."transaction_id" = p_transaction_id AND le."direction" = 'DEBIT'
           AND a."type" = 'PLATFORM_REWARD_EXPENSE' AND le."amount_minor" = r."amount_minor"
           AND le."reward_unit" = r."reward_unit" AND le."currency_code" = r."currency_code")
       OR NOT EXISTS (
         SELECT 1 FROM "ledger_entries" le JOIN "ledger_accounts" a ON a."id" = le."account_id"
         WHERE le."transaction_id" = p_transaction_id AND le."direction" = 'CREDIT'
           AND a."type" = 'MEMBER_REWARDS_PAYABLE' AND a."user_id" = r."recipient_user_id"
           AND le."amount_minor" = r."amount_minor"
           AND le."reward_unit" = r."reward_unit" AND le."currency_code" = r."currency_code")
    THEN
      RAISE EXCEPTION 'Posting % must debit platform expense and credit the recipient by the reward amount', p_transaction_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT count(*) INTO v_mismatch FROM (
      (SELECT "account_id", CASE WHEN "direction" = 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END AS dir, "amount_minor"
         FROM "ledger_entries" WHERE "transaction_id" = t."reverses_transaction_id"
       EXCEPT ALL
       SELECT "account_id", "direction"::text, "amount_minor" FROM "ledger_entries" WHERE "transaction_id" = p_transaction_id)
      UNION ALL
      (SELECT "account_id", "direction"::text, "amount_minor" FROM "ledger_entries" WHERE "transaction_id" = p_transaction_id
       EXCEPT ALL
       SELECT "account_id", CASE WHEN "direction" = 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, "amount_minor"
         FROM "ledger_entries" WHERE "transaction_id" = t."reverses_transaction_id")
    ) m;
    IF v_mismatch > 0 THEN
      RAISE EXCEPTION 'Reversal % must mirror its posting exactly', p_transaction_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$;

-- Reward status and ledger agree: POSTED ⇔ one posting; REVERSED ⇔ posting + reversal;
-- otherwise no ledger transactions.
CREATE OR REPLACE FUNCTION app_reward_assert_ledger(p_reward_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status "RewardStatus";
  v_post int;
  v_rev int;
BEGIN
  SELECT "status" INTO v_status FROM "rewards" WHERE "id" = p_reward_id;
  SELECT count(*) FILTER (WHERE "type" = 'REWARD_POSTING'), count(*) FILTER (WHERE "type" = 'REWARD_REVERSAL')
    INTO v_post, v_rev FROM "ledger_transactions" WHERE "reward_id" = p_reward_id;
  IF (v_status = 'POSTED' AND (v_post <> 1 OR v_rev <> 0))
     OR (v_status = 'REVERSED' AND (v_post <> 1 OR v_rev <> 1))
     OR (v_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED') AND (v_post + v_rev) <> 0) THEN
    RAISE EXCEPTION 'Reward % status % does not match its ledger postings', p_reward_id, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app_ledger_txn_commit_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_ledger_assert_transaction(NEW."id");
  PERFORM app_reward_assert_ledger(NEW."reward_id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_ledger_transactions_valid"
  AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_ledger_txn_commit_trigger();

CREATE OR REPLACE FUNCTION app_ledger_entry_commit_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_ledger_assert_transaction(NEW."transaction_id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_ledger_entries_valid"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_ledger_entry_commit_trigger();

CREATE OR REPLACE FUNCTION app_rewards_ledger_commit_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_reward_assert_ledger(NEW."id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_rewards_ledger_coupling"
  AFTER INSERT OR UPDATE OF "status" ON "rewards"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_rewards_ledger_commit_trigger();

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

-- ════ Audit (append-only, no secrets) ══════════════════════════════════════════

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "ck_audit_logs_action" CHECK (length(btrim("action")) > 0),
  ADD CONSTRAINT "ck_audit_logs_no_secrets" CHECK (
    (coalesce("before"::text, '') || coalesce("after"::text, ''))
      !~* '"(password|password_?hash|token|token_?hash|otp|otp_?code|code_?hash|secret|secret_?enc|session_?token|csrf_?token|api_?key|key_?hash|code_?ciphertext)"\s*:'
  );

CREATE TRIGGER "trg_audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();

-- ════ Outbox (no plaintext OTPs; ciphertext scrubbed once delivered) ═══════════

ALTER TABLE "outbox_messages"
  ADD CONSTRAINT "ck_outbox_attempts" CHECK ("attempts" >= 0 AND "max_attempts" >= 1),
  ADD CONSTRAINT "ck_outbox_no_plain_otp" CHECK ("payload"::text !~* '"(code|otp)"\s*:'),
  ADD CONSTRAINT "ck_outbox_otp_scrubbed" CHECK ("status" NOT IN ('SENT', 'DEAD') OR "payload"::text !~ '"codeCiphertext"');

-- ════ Member flags ═════════════════════════════════════════════════════════════

ALTER TABLE "member_flags"
  ADD CONSTRAINT "ck_member_flags_resolved" CHECK ("status" = 'OPEN' OR ("resolved_at" IS NOT NULL AND "resolved_by_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_member_flags_not_self_resolved" CHECK ("resolved_by_id" IS NULL OR "resolved_by_id" <> "user_id");

CREATE UNIQUE INDEX "uq_member_flags_open_dedupe"
  ON "member_flags" ("dedupe_key")
  WHERE "status" = 'OPEN' AND "dedupe_key" IS NOT NULL;
