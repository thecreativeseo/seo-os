# SEO OS — P0_ACCEPTANCE_CRITERIA.md

**Release rule:** P0 is PASS only when all release-blocking criteria pass.

## Authentication

- [ ] `Continue with Google` is available.
- [ ] Google authentication creates/resolves one internal user.
- [ ] Repeat login does not duplicate the user.
- [ ] Matching Google email domain alone does not grant tenant access.
- [ ] Unauthenticated users cannot access protected routes.
- [ ] Sign out removes protected access.
- [ ] OAuth errors fail safely.
- [ ] Tokens do not appear in logs/audit.

## Tenancy

- [ ] Organization membership is unique per user/org.
- [ ] Workspace belongs to correct Organization.
- [ ] Website belongs to correct Workspace.
- [ ] Tenant A cannot access Tenant B Organization.
- [ ] Tenant A cannot access Tenant B Workspace.
- [ ] Tenant A cannot access Tenant B Website.
- [ ] IDOR attempts fail server-side.

Any cross-tenant access = **P0 FAIL**.

## Website/domain

- [ ] `https://www.Example.com/` → `example.com`
- [ ] `www.example.com` → `example.com`
- [ ] `example.com/` → `example.com`
- [ ] meaningful subdomains remain distinct
- [ ] duplicate normalized domain in same Workspace fails safely

## Onboarding

- [ ] step order matches spec
- [ ] website/domain is first required website input
- [ ] progress persists server-side
- [ ] browser refresh does not lose committed state
- [ ] user can leave and resume
- [ ] onboarding is tenant-safe
- [ ] Review occurs before completion
- [ ] missing facts stay null/unknown

## Business Goals

- [ ] create/edit/retire works
- [ ] goal belongs to Website
- [ ] owner is validated tenant member
- [ ] missing baseline stays null
- [ ] invalid status rejected
- [ ] tenant isolation passes

## Business Context

- [ ] onboarding creates/prepares initial draft
- [ ] authorized approver can approve
- [ ] canonical pointer updates
- [ ] approved version is immutable
- [ ] editing approved context creates a new draft
- [ ] prior version remains retrievable
- [ ] unknown fields stay null
- [ ] tenant isolation passes

Approved context mutation = **P0 FAIL**.

## Brand Facts

- [ ] proposed fact can be created
- [ ] approve/reject works
- [ ] no invented source URL
- [ ] only approved facts canonical
- [ ] tenant isolation passes

## Competitors

- [ ] add/edit/archive works
- [ ] user-provided provenance retained
- [ ] UNKNOWN type allowed
- [ ] no auto-classification in P0
- [ ] tenant isolation passes

## SEO Rules

- [ ] create/edit/deactivate works
- [ ] controlled category/severity
- [ ] no invented business-specific compliance rules
- [ ] tenant isolation passes

## Technical Context

- [ ] shell fields persist
- [ ] no fake technical-health claims

## Connections

- [ ] provider registry displays GSC, GA4, HubSpot, Semrush, Similarweb, Screaming Frog, WordPress
- [ ] availability is honest
- [ ] all can remain `NOT_CONNECTED`
- [ ] credentials are references only
- [ ] no plaintext secrets
- [ ] tenant isolation passes

Plaintext credentials = **P0 FAIL**.

## Audit

- [ ] important mutations create audit events
- [ ] actor/time recorded
- [ ] before/after captured where appropriate
- [ ] secrets redacted
- [ ] tenant isolation passes

Secret in audit = **P0 FAIL**.

## Command Center

- [ ] setup readiness shown
- [ ] no fake SEO metrics
- [ ] no fake SEO Score
- [ ] deterministic Next Best Step works

## Build quality

```text
typecheck = PASS
lint = PASS
tests = PASS
migrations = PASS
seed verification = PASS
production build = PASS
tenant security tests = PASS
```
