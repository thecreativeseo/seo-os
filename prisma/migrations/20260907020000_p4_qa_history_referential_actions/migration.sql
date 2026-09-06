-- P4 M5.1 follow-up: referential actions on immutable QA history.
--
-- This is an empty migration as far as the schema is concerned: no table, no
-- column, no enum, no data. It replaces two trigger functions.
--
-- The defect. A completed content_qa_run and every content_qa_result are
-- history, and their triggers refused every UPDATE. But three of the run's
-- references and one of the result's are ON DELETE SET NULL, so when the row
-- they point at is deleted - an evidence package, an AI run, a business
-- context version, each of which goes when its website does - PostgreSQL
-- performs exactly that UPDATE itself, and the trigger refused it. The
-- documented history teardown of a website that had ever run QA therefore
-- failed, with the error naming an immutable run.
--
-- The fix is the pattern P4 M1 already established for content_brief and
-- content_revision: an immutable row still takes part in referential actions,
-- so a reference column may go to NULL and nothing else may move. The
-- history-deletion switch is unchanged and still guards every DELETE.
--
-- Which columns, and only these, from the catalogue:
--   content_qa_run.evidence_package_id -> evidence_package        (SET NULL)
--   content_qa_run.ai_run_id           -> ai_run                  (SET NULL)
--   content_qa_run.context_version_id  -> business_context_version(SET NULL)
--   content_qa_result.ai_run_id        -> ai_run                  (SET NULL)
-- Every other reference on both tables is CASCADE (the row goes with its
-- parent) or RESTRICT (a person who requested a run is not deletable), so
-- neither can ever be asked to change them. content_cms_approval has no
-- SET NULL reference at all; its trigger is untouched.

-- ---------------------------------------------------------------------------
-- A run is written once: RUNNING at creation, then one completion. After that
-- it is history, and the only change it may take is a reference the database
-- nulls because the row it pointed at is gone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_content_qa_run_immutability()
RETURNS TRIGGER AS $$
DECLARE
  old_j jsonb;
  new_j jsonb;
  k text;
  reference_columns text[] := ARRAY['evidence_package_id', 'ai_run_id', 'context_version_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_qa_run % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- Still running: the service is completing it. The binding may not move
  -- even then.
  IF OLD."status" = 'RUNNING' THEN
    IF NEW."content_revision_id" <> OLD."content_revision_id"
       OR NEW."revision_hash" <> OLD."revision_hash"
       OR NEW."content_work_item_id" <> OLD."content_work_item_id"
       OR NEW."requested_by_user_id" <> OLD."requested_by_user_id" THEN
      RAISE EXCEPTION 'content_qa_run % binding cannot change', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- Completed or failed: history. Every changed column must be a permitted
  -- reference going from something to nothing. A reference gaining a value,
  -- or swapping one row for another, is a mutation like any other.
  old_j := to_jsonb(OLD);
  new_j := to_jsonb(NEW);

  FOR k IN SELECT key FROM jsonb_each(new_j) LOOP
    IF (new_j -> k) IS DISTINCT FROM (old_j -> k) THEN
      IF k = ANY (reference_columns)
         AND (new_j -> k) = 'null'::jsonb
         AND (old_j -> k) <> 'null'::jsonb THEN
        -- The referenced row is gone; the reference goes with it, the record stays.
        CONTINUE;
      END IF;
      RAISE EXCEPTION
        'content_qa_run % is % and immutable (attempted UPDATE of %)', OLD.id, OLD."status", k;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- A result is written while its run is running, bound to that run's revision
-- and hash, and never changes afterwards - except for the one reference the
-- database may null.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_content_qa_result_binding()
RETURNS TRIGGER AS $$
DECLARE
  old_j jsonb;
  new_j jsonb;
  k text;
  run_revision uuid;
  run_hash text;
  run_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_qa_result % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);

    FOR k IN SELECT key FROM jsonb_each(new_j) LOOP
      IF (new_j -> k) IS DISTINCT FROM (old_j -> k) THEN
        IF k = 'ai_run_id'
           AND (new_j -> k) = 'null'::jsonb
           AND (old_j -> k) <> 'null'::jsonb THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION
          'content_qa_result % is immutable (attempted UPDATE of %)', OLD.id, k;
      END IF;
    END LOOP;

    RETURN NEW;
  END IF;

  SELECT r."content_revision_id", r."revision_hash", r."status"
    INTO run_revision, run_hash, run_status
    FROM "content_qa_run" r
   WHERE r."id" = NEW."qa_run_id";

  IF run_revision IS NULL THEN
    RAISE EXCEPTION 'content_qa_result names a run that does not exist';
  END IF;
  IF run_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'content_qa_result cannot be added to run %, which is %', NEW."qa_run_id", run_status;
  END IF;
  IF NEW."content_revision_id" <> run_revision OR NEW."revision_hash" <> run_hash THEN
    RAISE EXCEPTION 'content_qa_result does not match the revision and hash of run %', NEW."qa_run_id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
