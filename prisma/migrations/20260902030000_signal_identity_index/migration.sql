-- Consolidates signal identity onto one index.
--
-- The previous migration's DROP did not match: Postgres truncates index names to
-- 63 characters, so the generated name ended "..._period_star_key" rather than
-- "..._period_start_key", and a second index was created alongside the first.
--
-- Both are removed here in favour of one explicitly named index that uses
-- NULLS NOT DISTINCT, so a signal with no page and no query has a stable identity
-- instead of inserting a duplicate on every run.
DROP INDEX IF EXISTS "signal_website_id_type_page_id_query_id_current_period_star_key";
DROP INDEX IF EXISTS "signal_website_id_type_page_id_query_id_current_period_start_ke";

CREATE UNIQUE INDEX IF NOT EXISTS "signal_identity_key"
  ON "signal" ("website_id", "type", "page_id", "query_id", "current_period_start")
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS "signal_website_id_type_current_period_start_idx"
  ON "signal" ("website_id", "type", "current_period_start");
