# Prompt 02 — BUILD P0

Use only after you approve Claude's P0 plan.

```text
Your P0 implementation plan is approved.

Implement P0 according to:

- CLAUDE.md
- docs/P0_SPEC.md
- docs/P0_ACCEPTANCE_CRITERIA.md
- docs/P0_PROTOTYPE_DEMO_BLUEPRINT.md

Build in this order:

1. App shell and visual system
2. PostgreSQL + Prisma
3. Google Sign-In
4. Organization + OrganizationMembership
5. Workspace
6. Website + domain normalization
7. Resumable onboarding
8. Business Goals
9. Versioned Business Context
10. Competitors
11. Brand Facts
12. SEO Rules
13. Technical Context shell
14. Connections framework/UI
15. Audit History
16. Setup Command Center
17. Seed support
18. Tenant/security tests
19. Responsive investor-demo polish

Important:

- do not implement P1
- do not implement live GSC/GA4
- do not implement Semrush
- do not implement WordPress publishing
- do not implement AI agents
- do not fabricate SEO metrics
- do not fabricate business facts for thecreativeseo.com
- Google login and tenant authorization must be real
- approved Business Context versions must be immutable
- Connections may show future availability honestly

After each major milestone run:

- typecheck
- lint
- tests

At the end run:

- migrations
- seed verification
- production build
- tenant/security tests

Then report:

1. What you built.
2. How to run locally.
3. Environment variables.
4. Google OAuth setup.
5. Database setup.
6. Test results.
7. Known limitations.
8. P0 PASS / FAIL.

Do not start P1.
```
