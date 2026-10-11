-- Reliability & performance (no business rule changes):
--
-- 1. Indexes for the keyset lists (common/pagination/keyset.ts), the member reward / notification
--    lists, the ledger accounts page and the admin sale search (declared in schema.prisma).
-- 2. Referral closure consistency: the commit-time check now runs ONCE per touched member instead of
--    once per inserted/deleted closure row, and the referral_paths guards evaluate the
--    correction-authorization check once per statement instead of once per row. Same guarantees,
--    still deferred to COMMIT (see docs/database.md "Referral tree").
-- 3. Program status history: the scheduler records SCHEDULED → ACTIVE at `starts_at` and
--    → COMPLETED at `ends_at` (the instant the transition was due), not at the time the job ran.

-- ════ 1. Indexes ════════════════════════════════════════════════════════════════

-- CreateIndex
CREATE INDEX "ledger_accounts_created_at_id_idx" ON "ledger_accounts"("created_at", "id");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "notifications"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "program_enrollments_created_at_id_idx" ON "program_enrollments"("created_at", "id");

-- CreateIndex
CREATE INDEX "qualifying_events_external_id_idx" ON "qualifying_events"("external_id");

-- CreateIndex
CREATE INDEX "qualifying_events_customer_reference_idx" ON "qualifying_events"("customer_reference");

