-- The immutability trigger also blocks cascade deletes, so an Organization holding
-- an approved Business Context could never be removed — including by test teardown.
--
-- Content immutability stays absolute: UPDATE of an APPROVED row is rejected
-- unconditionally, which is the invariant P0_ACCEPTANCE_CRITERIA calls release-blocking.
-- DELETE is permitted only when the caller explicitly opts in for that transaction:
--
--   SET LOCAL app.allow_approved_context_delete = 'on';
--
-- This is deliberately awkward to reach. It exists for whole-tenant removal and test
-- teardown, not for editing history. No application code path sets it.

CREATE OR REPLACE FUNCTION enforce_business_context_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    IF TG_OP = 'DELETE'
       AND current_setting('app.allow_approved_context_delete', true) = 'on' THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION
      'business_context_version % is APPROVED and immutable (attempted %)',
      OLD.id, TG_OP;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
