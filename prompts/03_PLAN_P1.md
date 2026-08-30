# Prompt 03 — PLAN P1

Use after P0 is stable and demoable.

```text
P0 is stable enough for the investor prototype.

We are moving to:

P1 — First-Party Search & Analytics Intelligence.

Before writing code:

1. Read CLAUDE.md.
2. Read docs/P0_SPEC.md.
3. Read docs/P1_SPEC.md.
4. Read docs/P1_ACCEPTANCE_CRITERIA.md.
5. Read docs/P1_PROTOTYPE_DEMO_BLUEPRINT.md.
6. Inspect the current implementation.

Do not modify code yet.

P1 must demonstrate:

Business Context
→ First-party evidence
→ Pages
→ Queries
→ Performance comparisons
→ Deterministic Signals
→ Evidence

Target integrations:

Google Search Console
Google Analytics 4
Sitemap

Support two modes:

LIVE MODE
- authorized real GSC / GA4 data

DEMO MODE
- clearly labeled synthetic data
- separate Demo Organization / Investor Demo Workspace
- never mixed with thecreativeseo.com

P1 should add:

- Page
- Query
- GSC daily metrics
- GA4 landing-page metrics
- Sitemap
- SourceSnapshot
- SyncRun
- Signal
- SignalEvidence
- Data Health
- Page Explorer
- Page Detail
- Query Explorer
- P1 Command Center

Investor-demo signals:

- TRAFFIC_DECLINE
- IMPRESSION_GROWTH
- CTR_OPPORTUNITY
- STRIKING_DISTANCE
- PAGE_WINNER
- PAGE_LOSER

Rules:

- Signals are observations, not diagnoses.
- Google login does not equal GSC/GA4 authorization.
- CTR aggregation = total clicks / total impressions.
- Do not use undocumented naive AVG(position).
- Preserve source/date provenance.
- Preserve P0 tenant isolation.
- Do not implement P2/P3/P4.

Return:

1. Current P0 repository assessment.
2. P1 architecture.
3. Schema changes.
4. GSC connector design.
5. GA4 connector design.
6. Sitemap design.
7. Source/provenance design.
8. Sync/idempotency design.
9. Metric aggregation rules.
10. Signal engine design.
11. Command Center design.
12. Page Explorer design.
13. Page Detail design.
14. Query Explorer design.
15. Demo Mode design.
16. Security implications.
17. Migration plan.
18. Implementation milestones.
19. Files to change.
20. Exact first implementation step.
21. Decisions requiring approval.

Do not write code.
Stop and wait for approval.
```
