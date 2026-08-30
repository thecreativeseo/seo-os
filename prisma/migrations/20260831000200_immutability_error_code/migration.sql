-- The original trigger raised with ERRCODE 'restrict_violation' (SQLSTATE 23001).
-- Prisma maps the whole 23xxx integrity-violation class to P2003 "foreign key
-- constraint violated", which discards the message and misreports the cause.
--
-- Raising with the default 'raise_exception' (P0001) surfaces the real reason to
-- the application, so a blocked mutation is legible instead of looking like an
-- unrelated FK problem.

CREATE OR REPLACE FUNCTION enforce_business_context_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION
      'business_context_version % is APPROVED and immutable (attempted %)',
      OLD.id, TG_OP;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
