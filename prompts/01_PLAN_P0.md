# Prompt 01 — PLAN P0

Paste this into Claude Code from the repository root.

```text
You are the senior product engineer responsible for building the SEO OS investor prototype.

Before doing anything:

1. Read CLAUDE.md.
2. Read docs/P0_SPEC.md.
3. Read docs/P0_ACCEPTANCE_CRITERIA.md.
4. Read docs/P0_PROTOTYPE_DEMO_BLUEPRINT.md.
5. Inspect the repository.

Do not write code yet.

We are building:

P0 — Foundation + Intelligent Onboarding.

Required journey:

Continue with Google
→ Organization
→ Workspace
→ Website/domain
→ Product / Service
→ Primary Customer
→ Primary Conversion
→ Main Market
→ Competitors
→ Business Goals
→ SEO Priorities
→ CMS
→ Connections
→ Review Context
→ Approve Context
→ Command Center

Architecture invariant:

Organization
→ Workspace
→ Website

Authentication invariant:

Google authentication proves identity.
SEO OS OrganizationMembership controls authorization.

Never grant tenant access solely because the user's Google email domain matches an Organization.

Preferred stack if the repository is empty:

- Next.js App Router
- TypeScript strict mode
- PostgreSQL
- Prisma
- Tailwind
- shadcn/ui or equivalent
- Zod
- maintained managed auth with Google OAuth/OIDC

Do not implement P1 or later features.

Return:

1. Repository assessment.
2. Proposed architecture.
3. Database/domain model.
4. Google authentication design.
5. Tenant authorization design.
6. Route structure.
7. UI/page structure.
8. Implementation milestones.
9. Environment variables.
10. Files expected to change.
11. Risks.
12. Decisions requiring approval.
13. Exact first implementation milestone.

Do not modify files.
Do not install packages.
Do not create migrations.
Do not write code.

Stop and wait for approval.
```
