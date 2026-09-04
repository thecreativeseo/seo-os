# SEO OS — P4_SPEC.md

**Version:** 1.0  
**Phase:** P4 — Content System + Controlled WordPress Execution  
**Depends on:** P0 + P1 + P2 + P3  
**Primary product question:** Can SEO OS turn an approved recommendation into governed, reviewable work and safely execute it in the CMS?  
**Last updated:** 2026-09-05

## 1. Objective

P4 is the controlled execution layer.

```text
P0 Context
→ P1 Evidence
→ P2 Opportunity
→ P3 Diagnosis + Recommendation
→ P4 Controlled Execution
```

P4 turns an approved P3 recommendation into:

```text
Approved Recommendation
→ Content Work Item
→ Brief
→ Draft / Refresh
→ QA
→ Human Review
→ WordPress Draft
→ Preview
→ Publish Approval
→ Publish
→ Live Verification
→ Measurement Handoff
```

P4 is agentic, but it is **not autonomous publishing**.

## 2. Core execution rule

```text
PROPOSE
→ GENERATE
→ VALIDATE
→ PREVIEW
→ APPROVE
→ EXECUTE
→ VERIFY
```

Never:

```text
AI decides
→ AI publishes
```

## 3. P4 scope

P4 includes:

- ContentWorkItem
- ContentBrief + immutable versions
- ContentDraft
- ContentRevision history
- ContentQAResult
- Brand Fact / SEO Rule validation
- on-page SEO QA
- intent alignment QA
- Answer Readiness checks
- internal-link suggestions for content work
- WordPress connection activation
- CMS provider abstraction
- PublishingPolicy
- conservative publishing permission modes
- WordPress draft creation/update
- preview flow
- explicit publish approval
- controlled publish execution
- Execution / ExecutionStep
- live ExecutionVerification
- publishing audit trail
- Content Work Queue
- Draft/Review UI
- P4 Command Center
- investor Demo/Sandbox execution mode
- tenant/security/approval-integrity tests

## 4. Non-goals

Do not activate in P4:

- HubSpot CRM / revenue intelligence
- Similarweb
- Screaming Frog crawl automation
- autonomous technical fixes
- full technical execution
- experiment/learning engine
- AI visibility tracking
- autonomous campaign execution
- unrestricted CMS permissions

WordPress is the active P4 execution target. Other CMS providers can reuse the abstraction later.

## 5. P3 → P4 handoff

P4 work may start only from a human-approved P3 Recommendation/Decision.

```text
Recommendation
→ Decision = APPROVED or MODIFIED
→ ContentWorkItem
```

AI cannot create executable work from an unapproved Recommendation.

## 6. ContentWorkItem

```text
id
website_id
recommendation_id
decision_id
type
status
priority
page_id_optional
keyword_id_optional
topic_id_optional
title
objective
owner_user_id
created_at
updated_at
completed_at
archived_at
```

Types:

```text
NEW_CONTENT
CONTENT_REFRESH
TITLE_META_UPDATE
INTENT_REALIGNMENT
KEYWORD_OWNERSHIP_FIX
INTERNAL_LINK_UPDATE
PAGE_CONSOLIDATION_PREP
OTHER
```

Statuses:

```text
QUEUED
BRIEFING
DRAFTING
QA
AWAITING_EDITOR_REVIEW
APPROVED_FOR_CMS
CMS_DRAFT_CREATED
AWAITING_PUBLISH_APPROVAL
PUBLISHING
PUBLISHED
VERIFYING
VERIFIED
FAILED
CANCELLED
ARCHIVED
```

## 7. ContentBrief

```text
id
website_id
content_work_item_id
version
title
content_type
target_page_id_optional
primary_keyword_id_optional
secondary_keyword_ids_json
topic_id_optional
search_intent
business_goal_id_optional
primary_conversion
audience
customer_problem
desired_outcome
recommended_angle
key_questions_json
required_sections_json
optional_sections_json
internal_link_targets_json
external_evidence_requirements_json
approved_claims_json
prohibited_claims_json
brand_voice_notes
seo_rule_constraints_json
status
created_by_ai_run_id_optional
created_by_user_id_optional
approved_by_user_id_optional
created_at
approved_at
archived_at
```

Statuses:

```text
DRAFT
AWAITING_REVIEW
APPROVED
SUPERSEDED
ARCHIVED
```

Approved brief versions are immutable.

