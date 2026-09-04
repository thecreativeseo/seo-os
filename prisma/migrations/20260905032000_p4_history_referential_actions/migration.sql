-- P4 M1 follow-up: referential actions on immutable rows (see the trigger comments below).

-- This is an empty migration.


-- ---------------------------------------------------------------------------
-- Immutable rows still take part in referential actions. When a page, a
-- keyword, an evidence package or an AI run is removed, the reference on an
-- approved brief or a revision is set to NULL by the database; the content is
-- untouched. The triggers now allow exactly that - a reference column going
-- to NULL - and nothing else. Authorship by a person is RESTRICT at the
-- foreign key instead: a user who wrote content is not deletable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_content_brief_immutability()
RETURNS TRIGGER AS $$
DECLARE
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
  k text;
  reference_columns text[] := ARRAY[
    'target_page_id', 'primary_keyword_id', 'topic_id', 'business_goal_id',
    'evidence_package_id', 'created_by_ai_run_id'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'APPROVED' AND NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION
        'content_brief % is APPROVED and immutable (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'APPROVED' THEN
    RETURN NEW;
  END IF;

  FOR k IN SELECT key FROM jsonb_each(new_j) LOOP
    IF (new_j -> k) IS DISTINCT FROM (old_j -> k) THEN
      IF k IN ('status', 'archived_at') THEN
        IF NEW.status NOT IN ('SUPERSEDED', 'ARCHIVED') THEN
          RAISE EXCEPTION
            'content_brief % is APPROVED and immutable (attempted UPDATE of status to %)', OLD.id, NEW.status;
        END IF;
      ELSIF k = ANY (reference_columns) AND (new_j -> k) = 'null'::jsonb THEN
        -- The referenced row is gone; the reference goes with it, the content stays.
        CONTINUE;
      ELSE
        RAISE EXCEPTION
          'content_brief % is APPROVED and immutable (attempted UPDATE of %)', OLD.id, k;
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_content_revision_immutability()
RETURNS TRIGGER AS $$
DECLARE
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
  k text;
  reference_columns text[] := ARRAY['evidence_package_id', 'created_by_ai_run_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_revision % is immutable (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  FOR k IN SELECT key FROM jsonb_each(new_j) LOOP
    IF (new_j -> k) IS DISTINCT FROM (old_j -> k) THEN
      IF k = ANY (reference_columns) AND (new_j -> k) = 'null'::jsonb THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'content_revision % is immutable (attempted UPDATE of %)', OLD.id, k;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Provenance: exactly one author on insert. The check constraint alone said
-- "exactly one", which a cascade that nulls the run's reference would violate
-- mid-delete; it now says "never both", and the insert trigger says "at least
-- one". A revision therefore starts with exactly one author and can only lose
-- it when the run itself is torn down.
ALTER TABLE "content_revision" DROP CONSTRAINT "content_revision_provenance_check";
ALTER TABLE "content_revision"
  ADD CONSTRAINT "content_revision_provenance_check"
  CHECK (NOT ("created_by_ai_run_id" IS NOT NULL AND "created_by_user_id" IS NOT NULL));

CREATE OR REPLACE FUNCTION enforce_content_revision_provenance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by_ai_run_id IS NULL AND NEW.created_by_user_id IS NULL THEN
    RAISE EXCEPTION 'content_revision needs exactly one author: an AI run or a person';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER content_revision_provenance
  BEFORE INSERT ON "content_revision"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_content_revision_provenance();
