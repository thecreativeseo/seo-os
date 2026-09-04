# SEO OS — P4_ACCEPTANCE_CRITERIA.md

**Phase:** P4 — Content System + Controlled WordPress Execution

Automatic FAIL:

- unauthorized publishing
- cross-tenant CMS execution
- plaintext CMS credentials
- stale approval reused for changed content
- BLOCKING QA/SEO Rule silently bypassed
- provider success represented as VERIFIED without live verification

## P3 → P4 handoff
- [ ] ContentWorkItem requires human-approved P3 Decision.
- [ ] Recommendation and Decision retained.
- [ ] tenant access validated.
- [ ] AI cannot create executable work from unapproved Recommendation.

## Brief
- [ ] generate/create works.
- [ ] Business Context/Goal/Brand Facts/SEO Rules available.
- [ ] approved brief immutable.
- [ ] editing approved brief creates new version.
- [ ] tenant isolation.

## Draft/revisions
- [ ] draft created from approved brief.
- [ ] revisions preserved.
- [ ] prior revision retrievable.
- [ ] AI/human provenance retained.
- [ ] unsupported facts not invented.
- [ ] tenant isolation.

## QA
- [ ] Brand Fact validation.
- [ ] SEO Rule validation.
- [ ] on-page SEO.
- [ ] intent alignment.
- [ ] Answer Readiness.
- [ ] claim safety.
- [ ] internal-link suggestions where applicable.
- [ ] PASS / PASS_WITH_WARNINGS / FAIL.
- [ ] blocking failure prevents CMS approval.

## WordPress Connection
- [ ] connection can be configured/tested.
- [ ] credentials referenced/encrypted.
- [ ] no secret returned in normal APIs.
- [ ] disable/disconnect works.
- [ ] tenant isolation.

## Publishing policy
- [ ] server-side permission mode.
- [ ] conservative default.
- [ ] DRAFT_ONLY cannot publish.
- [ ] PUBLISH_WITH_APPROVAL requires valid approval.
- [ ] client cannot override policy.

## CMS draft
- [ ] approved revision required.
- [ ] QA rechecked.
- [ ] WordPress draft created.
- [ ] external post ID retained.
- [ ] preview retained.
- [ ] Execution created.
- [ ] draft creation does not mark Published.

## Publish approval
- [ ] exact Execution/revision linked.
- [ ] authorized reviewer.
- [ ] approve/reject works.
- [ ] mutation invalidates stale approval.
- [ ] approval cannot be reused for another revision/execution.
- [ ] client cannot forge approval.

## Publish execution
- [ ] tenant access rechecked.
- [ ] Connection rechecked.
- [ ] policy rechecked.
- [ ] QA rechecked.
- [ ] revision/hash rechecked.
- [ ] approval rechecked.
- [ ] BLOCKING rules rechecked.
- [ ] errors redacted.

## Verification
- [ ] CMS success alone is not VERIFIED.
- [ ] live URL checked.
- [ ] status/title/meta/content checked where relevant.
- [ ] verification issue surfaced.
- [ ] verified timestamp retained.

## Demo Mode
- [ ] uses Demo Organization / Investor Demo / demo.example.
- [ ] `DEMO EXECUTION` visible when simulated.
- [ ] QA-blocked story.
- [ ] publish-approval story.
- [ ] verified-publish story.
- [ ] verification-failure story.
- [ ] no synthetic execution against thecreativeseo.com.

## Security attack tests
Tenant A cannot access/execute Tenant B:
- [ ] ContentWorkItem
- [ ] ContentBrief
- [ ] ContentDraft
- [ ] ContentRevision
- [ ] ContentQAResult
- [ ] InternalLinkSuggestion
- [ ] WordPress Connection
- [ ] PublishingPolicy
- [ ] Execution
- [ ] ExecutionStep
- [ ] PublishApproval
- [ ] ExecutionVerification

Any success = **P4 FAIL**.

## Approval integrity tests
- [ ] approval for revision A cannot publish B.
- [ ] approval for execution X cannot authorize Y.
- [ ] expired/cancelled approval rejected.
- [ ] BLOCKING rule prevents publish.
- [ ] DRAFT_ONLY prevents publish.

## Final gate

```text
typecheck = PASS
lint = PASS
tests = PASS
migrations = PASS
production build = PASS
tenant security tests = PASS
approval integrity tests = PASS
CMS execution tests = PASS
```

Final report:

```text
P4 STATUS:
PASS / FAIL / PASS WITH NON-BLOCKING TECHNICAL DEBT
```
