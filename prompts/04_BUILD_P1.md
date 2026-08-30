# Prompt 04 — BUILD P1

Use only after approving Claude's P1 plan.

```text
Your P1 implementation plan is approved.

Implement P1 according to:

- CLAUDE.md
- docs/P1_SPEC.md
- docs/P1_ACCEPTANCE_CRITERIA.md
- docs/P1_PROTOTYPE_DEMO_BLUEPRINT.md

Preserve all working P0 behavior.

Build in this order:

1. P1 database schema + migrations
2. Page + Query domain
3. SourceSnapshot + SyncRun
4. GSC metric model
5. GA4 landing-page metric model
6. Sitemap model
7. Metrics aggregation service
8. Investor Demo Mode dataset
9. Data Health UI
10. P1 Command Center
11. Page Explorer
12. Page Detail
13. Query Explorer
14. Deterministic Signal engine
15. Signals UI
16. Evidence/source trace
17. Investor-demo polish
18. Security + tenant-isolation tests

For Demo Mode create:

Demo Organization
→ Investor Demo
→ demo.example

Show a clear DEMO DATA indicator anywhere synthetic metrics appear.

Never put synthetic SEO metrics into:

The Creative SEO
→ SEO Team
→ thecreativeseo.com

Create approximately:

- 90 days of demo data
- 20–40 pages
- 100–300 queries
- GSC-like metrics
- GA4-like landing-page metrics
- several realistic Signals

Include:

- one meaningful traffic decline
- one strong winner
- two CTR opportunities
- three striking-distance queries
- one conversion decline

Signals must describe observations only.

Good:
"Clicks decreased 25.8% compared with the previous 28 days."

Bad:
"Clicks decreased because of cannibalization."

Do not implement:

- AI Page Diagnosis
- Semrush
- HubSpot
- Similarweb
- crawler automation
- WordPress publishing
- P2/P3/P4 functionality

If live GSC/GA4 credentials are available after Demo Mode works, implement live connection using the approved connector architecture. Otherwise leave Live Mode clearly documented as not configured.

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
3. Demo Mode / Live Mode behavior.
4. Environment variables.
5. Test results.
6. Known limitations.
7. P1 PASS / FAIL.
8. Recommended P2 handoff.

Do not begin P2.
```
