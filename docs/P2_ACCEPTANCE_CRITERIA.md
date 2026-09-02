# SEO OS — P2_ACCEPTANCE_CRITERIA.md

**Phase:** P2 — Market, Keyword & Opportunity Intelligence  
**Release rule:** Tenant isolation, import safety, provenance, and scoring transparency are release blocking.

## Source / Import

- [ ] Semrush live connector or Import Mode available.
- [ ] import source identified.
- [ ] upload creates Import record.
- [ ] checksum retained.
- [ ] parse/validate occurs before commit.
- [ ] preview shown before commit.
- [ ] invalid rows surfaced safely.
- [ ] committed data maps only to authorized Website.
- [ ] retry does not duplicate historical snapshots.
- [ ] raw/source snapshot retained.
- [ ] no secrets in import/audit.

## Keyword

- [ ] keyword normalized consistently.
- [ ] locale/language/market retained.
- [ ] unique key prevents duplicates within same market identity.
- [ ] intent supports UNKNOWN.
- [ ] provenance retained where applicable.
- [ ] tenant isolation passes.

## Keyword Metrics Snapshot

- [ ] captured_at retained.
- [ ] search volume retained if available.
- [ ] KD retained if available.
- [ ] unavailable metrics remain null.
- [ ] historical snapshots not overwritten.
- [ ] provider/source retained.

## Ranking Snapshot

- [ ] keyword linked.
- [ ] Page mapped where possible.
- [ ] raw ranking URL preserved where necessary.
- [ ] position retained.
- [ ] previous position retained when supplied.
- [ ] captured_at retained.
- [ ] source/provider retained.
- [ ] history preserved.
- [ ] tenant isolation passes.

## Keyword Ownership

- [ ] user can assign intended owning Page.
- [ ] one active PRIMARY owner per keyword/market/language/locale by default.
- [ ] ownership history auditable.
- [ ] owner can be retired/reassigned.
- [ ] no-owning-page candidate detectable.
- [ ] ranking URL divergence detectable.
- [ ] ranking URL switch candidate detectable.
- [ ] multiple ranking pages candidate detectable.
- [ ] candidate language does not claim confirmed cannibalization.

## Topic

- [ ] Topic can be created.
- [ ] parent/child optional.
- [ ] Keyword mapping works.
- [ ] Page mapping works.
- [ ] pillar Page optional.
- [ ] commercial destination optional.
- [ ] coverage status controlled.
- [ ] authority status controlled.
- [ ] tenant isolation passes.

## Competitor Intelligence

- [ ] uses P0 Competitor entities.
- [ ] competitor keyword/ranking evidence retained.
- [ ] provider/source clearly labeled third-party.
- [ ] competitor gap candidate works.
- [ ] no third-party estimate represented as first-party truth.
- [ ] tenant isolation passes.

## Opportunity

- [ ] Opportunity created from deterministic rule.
- [ ] type valid.
- [ ] Website retained.
- [ ] related Page/Keyword/Topic optional but valid.
- [ ] Business Goal linkage supported.
- [ ] evidence retained.
- [ ] confidence retained.
- [ ] effort retained.
- [ ] expected effect is descriptive unless explicitly modeled.
- [ ] no fabricated traffic/revenue forecast.
- [ ] status transitions work.
- [ ] owner validation works.
- [ ] tenant isolation passes.

## Scoring

- [ ] scoring inputs inspectable.
- [ ] scoring model version retained.
- [ ] weights/config documented.
- [ ] score described as prioritization heuristic.
- [ ] no guaranteed outcome wording.
- [ ] score can be reproduced from stored inputs.
- [ ] scoring never mixes entities across tenants.

Hidden/untraceable priority scoring = **P2 FAIL**.

## Opportunity Queue

- [ ] priority.
- [ ] type.
- [ ] Business Goal.
- [ ] Page.
- [ ] Keyword/Topic.
- [ ] evidence summary.
- [ ] effort.
- [ ] confidence.
- [ ] owner.
- [ ] status.
- [ ] filters.
- [ ] sorting.
- [ ] tenant-safe pagination.

## Keyword Explorer

- [ ] keyword.
- [ ] intent.
- [ ] volume.
- [ ] KD.
- [ ] current position.
- [ ] previous position.
- [ ] intended owner.
- [ ] actual ranking Page.
- [ ] topic.
- [ ] business relevance.
- [ ] opportunity indicator.
- [ ] filters/search.
- [ ] tenant isolation.

## Topic Explorer

- [ ] priority.
- [ ] customer-language context.
- [ ] pillar Page.
- [ ] commercial destination.
- [ ] keyword count.
- [ ] Page count.
- [ ] coverage.
- [ ] open opportunities.
- [ ] Topic Detail works.
- [ ] tenant isolation.

## P2 Command Center

- [ ] P1 freshness still visible.
- [ ] Top Opportunities visible.
- [ ] keyword opportunities visible.
- [ ] topic gaps visible.
- [ ] ownership conflicts visible.
- [ ] competitor gaps visible.
- [ ] Next Best Step links to Opportunity.
- [ ] no AI diagnosis.
- [ ] no fake forecast.

## Demo Mode

If live Semrush unavailable:

- [ ] dedicated Demo Organization.
- [ ] dedicated Demo Workspace.
- [ ] dedicated demo Website.
- [ ] visible DEMO DATA indicator.
- [ ] 50–100 Keywords.
- [ ] 5–10 Topics.
- [ ] 3–5 Competitors.
- [ ] RankingSnapshots.
- [ ] ownership conflicts.
- [ ] 8–15 Opportunities.
- [ ] no synthetic market data in `thecreativeseo.com`.
- [ ] demo seed idempotent.

## Security Attack Test

Tenant A cannot access Tenant B:

- [ ] Keyword
- [ ] KeywordMetricsSnapshot
- [ ] RankingSnapshot
- [ ] KeywordPageOwnership
- [ ] Topic
- [ ] TopicKeyword
- [ ] TopicPage
- [ ] CompetitorKeywordSnapshot
- [ ] Opportunity
- [ ] OpportunityEvidence
- [ ] Import

Any success = **P2 FAIL**.

## Build Quality

```text
typecheck = PASS
lint = PASS
tests = PASS
migrations = PASS
production build = PASS
security tests = PASS
```

Final report:

```text
P2 STATUS:
PASS / FAIL / PASS WITH NON-BLOCKING TECHNICAL DEBT
```
