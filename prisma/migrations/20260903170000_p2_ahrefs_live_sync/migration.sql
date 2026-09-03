-- Ahrefs live API sync (P2_SPEC §7 LIVE API MODE, second provider).
--
-- The mirror of the Semrush sync type, and needed as its own value rather than a
-- shared "market data" one: a SyncRun says which provider was asked and when, and
-- collapsing two vendors into one sync type would make "did the Ahrefs pull run
-- today" unanswerable from the run history.
ALTER TYPE "SyncType" ADD VALUE IF NOT EXISTS 'AHREFS_ORGANIC';