-- CreateIndex
CREATE INDEX "rewards_recipient_user_id_created_at_id_idx" ON "rewards"("recipient_user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "rewards_recipient_user_id_updated_at_id_idx" ON "rewards"("recipient_user_id", "updated_at" DESC, "id" DESC);

-- ════ 2. Referral tree: de-duplicated commit-time consistency check ═════════════
--
-- Before: AFTER ROW deferred constraint triggers on referral_paths (INSERT/DELETE) and
-- referral_relationships (INSERT/UPDATE) called app_referral_assert_consistent(member) once per
-- ROW. A sponsor correction moving a subtree of N members under/away from D ancestors touches
-- 2·N·D closure rows, so the same N members were re-checked 2·D times each at COMMIT (minutes for
-- large subtrees, while the exclusive tree lock blocks every registration and sale).
--
-- Now: statement-level AFTER triggers (transition tables) queue the DISTINCT touched members of each
-- statement in app_private.referral_pending_checks (one row per transaction × member, ON CONFLICT DO
-- NOTHING), and a DEFERRABLE INITIALLY DEFERRED constraint trigger on that queue runs the unchanged
-- app_referral_assert_consistent() once per queued member at COMMIT (or at SET CONSTRAINTS …
-- IMMEDIATE), then removes the queue row. The deferred event is queued when the row is inserted, so
-- deleting queue rows cannot skip a check. Relationship DELETEs and the old child of a relationship
-- UPDATE are now checked too (previously unchecked; strictly stronger).
--
-- The queue lives in its own schema so the Prisma schema (public) stays unchanged; rows never
-- outlive their transaction (UNLOGGED: nothing to recover after a crash).

CREATE SCHEMA IF NOT EXISTS "app_private";

CREATE UNLOGGED TABLE "app_private"."referral_pending_checks" (
  "tx_id" xid8 NOT NULL DEFAULT pg_current_xact_id(),
  "member_id" uuid NOT NULL,
  CONSTRAINT "referral_pending_checks_pkey" PRIMARY KEY ("tx_id", "member_id")
);

CREATE OR REPLACE FUNCTION app_referral_pending_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app_referral_assert_consistent(NEW."member_id");
  DELETE FROM "app_private"."referral_pending_checks"
   WHERE "tx_id" = NEW."tx_id" AND "member_id" = NEW."member_id";
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_referral_pending_checks"
  AFTER INSERT ON "app_private"."referral_pending_checks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_referral_pending_check();

CREATE OR REPLACE FUNCTION app_referral_queue_inserted_paths() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app_private"."referral_pending_checks" ("member_id")
  SELECT DISTINCT n."descendant_id" FROM "new_rows" n
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_referral_queue_removed_paths() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app_private"."referral_pending_checks" ("member_id")
  SELECT DISTINCT o."descendant_id" FROM "old_rows" o
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_referral_queue_inserted_relationships() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app_private"."referral_pending_checks" ("member_id")
  SELECT DISTINCT n."child_user_id" FROM "new_rows" n
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_referral_queue_updated_relationships() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app_private"."referral_pending_checks" ("member_id")
  SELECT n."child_user_id" FROM "new_rows" n
  UNION
  SELECT o."child_user_id" FROM "old_rows" o
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_referral_queue_removed_relationships() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app_private"."referral_pending_checks" ("member_id")
  SELECT DISTINCT o."child_user_id" FROM "old_rows" o
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "trg_referral_paths_consistent" ON "referral_paths";
DROP TRIGGER IF EXISTS "trg_referral_relationships_consistent" ON "referral_relationships";
DROP FUNCTION IF EXISTS app_referral_paths_consistency_trigger();
DROP FUNCTION IF EXISTS app_referral_relationships_consistency_trigger();

CREATE TRIGGER "trg_referral_paths_queue_insert" AFTER INSERT ON "referral_paths"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_queue_inserted_paths();
CREATE TRIGGER "trg_referral_paths_queue_delete" AFTER DELETE ON "referral_paths"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_queue_removed_paths();
-- UPDATE of closure rows: both images (an updated descendant_id leaves one member, joins another).
CREATE OR REPLACE FUNCTION app_referral_queue_updated_paths() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app_private"."referral_pending_checks" ("member_id")
  SELECT n."descendant_id" FROM "new_rows" n
  UNION
  SELECT o."descendant_id" FROM "old_rows" o
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "trg_referral_paths_queue_update" AFTER UPDATE ON "referral_paths"
  REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_queue_updated_paths();

CREATE TRIGGER "trg_referral_relationships_queue_insert" AFTER INSERT ON "referral_relationships"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_queue_inserted_relationships();
CREATE TRIGGER "trg_referral_relationships_queue_update" AFTER UPDATE ON "referral_relationships"
  REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_queue_updated_relationships();
CREATE TRIGGER "trg_referral_relationships_queue_delete" AFTER DELETE ON "referral_relationships"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_queue_removed_relationships();

-- ── referral_paths guards: correction authorization once per statement ──────────
--
-- app_in_referral_correction() (correction row created by this transaction + the exclusive tree
-- lock held, read from pg_locks) does not depend on the row, but the BEFORE ROW guards evaluated it
-- for every closure row a correction deletes or inserts.
--
-- UPDATE/DELETE: the row guard is replaced by AFTER STATEMENT guards that raise when the statement
-- changed at least one row outside a correction (the statement — and its transaction — is rolled
-- back, exactly as before; statements that change nothing still pass).
--
-- INSERT: the row guard (registration protocol checks) still runs for every row whenever no
-- correction id is set, i.e. for every registration, unchanged. When app.referral_correction_id is
-- set, a statement guard verifies the correction once; if that verification fails it applies the
-- same registration checks to every inserted row (the old row guard's fallback), so a stray setting
-- can never authorize anything.

DROP TRIGGER IF EXISTS "trg_referral_paths_guard" ON "referral_paths";
DROP TRIGGER IF EXISTS "trg_referral_paths_insert_guard" ON "referral_paths";

CREATE OR REPLACE FUNCTION app_referral_paths_modify_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "old_rows") AND NOT app_in_referral_correction() THEN
    RAISE EXCEPTION 'Referral attribution on "%" is immutable outside the audited correction workflow', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "trg_referral_paths_guard_update" AFTER UPDATE ON "referral_paths"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_paths_modify_guard();
CREATE TRIGGER "trg_referral_paths_guard_delete" AFTER DELETE ON "referral_paths"
  REFERENCING OLD TABLE AS "old_rows"
  FOR EACH STATEMENT EXECUTE FUNCTION app_referral_paths_modify_guard();

-- Registration rows: unchanged per-row checks (app_referral_paths_insert_guard), only when no
-- correction is claimed (the function returned early for real corrections anyway).
CREATE TRIGGER "trg_referral_paths_insert_guard" BEFORE INSERT ON "referral_paths"
  FOR EACH ROW
  WHEN (nullif(current_setting('app.referral_correction_id', true), '') IS NULL)
  EXECUTE FUNCTION app_referral_paths_insert_guard();

CREATE OR REPLACE FUNCTION app_referral_paths_insert_statement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "new_rows") OR app_in_referral_correction() THEN
    RETURN NULL;
  END IF;
  -- Not a real correction: the registration protocol applies to every row (app_referral_paths_insert_guard).
  IF app_referral_lock_mode() IS NULL
     OR EXISTS (SELECT 1 FROM "new_rows" n WHERE NOT app_user_created_in_this_tx(n."descendant_id")) THEN
    RAISE EXCEPTION 'Closure rows are only written by the registration that creates the member'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "new_rows" n
     WHERE n."depth" > 0 AND NOT EXISTS (
       SELECT 1 FROM "referral_paths" sp
        WHERE sp."ancestor_id" = n."descendant_id" AND sp."descendant_id" = n."descendant_id"
          AND app_created_in_this_tx(sp."xmin")
     )
  ) THEN
    RAISE EXCEPTION 'Closure rows are only written by the registration that creates the member (self row first)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "trg_referral_paths_insert_guard_correction" AFTER INSERT ON "referral_paths"
  REFERENCING NEW TABLE AS "new_rows"
  FOR EACH STATEMENT
  WHEN (nullif(current_setting('app.referral_correction_id', true), '') IS NOT NULL)
  EXECUTE FUNCTION app_referral_paths_insert_statement_guard();

