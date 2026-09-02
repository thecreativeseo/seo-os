-- The signal identity key includes page_id and query_id, both nullable.
--
-- In Postgres, NULL is distinct from NULL for uniqueness purposes, so the default
-- constraint does not prevent duplicates for signals that have neither a page nor a
-- query — DATA_FRESHNESS_RISK would insert a fresh row on every detection run, and
-- the Attention list would grow without bound.
--
-- NULLS NOT DISTINCT (Postgres 15+) makes two NULLs compare equal for this index,
-- which is the behaviour the identity actually needs.
DROP INDEX IF EXISTS "signal_website_id_type_page_id_query_id_current_period_start_key";

CREATE UNIQUE INDEX "signal_website_id_type_page_id_query_id_current_period_start_key"
  ON "signal" ("website_id", "type", "page_id", "query_id", "current_period_start")
  NULLS NOT DISTINCT;
