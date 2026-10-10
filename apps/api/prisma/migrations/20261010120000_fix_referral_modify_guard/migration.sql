-- Fix: app_referral_modify_guard() evaluated NEW."child_user_id" for every table it guards, so any
-- UPDATE/DELETE on referral_paths inside an audited correction failed with 42703
-- (record "new" has no field "child_user_id"). The cycle check now runs only for UPDATEs of
-- referral_relationships; PL/pgSQL resolves record fields lazily per branch.

CREATE OR REPLACE FUNCTION app_referral_modify_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT app_in_referral_correction() THEN
    RAISE EXCEPTION 'Referral attribution on "%" is immutable outside the audited correction workflow', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'referral_relationships' AND TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT 1 FROM "referral_paths"
      WHERE "ancestor_id" = NEW."child_user_id" AND "descendant_id" = NEW."sponsor_user_id"
    ) THEN
      RAISE EXCEPTION 'Referral cycle: % is inside the subtree of %', NEW."sponsor_user_id", NEW."child_user_id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