## 8. Brief generation inputs

Use only approved/relevant context:

```text
P3 Recommendation
Diagnosis
Opportunity
Business Context
Business Goal
Brand Facts
SEO Rules
Keyword
Topic
Keyword ownership
related Pages
P1/P2 evidence
relevant Page content
```

Do not introduce unverified business facts.

## 9. ContentDraft

```text
id
website_id
content_work_item_id
brief_id
current_revision_id
status
created_by_ai_run_id_optional
created_by_user_id_optional
created_at
updated_at
archived_at
```

Statuses:

```text
DRAFTING
AWAITING_QA
AWAITING_EDITOR_REVIEW
APPROVED
REJECTED
SUPERSEDED
ARCHIVED
```

## 10. ContentRevision

Never overwrite draft history.

```text
id
content_draft_id
website_id
revision_number
title
slug_optional
excerpt_optional
body_markdown
body_html_optional
meta_title_optional
meta_description_optional
schema_json_optional
change_summary
created_by_ai_run_id_optional
created_by_user_id_optional
created_at
```

## 11. Content Draft Agent

Primary P4 generation agent:

```text
CONTENT_DRAFT_AGENT
```

Job:

> Produce or revise content using the approved Brief, Business Context, Brand Facts, SEO Rules, and allowed evidence.

It must not publish.

Rules:

- one agent = one job
- approved facts only
- no invented pricing, credentials, statistics, legal claims, customer counts, or source URLs
- obey BLOCKING SEO Rules
- preserve uncertainty where relevant

## 12. Content QA

```text
ContentQAResult
id
website_id
content_revision_id
qa_type
status
score_optional
issues_json
warnings_json
blocking_issues_json
checked_at
checker_version
ai_run_id_optional
created_at
```

QA types:

```text
BRAND_FACT_VALIDATION
SEO_RULE_VALIDATION
ON_PAGE_SEO
INTENT_ALIGNMENT
ANSWER_READINESS
INTERNAL_LINKING
CLAIM_SAFETY
STRUCTURE
READABILITY
DUPLICATION_RISK
```

Statuses:

```text
PASS
PASS_WITH_WARNINGS
FAIL
```

Blocking QA prevents CMS approval until resolved or explicitly overridden by an authorized policy where allowed.

## 13. On-page QA

Initial checks may include:

- title exists
- meta description exists
- clear H1
- sensible heading structure
- intent represented
- primary keyword used naturally
- URL/slug review
- internal links where appropriate
- commercial CTA where required
- duplicate title/meta warning

Do not use simplistic keyword-density scores as a primary quality signal.

## 14. Answer Readiness

Check whether important questions are answered clearly using:

- direct answers near relevant headings
- definitions
- concise summaries
- lists/tables where appropriate
- factual consistency
- FAQ only when useful

Do not promise AI Overview or LLM citation outcomes.

## 15. Brand Fact / claim safety

Only approved canonical Brand Facts may support business claims.

If a necessary claim is not supported:

```text
MISSING APPROVED FACT
```

If content conflicts with a prohibited claim or BLOCKING rule:

```text
BLOCK
```

## 16. InternalLinkSuggestion

```text
id
website_id
content_work_item_id
source_page_id
target_page_id
anchor_text
placement_context
reason
confidence
status
created_by_ai_run_id_optional
created_at
reviewed_at
```

Statuses:

```text
PROPOSED
APPROVED
REJECTED
IMPLEMENTED
```

Full site-wide graph intelligence belongs in P5.

## 17. WordPress activation

P4 activates WordPress in the Connection framework.

Possible auth patterns:

```text
APPLICATION_PASSWORD
OAUTH2
CUSTOM_PLUGIN_TOKEN
```

Secrets must remain encrypted/referenced. Never store plaintext credentials in application records or logs.

## 18. CMS provider abstraction

```text
CmsProvider
- testConnection()
- getCapabilities()
- createDraft()
- updateDraft()
- getPreview()
- publish()
- getPublishedPage()
- verifyPublishedState()
```

WordPress is the first implementation.

## 19. Publishing permission modes

```text
READ_ONLY
DRAFT_ONLY
DRAFT_AND_UPDATE
PUBLISH_WITH_APPROVAL
FULL_PUBLISH
```

Recommended default:

```text
DRAFT_ONLY
```

Investor prototype should support at minimum:

```text
DRAFT_ONLY
PUBLISH_WITH_APPROVAL
```

