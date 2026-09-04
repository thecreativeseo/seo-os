# Prompt 10 — BUILD P4

```text
Your P4 implementation plan is approved.

Implement according to:
- CLAUDE.md
- docs/P4_SPEC.md
- docs/P4_ACCEPTANCE_CRITERIA.md
- docs/P4_PROTOTYPE_DEMO_BLUEPRINT.md

Preserve P0/P1/P2/P3.

Build one milestone at a time:
1. P4 schema/migrations
2. approved P3 Decision → ContentWorkItem
3. ContentBrief versioning
4. ContentDraft + Revision history
5. content generation using approved context
6. QA framework
7. Brand Fact + SEO Rule validation
8. on-page/intent/answer-readiness QA
9. internal-link suggestions
10. Content Work Queue
11. editor/review UI
12. CMS provider abstraction
13. WordPress provider
14. PublishingPolicy/modes
15. WordPress draft creation
16. preview
17. PublishApproval
18. publish execution
19. live verification
20. P4 Command Center
21. Demo/Sandbox fixture
22. audit events
23. tenant tests
24. approval-integrity tests
25. investor polish

Rules:
- AI cannot approve its own Recommendation or content revision.
- AI cannot authorize publish.
- DRAFT_ONLY cannot publish.
- PUBLISH_WITH_APPROVAL requires exact server-validated approval.
- approval for revision A cannot publish changed revision B.
- BLOCKING QA/SEO Rule cannot be silently bypassed.
- WordPress API success is not VERIFIED until live checks pass.
- do not expose CMS credentials.
- do not activate Similarweb, Screaming Frog, HubSpot CRM, or P5.

Demo Mode:
Demo Organization → Investor Demo → demo.example.
If no safe WordPress sandbox exists, use a clearly labeled `DEMO EXECUTION` mock provider.
Never simulate publishing against thecreativeseo.com.

Create demo stories:
- new content
- content refresh
- title/meta update
- internal-link update
- QA-blocked claim
- pending publish approval
- successful verified publish
- verification mismatch

At completion run:
- migrations
- typecheck
- lint
- unit/integration tests
- CMS provider tests
- approval-integrity tests
- tenant/security tests
- production build

Report:
1. what was built
2. investor demo instructions
3. WordPress/Sandbox/Demo behavior
4. permission behavior
5. approval-integrity behavior
6. verification behavior
7. environment variables
8. tests
9. limitations
10. P4 PASS / FAIL
11. P5 handoff

Do not begin P5.
```
