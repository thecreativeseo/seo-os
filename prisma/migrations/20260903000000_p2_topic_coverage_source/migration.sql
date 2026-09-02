-- Whether a topic's coverage status was computed or set by a person.
--
-- Coverage is derived from the keyword and page mapping, but a person who knows
-- the topic can overrule it. P2_SPEC §14 warns against pretending topic
-- judgements are scientifically precise, and the honest way to honour that is to
-- let the screen say which of the two a reader is looking at rather than
-- presenting both as the same kind of fact.
--
-- Defaults to SYSTEM_DERIVED: every existing row was computed, since nothing has
-- been able to override one until now.
ALTER TABLE "topic"
  ADD COLUMN "coverage_source" "Provenance" NOT NULL DEFAULT 'SYSTEM_DERIVED';