## 20. PublishingPolicy

```text
id
website_id
connection_id
mode
require_editor_approval
require_publish_approval
require_qa_pass
allowed_content_types_json
created_by_user_id
updated_by_user_id
created_at
updated_at
```

Publishing authorization is separate from content approval.

## 21. Execution

```text
id
website_id
recommendation_id
decision_id
content_work_item_id
execution_type
provider
connection_id
status
requested_by_user_id
approved_by_user_id_optional
executed_by_user_id_optional
external_entity_id_optional
external_url_optional
before_snapshot_json_optional
after_snapshot_json_optional
started_at
completed_at
verified_at
error_code
error_summary
created_at
updated_at
```

Types:

```text
CREATE_CMS_DRAFT
UPDATE_CMS_DRAFT
PUBLISH_CONTENT
UPDATE_PUBLISHED_CONTENT
APPLY_INTERNAL_LINK_UPDATE
OTHER
```

Statuses:

```text
PROPOSED
READY
AWAITING_APPROVAL
APPROVED
EXECUTING
SUCCEEDED
VERIFYING
VERIFIED
FAILED
CANCELLED
ROLLED_BACK
```

## 22. ExecutionStep

```text
id
execution_id
step_type
status
request_summary_json
response_summary_json
started_at
finished_at
error_code
error_summary
created_at
```

Do not store secrets or unnecessary raw provider payloads.

## 23. WordPress draft flow

```text
Approved Content Revision
+ required QA passes
+ PublishingPolicy permits draft creation
→ create WordPress draft
→ store external post ID
→ retrieve preview URL
→ show preview in SEO OS
```

Creating a CMS draft is not publishing.

## 24. PublishApproval

```text
id
website_id
execution_id
status
requested_by_user_id
decided_by_user_id_optional
reason_optional
requested_at
decided_at
created_at
```

Statuses:

```text
REQUESTED
APPROVED
REJECTED
EXPIRED
CANCELLED
```

Client-side UI alone cannot authorize publishing.

## 25. Approval integrity

If approved revision A changes to revision B:

```text
approval for A is invalid
```

A PublishApproval must authorize the exact Execution/revision it was created for.

Never allow:

```text
approve A
→ mutate into B
→ publish B using approval for A
```

## 26. Publish preflight

Before publish:

1. validate tenant access
2. validate Connection
3. validate PublishingPolicy
4. validate required QA
5. validate exact approved revision/hash
6. validate PublishApproval
7. re-check BLOCKING SEO Rules
8. call provider
9. persist safe response summary
10. start live verification

## 27. ExecutionVerification

```text
id
website_id
execution_id
verification_type
status
expected_value_json
observed_value_json
verified_at
error_summary
created_at
```

Types:

```text
URL_RESOLVES
HTTP_STATUS
TITLE_MATCH
META_DESCRIPTION_MATCH
H1_MATCH
CONTENT_PRESENT
CANONICAL_PRESENT
INTERNAL_LINK_PRESENT
CMS_STATUS_PUBLISHED
```

P4 verification is execution-specific. Full technical crawling belongs in P5.

## 28. Verification rule

WordPress API success does not equal `VERIFIED`.

Required:

```text
CMS publish succeeds
+
live URL is fetched/checked
```

If live verification fails, show an unresolved verification issue.

## 29. Failure handling

Represent safely:

- connection failure
- authorization failure
- QA failure
- stale approval
- draft failure
- publish failure
- live verification failure
- content mismatch

Do not blindly retry publish when duplicate publication is possible.

## 30. P4 Command Center

P4 asks:

> What approved work is ready to execute?

Show:

```text
Content Work Queue
Drafts Awaiting Review
QA Blockers
CMS Drafts Ready
Publish Approvals
Recently Published
Verification Issues
Next Best Step
```

## 31. Content Work Queue

Columns:

```text
Work Item
Type
Recommendation
Page / Topic
Owner
Status
QA
CMS Status
Priority
```

## 32. Draft Editor / Review UI

Recommended layout:

```text
Brief / Evidence | Content Editor | QA / Rules
```

Actions:

```text
Generate revision
Save
Run QA
Request review
Approve draft
Create WordPress draft
```

Publish only appears when policy/state allow it.

## 33. WordPress Preview UI

Show:

```text
CMS status
external post ID
preview URL
title
slug
last sync
publishing policy
```

