# Prompt 06 — BUILD P2

Use only after approving Claude's P2 plan.

```text
Your P2 implementation plan is approved.

Implement P2 according to:

- CLAUDE.md
- docs/P2_SPEC.md
- docs/P2_ACCEPTANCE_CRITERIA.md
- docs/P2_PROTOTYPE_DEMO_BLUEPRINT.md

Preserve all working P0 and P1 behavior.

Build in this order:

1. P2 schema + migrations
2. Import model / validation pipeline
3. Keyword
4. KeywordMetricsSnapshot
5. RankingSnapshot
6. Keyword → Page ownership
7. ownership conflict candidates
8. Topic + Keyword/Page mapping
9. competitor search intelligence
10. deterministic Opportunity rules
11. transparent versioned scoring
12. Opportunity + OpportunityEvidence
13. Opportunity Queue
14. Keyword Explorer + Detail
15. Topic Explorer + Detail
16. P2 Command Center
17. Demo Mode P2 fixture
18. Semrush Import Mode
19. audit events
20. security/tenant tests
21. investor polish

Demo Mode must use:

Demo Organization
→ Investor Demo
→ demo.example

Show DEMO DATA anywhere synthetic market metrics appear.

Never place synthetic P2 metrics into:
The Creative SEO
→ SEO Team
→ thecreativeseo.com

Create approximately:

- 50–100 Keywords
- 5–10 Topics
- 3–5 Competitors
- multiple RankingSnapshots
- several ownership conflicts
- 8–15 Opportunities

Include demo stories:

- commercial keyword near page one
- intended owner differs from ranking Page
- topic gap
- competitor gap
- no-owning-page keyword
- high-impression CTR opportunity carried from P1
- strong Business Goal alignment

Important:

Good:
"The intended owner differs from the currently ranking Page."

Bad:
"Cannibalization is confirmed."

Good:
"High-priority opportunity based on business relevance, intent, current visibility, demand, confidence and effort."

Bad:
"This will generate 1,000 extra visits."

Do not implement:

- AI Page Diagnosis
- AI Recommendations
- WordPress publishing
- P3/P4
- autonomous execution

Run:

- migrations
- typecheck
- lint
- tests
- production build
- tenant/security tests

At completion report:

1. What you built.
2. Investor demo instructions.
3. Demo Mode / live Semrush behavior.
4. Environment variables.
5. import instructions.
6. scoring model.
7. test results.
8. known limitations.
9. P2 PASS / FAIL.
10. recommended P3 handoff.

Do not begin P3.
```
