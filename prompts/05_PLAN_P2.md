# Prompt 05 — PLAN P2

Use after P1 is stable and demoable.

```text
P0 and P1 are stable.

We are moving to:

P2 — Market, Keyword & Opportunity Intelligence.

Before writing code:

1. Read CLAUDE.md.
2. Read docs/P0_SPEC.md.
3. Read docs/P1_SPEC.md.
4. Read docs/P2_SPEC.md.
5. Read docs/P2_ACCEPTANCE_CRITERIA.md.
6. Read docs/P2_PROTOTYPE_DEMO_BLUEPRINT.md.
7. Inspect the current implementation.

Do not modify code yet.

P2 product question:

Where should the SEO team focus next?

P2 must connect:

Business Goals
+
P1 Pages / Queries / Signals
+
Semrush or equivalent market keyword evidence
+
Keywords
+
Topics
+
Competitors
+
Keyword → Page ownership

to:

Opportunity
→ transparent scoring
→ Opportunity Queue

P2 should add:

- Semrush Import/Connection architecture
- Keyword
- KeywordMetricsSnapshot
- RankingSnapshot
- KeywordPageOwnership
- Topic
- TopicKeyword
- TopicPage
- CompetitorKeywordSnapshot
- Import
- Opportunity
- OpportunityEvidence
- Opportunity scoring
- Opportunity Queue
- Keyword Explorer
- Topic Explorer
- Competitor Search Intelligence
- P2 Command Center

Investor Demo Mode:

If live Semrush access is unavailable, use synthetic Semrush-like data only in the existing Demo Organization / Investor Demo / demo.example environment.

Never insert synthetic market metrics into:
The Creative SEO → SEO Team → thecreativeseo.com

Important rules:

- P2 prioritizes; it does not diagnose root cause.
- ownership conflicts are candidates, not confirmed cannibalization.
- third-party Semrush data must be labeled separately from GSC/GA4 first-party data.
- preserve historical ranking/keyword metrics.
- Opportunity scoring must be transparent and versioned.
- do not fabricate traffic or revenue forecasts.
- preserve tenant isolation.

Return:

1. Current P1 repository assessment.
2. P2 schema changes.
3. Semrush connector/import architecture.
4. import preview/validation design.
5. Keyword normalization design.
6. RankingSnapshot design.
7. Keyword ownership design.
8. Topic/cluster design.
9. competitor intelligence design.
10. Opportunity rules.
11. Opportunity scoring model.
12. Opportunity Queue design.
13. Keyword Explorer / Detail design.
14. Topic Explorer / Detail design.
15. P2 Command Center changes.
16. Demo Mode design.
17. security implications.
18. migration plan.
19. implementation milestones.
20. files to change.
21. exact first implementation step.
22. decisions requiring approval.

Do not write code.
Stop and wait for approval.
```
