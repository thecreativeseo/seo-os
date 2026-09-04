-- The P4 history triggers raised with ERRCODE 'restrict_violation'. Prisma maps
-- the whole 23xxx class to P2003 "foreign key constraint violated" and discards
-- the message, so a refused edit looked like an unrelated FK problem - the same
-- lesson the P0 trigger learned in 20260831000200. Raise with the default
-- 'raise_exception' instead, so the reason reaches the application.
--
-- The delete escape hatch also joins the one P0 already has: the same
-- transaction-scoped setting tears down approved context and P4 history alike.
--
--   SET LOCAL app.allow_approved_context_delete = 'on';

CREATE OR REPLACE FUNCTION seo_os_history_delete_allowed()
RETURNS boolean AS $$
  SELECT COALESCE(current_setting('app.allow_approved_context_delete', true), 'off') = 'on';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION enforce_content_brief_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'APPROVED' AND NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION
        'content_brief % is APPROVED and immutable (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'APPROVED' THEN
    IF NEW.status NOT IN ('SUPERSEDED', 'ARCHIVED')
       OR (to_jsonb(NEW) - 'status' - 'archived_at') <> (to_jsonb(OLD) - 'status' - 'archived_at') THEN
      RAISE EXCEPTION
        'content_brief % is APPROVED and immutable (attempted UPDATE)', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_content_revision_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'content_revision % is immutable (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'content_revision % is immutable (attempted UPDATE)', OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_publish_approval_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'publish_approval % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION
      'publish_approval % is % and immutable (attempted UPDATE)', OLD.id, OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_execution_step_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT seo_os_history_delete_allowed() THEN
      RAISE EXCEPTION 'execution_step % is history (attempted DELETE)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'execution_step % is append-only (attempted UPDATE)', OLD.id;
END;
$$ LANGUAGE plpgsql;
