-- Monthly rollups by query (P1 GSC cascade indexes): the key leads with website, so the cascade from a query delete walked the whole key.
-- One statement, on its own: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and the migration runner puts a multi-statement script in
-- one. Additive only; the table, its rows and its other indexes are untouched.

CREATE INDEX CONCURRENTLY "gsc_query_page_monthly_query_id_idx" ON "gsc_query_page_monthly"("query_id");
