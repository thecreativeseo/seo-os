-- Approved Business Context versions are immutable (CLAUDE.md, P0_SPEC.md §13).
-- "Approved context mutation" is a release-blocking P0 failure, so this is enforced
-- in the database as well as in the service layer.
--
-- The DRAFT -> APPROVED transition is permitted because OLD.status is still DRAFT
-- at that moment. Once a row is APPROVED, every UPDATE and DELETE is rejected.
-- Editing approved context must create a new DRAFT version instead.

CREATE OR REPLACE FUNCTION enforce_business_context_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION
      'business_context_version % is APPROVED and immutable (attempted %)',
      OLD.id, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER business_context_version_immutable
  BEFORE UPDATE OR DELETE ON "business_context_version"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_business_context_version_immutability();