-- ════ 3. Program status changes at the scheduled instant ══════════════════════════
--
-- The scheduler passes the instant a transition was due with
--   SELECT set_config('app.status_changed_at', '<starts_at | ends_at>', true)
-- so a late run (60 s tick, worker restart, row lock contention) does not leave a gap in which
-- sales after starts_at look like "program not active" forever. The requested instant is honoured
-- only for SCHEDULED → ACTIVE (never before starts_at) and ACTIVE|PAUSED → COMPLETED (never before
-- ends_at), never after now() and never before the program's previous status change (+1 ms, so the
-- history stays strictly ordered). Any other transition — and every manual one — is logged at now().

CREATE OR REPLACE FUNCTION app_programs_log_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_at timestamptz := now();
  v_requested timestamptz;
  v_floor timestamptz;
  v_last timestamptz;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF TG_OP = 'UPDATE' THEN
      v_requested := nullif(current_setting('app.status_changed_at', true), '')::timestamptz;
      IF v_requested IS NOT NULL THEN
        v_floor := CASE
          WHEN OLD."status" = 'SCHEDULED' AND NEW."status" = 'ACTIVE' THEN NEW."starts_at"
          WHEN OLD."status" IN ('ACTIVE', 'PAUSED') AND NEW."status" = 'COMPLETED' THEN NEW."ends_at"
        END;
        IF v_floor IS NOT NULL THEN
          SELECT max("changed_at") INTO v_last FROM "program_status_changes" WHERE "program_id" = NEW."id";
          v_at := least(now(), greatest(v_requested, v_floor, v_last + interval '1 millisecond'));
        END IF;
      END IF;
    END IF;
    INSERT INTO "program_status_changes" ("id", "program_id", "from_status", "to_status", "changed_at", "changed_by_id", "reason")
    VALUES (
      gen_random_uuid(), NEW."id",
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."status" END,
      NEW."status", v_at, NEW."updated_by_id",
      nullif(left(coalesce(current_setting('app.status_reason', true), ''), 1000), '')
    );
  END IF;
  RETURN NULL;
END;
$$;
