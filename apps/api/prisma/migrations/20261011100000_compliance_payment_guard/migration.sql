-- Compliance hardening: plan payments never fund rewards (business rules §0.1, §8, §11).
--
-- 1. Payment references are unique across programs (program_enrollments_payment_reference_key), so a
--    sale whose external id is ANY enrollment payment reference is a plan payment, whichever program
--    it is recorded in. The own-payment amount match also spans every program in the sale's currency.
-- 2. The ±2-day window is checked against the sale date AND the recording time: back-dating
--    occurred_at no longer escapes it.
-- 3. app_plan_payment_matches() lists the plan payments a sale resembles — the subject's own
--    (depth 0) or one made by a member of the subject's downline (depth ≥ 1, e.g. a recruit's plan
--    payment recorded as the sponsor's sale). Own matches are refused at insert (below). Downline
--    matches are not refused (an honest sale can match an amount by coincidence), but such a sale's
--    rewards are never auto-approved: trg_rewards_lookalike_guard refuses an APPROVED reward for it,
--    so a reviewer always sees the compliance warning first.

-- Plan payments are looked up by amount (selective), then window, then relation to the subject.
CREATE INDEX "ix_enrollments_payment_amount" ON "program_enrollments" ("payment_amount_minor", "payment_recorded_at")
  WHERE "payment_amount_minor" IS NOT NULL;

-- Plan payments a sale resembles: same amount, a program in the sale's currency, recorded within
-- ±2 days of the sale date or of the time the sale was recorded, paid by the subject (depth 0) or by
-- a member of the subject's downline (depth = distance below the subject).
CREATE OR REPLACE FUNCTION app_plan_payment_matches(
  p_subject uuid, p_amount bigint, p_currency text, p_occurred_at timestamptz, p_recorded_at timestamptz
) RETURNS TABLE ("enrollment_id" uuid, "payer_user_id" uuid, "program_id" uuid, "depth" integer, "payment_recorded_at" timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT pe."id", pe."user_id", pe."program_id",
         CASE WHEN pe."user_id" = p_subject THEN 0 ELSE rp."depth" END,
         pe."payment_recorded_at"
    FROM "program_enrollments" pe
    JOIN "programs" pr ON pr."id" = pe."program_id"
    LEFT JOIN "referral_paths" rp
      ON rp."ancestor_id" = p_subject AND rp."descendant_id" = pe."user_id" AND rp."depth" >= 1
   WHERE pe."payment_amount_minor" = p_amount
     AND pr."currency_code" = p_currency
     AND (pe."user_id" = p_subject OR rp."descendant_id" IS NOT NULL)
     AND (p_occurred_at BETWEEN pe."payment_recorded_at" - interval '2 days' AND pe."payment_recorded_at" + interval '2 days'
          OR p_recorded_at BETWEEN pe."payment_recorded_at" - interval '2 days' AND pe."payment_recorded_at" + interval '2 days')
$$;

-- Unchanged except for the compliance block at the end (global reference + amount match, window on
-- the sale date or the recording time).
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

  -- Compliance: a member's own plan payment is never a qualifying sale — in any program. Payment
  -- references are unique across programs; the amount match spans every program in the sale's
  -- currency, within ±2 days of the sale date OR of now (the recording time), so back-dating the
  -- sale cannot escape the window.
  IF EXISTS (SELECT 1 FROM "program_enrollments" WHERE "payment_reference" = NEW."external_id") THEN
    RAISE EXCEPTION 'This id is a member plan payment, not a sale' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_plan_payment_matches(NEW."subject_user_id", NEW."amount_minor", NEW."currency_code", NEW."occurred_at", now()) m
     WHERE m."depth" = 0
  ) THEN
    RAISE EXCEPTION 'This looks like the member''s own plan payment; plan payments never earn rewards'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A sale that resembles a plan payment (own or downline, judged at the sale's recording time) never
-- has its rewards approved automatically: they are created PENDING_APPROVAL for a reviewer.
CREATE OR REPLACE FUNCTION app_rewards_lookalike_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e record;
BEGIN
  SELECT "subject_user_id", "amount_minor", "currency_code", "occurred_at", "created_at" INTO e
  FROM "qualifying_events" WHERE "id" = NEW."event_id";
  IF EXISTS (
    SELECT 1 FROM app_plan_payment_matches(e."subject_user_id", e."amount_minor", e."currency_code", e."occurred_at", e."created_at")
  ) THEN
    RAISE EXCEPTION 'Rewards of a sale that resembles a plan payment need human approval'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_rewards_lookalike_guard" BEFORE INSERT ON "rewards"
  FOR EACH ROW WHEN (NEW."status" <> 'PENDING_APPROVAL')
  EXECUTE FUNCTION app_rewards_lookalike_guard();