Actions:

```text
Update draft
Open preview
Request publish approval
```

## 34. Demo execution modes

Reuse:

```text
Demo Organization
→ Investor Demo
→ demo.example
```

Two acceptable modes:

### SANDBOX LIVE MODE
A disposable WordPress sandbox is connected.

### SIMULATED EXECUTION MODE
A mock WordPress provider simulates draft/preview/publish/verification.

Persistent label:

```text
DEMO EXECUTION
```

Never simulate successful publishing against `thecreativeseo.com`.

## 35. Demo stories

Create:

```text
1 NEW_CONTENT workflow
1 CONTENT_REFRESH workflow
1 TITLE_META_UPDATE workflow
1 INTERNAL_LINK_UPDATE workflow
1 BLOCKED_BY_QA example
1 PUBLISH_APPROVAL example
1 VERIFIED publish example
1 VERIFICATION_FAILURE example
```

## 36. Audit events

Add equivalents:

```text
CONTENT_WORK_ITEM_CREATED
CONTENT_BRIEF_CREATED
CONTENT_BRIEF_APPROVED
CONTENT_DRAFT_CREATED
CONTENT_REVISION_CREATED
CONTENT_QA_RUN
CONTENT_DRAFT_APPROVED
WORDPRESS_CONNECTED
WORDPRESS_DRAFT_CREATED
WORDPRESS_DRAFT_UPDATED
PUBLISH_APPROVAL_REQUESTED
PUBLISH_APPROVAL_APPROVED
PUBLISH_APPROVAL_REJECTED
EXECUTION_STARTED
EXECUTION_SUCCEEDED
EXECUTION_FAILED
CONTENT_PUBLISHED
CONTENT_VERIFICATION_STARTED
CONTENT_VERIFIED
CONTENT_VERIFICATION_FAILED
```

Never audit tokens/passwords.

## 37. Security

Release blocking:

- CMS secrets encrypted/referenced
- tenant-safe Connection selection
- server-side publish authorization
- exact revision/execution approval binding
- stale approvals invalidated
- no silent bypass of BLOCKING QA/SEO Rules
- no secrets in AI prompts/audit/execution logs
- no cross-tenant CMS execution
- provider target IDs authorized server-side

## 38. Navigation

```text
COMMAND CENTER

INTELLIGENCE
├── Pages
├── Queries
├── Keywords
├── Topics
├── Competitors
└── Signals

OPPORTUNITIES
├── Opportunity Queue
└── Ownership Conflicts

AI WORKBENCH
├── Diagnoses
├── Recommendations
└── Review Queue

EXECUTION
├── Content Work
├── Drafts
├── Publishing
└── Verification

WEBSITE
├── Business Goals
├── Business Context
├── Brand Facts
└── SEO Rules

CONNECTIONS
├── Data Sources
├── Publishing
├── Imports
└── Data Health

WORKSPACE
├── Team
├── Audit History
└── Settings
```

## 39. Service boundaries

```text
ContentWorkService
ContentBriefService
ContentDraftService
ContentRevisionService
ContentQaService
InternalLinkSuggestionService
CmsProviderService
WordPressProvider
PublishingPolicyService
ExecutionService
ExecutionApprovalService
ExecutionVerificationService
```

## 40. Prototype definition of done

A stakeholder can follow:

```text
Approved Recommendation
→ Brief
→ Draft
→ QA
→ Human Review
→ WordPress Draft
→ Preview
→ Publish Approval
→ Publish
→ Verify
```

and understand that SEO OS is agentic, governed, auditable, and human-controlled.

## 41. Production definition of done

P4 passes when:

1. approved Recommendation creates ContentWorkItem
2. Brief works/versioned safely
3. Draft/Revision history works
4. content generation respects context/rules/facts
5. QA works
6. blocking QA prevents execution
7. WordPress connection works
8. publishing permissions work
9. WordPress draft creation works
10. preview works
11. publish approval works server-side
12. stale approvals invalidate
13. publish execution works
14. live verification works
15. Execution history persists
16. secrets protected
17. tenant isolation tests pass
18. typecheck/lint/tests/migrations/build pass

## 42. P5 handoff

P5 adds:

```text
Technical Crawl Evidence
→ Screaming Frog ingestion
→ Technical Issues
→ Internal-link graph
→ Technical Recommendations
→ Ticket / Fix workflow
→ Staging verification
→ Production verification
```
