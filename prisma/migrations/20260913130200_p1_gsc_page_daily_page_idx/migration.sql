-- Page-day rollups by page (P1 GSC cascade indexes): the key leads with website, so the cascade from a page delete walked the whole key.
-- One statement, on its own: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and the migration runner puts a multi-statement script in
-- one. Additive only; the table, its rows and its other indexes are untouched.

CREATE INDEX CONCURRENTLY "gsc_page_daily_page_id_idx" ON "gsc_page_daily"("page_id");
