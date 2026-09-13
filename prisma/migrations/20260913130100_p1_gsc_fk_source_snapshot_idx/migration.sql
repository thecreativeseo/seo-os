-- Search Console raw rows by their source snapshot (P1 GSC cascade indexes): the foreign key a snapshot delete has to null out, which scanned 1.5 million rows.
-- One statement, on its own: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block, and the migration runner puts a multi-statement script in
-- one. Additive only; the table, its rows and its other indexes are untouched.

CREATE INDEX CONCURRENTLY "gsc_metric_daily_source_snapshot_id_idx" ON "gsc_metric_daily"("source_snapshot_id");
