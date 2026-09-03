-- Two more audit verbs for the P3 review loop (P3_SPEC section 24, section 35).
--
-- APPROVE and REJECT already exist from P0 governance. A reviewer can also send a
-- recommendation back modified, or send it back for more evidence, and each of
-- those is a decision worth its own verb in the audit trail rather than an
-- UPDATE that says nothing about what was decided.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MODIFY';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REQUEST_EVIDENCE';
