# CLAUDE.md — SEO OS Engineering Rules

**Project:** SEO OS  
**Current build target:** Investor prototype, P0 then P1  
**Primary specs:** `docs/P0_SPEC.md`, `docs/P1_SPEC.md`

## Required workflow

Before any implementation milestone:

1. Read this file.
2. Read the applicable phase spec.
3. Read the applicable acceptance criteria.
4. Read the applicable prototype blueprint.
5. Inspect the current repository.
6. Work only on the requested milestone.
7. Run validation/tests before declaring work complete.
8. Do not start the next phase automatically.

## Product architecture

```text
Organization
  ↓
Workspace
  ↓
Website
```

The Website is the primary SEO operating entity.

Long-term lifecycle:

```text
Onboard
→ Connect
→ Observe
→ Detect
→ Diagnose
→ Decide
→ Create
→ Execute
→ Verify
→ Measure
→ Learn
```

## Authentication

P0 requires **Continue with Google** using OAuth 2.0 / OpenID Connect through a maintained auth provider.

Google authentication proves identity.

SEO OS authorization is controlled by `OrganizationMembership`.

Never grant tenant access solely because a user's Google email domain matches an Organization.

Repeat Google login must resolve to the same internal SEO OS user.

Do not log OAuth tokens or include them in audit snapshots.

## Multi-tenancy

- Authorization must be enforced server-side.
- Never trust client-supplied `organization_id`, `workspace_id`, or `website_id`.
- UI hiding is not security.
- Cross-tenant access is a release-blocking defect.
- Use reusable authorization helpers/services.
- Test IDOR attempts explicitly.

## Data truth

- PostgreSQL is the source of truth.
- Unknown values remain `NULL` or an explicit unknown state.
- Never fabricate business facts, SEO metrics, rankings, conversions, technical findings, or competitor evidence.
- Do not fabricate source URLs.
- Synthetic investor demo data must be isolated in a clearly labeled Demo Workspace.
- Never insert synthetic SEO metrics into the real `thecreativeseo.com` workspace.

Provenance vocabulary:

```text
USER_PROVIDED
SYSTEM_DERIVED
INFERRED
UNKNOWN
```

`INFERRED` never becomes canonical without human confirmation.

## Business Context

Approved Business Context versions are immutable.

Editing approved context creates a new draft version.

Historical versions remain accessible.

## Audit

Audit important state changes.

Never include:

- OAuth tokens
- API keys
- passwords
- application passwords
- private keys
- secret-manager values

## Connections

Provider-specific logic belongs behind connector/provider abstractions.

Initial provider registry:

```text
GOOGLE_SEARCH_CONSOLE
GOOGLE_ANALYTICS
HUBSPOT
SEMRUSH
SIMILARWEB
SCREAMING_FROG
WORDPRESS
```

P0 shows connection architecture only.

P1 activates GSC, GA4, and sitemap intelligence.

Do not fake a successful connection.

## Metric integrity

For aggregated GSC metrics:

```text
CTR = SUM(clicks) / SUM(impressions)
```

Do not calculate aggregate CTR as `AVG(row_ctr)`.

Do not use undocumented naive `AVG(position)` for aggregated Search Console position.

## Signals vs diagnosis

P1 signals are observations.

Good:

> Clicks decreased 25.8% versus the previous 28 days.

Bad:

> Clicks decreased because of cannibalization.

Causal diagnosis belongs to P3.

## Secrets

Credentials must be stored in an encrypted secret-management system.

Application records store only a credential reference.

Never commit secrets.

Provide `.env.example` with placeholders.

## Development

Recommended stack when starting from scratch:

```text
Next.js App Router
React
TypeScript strict mode
PostgreSQL
Prisma
Zod
Tailwind CSS
shadcn/ui or equivalent
Managed auth with Google OAuth/OIDC
```

If a suitable stack already exists, preserve it unless there is a strong reason to change it.

## Testing

Before each major milestone:

```text
typecheck
lint
tests
```

Before phase release:

```text
migrations
seed verification
production build
tenant-isolation/security tests
```

## Stop conditions

Stop and ask before proceeding if:

- a request conflicts with a phase spec
- a request weakens tenant isolation
- a task requires guessing missing facts
- approved context would become mutable
- credentials would need insecure storage
- P0 work requires P1 features
- P1 work requires P2/P3/P4 features
- auth would grant tenant access based only on email domain

## Completion report

At the end of each phase report:

1. what was built
2. files created/modified
3. migrations
4. environment variables
5. tests
6. known limitations
7. security findings
8. phase PASS / FAIL
9. what remains manual
10. recommended next step

Do not start the next phase automatically.
