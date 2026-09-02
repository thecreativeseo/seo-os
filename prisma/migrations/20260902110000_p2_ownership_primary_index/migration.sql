-- One active PRIMARY owning page per keyword, market, language and locale.
--
-- P2_SPEC §12 states the rule; this is where it is actually enforced. Postgres can
-- express "unique WHERE status = ACTIVE AND ownership_type = PRIMARY" as a partial
-- index, which Prisma cannot, and which application code could always be talked
-- out of by a code path nobody remembered to check.
--
-- SECONDARY and EXPERIMENTAL ownerships are deliberately unconstrained: a team may
-- legitimately have several supporting pages for one keyword. RETIRED rows are
-- excluded too, so reassigning an owner does not have to delete its own history.
--
-- Name kept short on purpose. Postgres silently truncates identifiers at 63
-- characters, which in P1 produced a second index nobody asked for and a debugging
-- session nobody enjoyed.
CREATE UNIQUE INDEX keyword_primary_owner_key
  ON keyword_page_ownership (keyword_id, market, language, locale)
  WHERE status = 'ACTIVE' AND ownership_type = 'PRIMARY';
