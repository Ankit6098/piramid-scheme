-- Allow cancelling a SCHEDULED program before it starts: SCHEDULED → ARCHIVED.
--
-- A scheduled program has never been ACTIVE, so it has no enrollments and no sales (both require an
-- ACTIVE program); cancelling it simply withdraws it. The application sets `ends_at` (required for
-- ARCHIVED by ck_programs_completed_has_end, and > starts_at by ck_programs_dates) and passes the
-- reason via app.status_reason so trg_programs_log_status records it in program_status_changes.
--
-- The function below is app_programs_guard() from 20261009191031_integrity_constraints, unchanged
-- except for the SCHEDULED line of the transition list. The trigger keeps pointing at it.

CREATE OR REPLACE FUNCTION app_programs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_offering_status "OfferingStatus";
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT' AND NEW."status" IN ('SCHEDULED', 'ACTIVE'))
    OR (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('ACTIVE', 'ARCHIVED'))
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
