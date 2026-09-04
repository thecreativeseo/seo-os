# Prompt 09 — PLAN P4

```text
P0, P1, P2 and P3 are stable.

We are moving to P4 — Content System + Controlled WordPress Execution.

Before coding read:
- CLAUDE.md
- docs/P0_SPEC.md
- docs/P1_SPEC.md
- docs/P2_SPEC.md
- docs/P3_SPEC.md
- docs/P4_SPEC.md
- docs/P4_ACCEPTANCE_CRITERIA.md
- docs/P4_PROTOTYPE_DEMO_BLUEPRINT.md

Inspect the current implementation.
Do not modify code yet.

P4 flow:
Approved P3 Recommendation
→ Content Work Item
→ Brief
→ Draft / Refresh
→ QA
→ Editor Review
→ WordPress Draft
→ Preview
→ Publish Approval
→ Publish
→ Live Verification

Important:
- P4 begins only from human-approved P3 Decisions.
- AI can generate but cannot approve/publish.
- WordPress is the active P4 CMS.
- default publishing permission is conservative, ideally DRAFT_ONLY.
- investor flow may use PUBLISH_WITH_APPROVAL.
- approved versions/revisions remain immutable/history-preserving.
- changing content invalidates stale approvals.
- CMS success does not equal VERIFIED; live page must be checked.
- BLOCKING QA/SEO Rules cannot be silently bypassed.
- no CMS secrets in logs/audit/AI prompts.
- preserve tenant isolation.
- do not activate Similarweb, Screaming Frog, or HubSpot CRM in P4.
- do not implement P5.

Return:
1. P3 repository assessment
2. P4 schema changes
3. P3→P4 handoff
4. ContentWorkItem workflow
5. Brief/versioning design
6. Draft/revision design
7. content-generation architecture
8. QA architecture
9. Brand Fact/SEO Rule guardrails
10. internal-link suggestion scope
11. CMS provider abstraction
12. WordPress auth/connection design
13. publishing policy/modes
14. Execution state machine
15. PublishApproval integrity design
16. live verification design
17. failure/idempotency strategy
18. P4 UI/navigation
19. P4 Command Center
20. Demo/Sandbox execution design
21. security implications
22. approval-integrity tests
23. migration plan
24. milestones
25. files to change
26. exact first milestone
27. decisions requiring approval

Do not code, install CMS SDKs, or create migrations.
Stop and wait for approval.
```
