-- Opportunity identity, with NULLS NOT DISTINCT.
--
-- Most opportunities reference only some of page, keyword, topic and competitor: a
-- TOPIC_GAP has no keyword, a CTR opportunity has no competitor. Under Postgres's
-- default NULLS DISTINCT, two rows that are identical apart from their NULLs do
-- not conflict, so every detection run would insert a fresh copy of the same
-- opportunity and the queue would grow without bound.
--
-- This is exactly the bug P1 hit with freshness signals. Prisma still cannot
-- express NULLS NOT DISTINCT, so the index is written by hand — and named short
-- enough that Postgres will not truncate it into a second, silent index.
CREATE UNIQUE INDEX opportunity_identity_key
  ON opportunity (website_id, type, page_id, keyword_id, topic_id, competitor_id)
  NULLS NOT DISTINCT;
