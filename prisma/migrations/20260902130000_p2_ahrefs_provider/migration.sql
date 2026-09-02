-- Ahrefs as a second market-data provider.
--
-- Either Semrush or Ahrefs can answer P2's questions, and a workspace may hold a
-- subscription to one, the other, or both. What must never happen is the two being
-- treated as interchangeable: their volumes come from different models, and their
-- difficulty scores are both labelled 0-100 while being computed completely
-- differently. An Ahrefs KD of 40 and a Semrush KD of 40 are not the same claim.
--
-- Every snapshot already carries source_provider. Adding the value here is what
-- lets that column tell the truth for an Ahrefs import instead of mislabelling it.
ALTER TYPE "ConnectionProvider" ADD VALUE IF NOT EXISTS 'AHREFS';

-- The shape of a file and the vendor who wrote it are separate facts, but a single
-- source enum keeps the two together in one column that is easy to read and hard
-- to leave inconsistent.
ALTER TYPE "ImportSource" ADD VALUE IF NOT EXISTS 'AHREFS_POSITIONS';
ALTER TYPE "ImportSource" ADD VALUE IF NOT EXISTS 'AHREFS_KEYWORD_OVERVIEW';
ALTER TYPE "ImportSource" ADD VALUE IF NOT EXISTS 'AHREFS_COMPETITORS';
