# SEO OS — P3_SPEC.md

**Phase:** P3 — Evidence-Based AI Diagnosis + Recommendations  
**Depends on:** P0 + P1 + P2  
**Primary question:** Why is this happening, what evidence supports the conclusion, and what should the team do next?

## 1. Objective

P3 introduces the AI reasoning layer.

```text
P0 Context
→ P1 First-party Evidence
→ P2 Opportunity
→ P3 Evidence Retrieval + Diagnosis + Recommendation + Human Review
→ P4 Controlled Execution
```

P3 is not a generic chatbot. It is an evidence-grounded diagnostic system.

## 2. Product principle

Required loop:

```text
Signal / Opportunity
→ Evidence Assembler
→ Bounded Evidence Package
→ AI Diagnosis
→ Evidence-backed Recommendation
→ Human Decision
```

Never:

```text
Prompt
→ plausible unsupported answer
```

## 3. Hybrid RAG architecture

P3 is a hybrid RAG layer.

Use deterministic structured retrieval for:

- Business Context
- Business Goals
- Brand Facts
- SEO Rules
- GSC / GA4 metrics
- Pages / Queries
- Keywords / RankingSnapshots
- Keyword ownership
- Topics
- Competitor evidence
- Signals / Opportunities

Use semantic/vector retrieval only where useful for:

- page content passages
- customer language
- historical diagnoses
- historical learnings
- long-form rules/context

Do not force all SEO OS data into embeddings. Direct structured evidence outranks vector similarity.

## 4. P3 scope

Implement:

- AI provider abstraction
- versioned PromptTemplate
- AiRun
- Evidence abstraction
- EvidencePackage
- Evidence Assembler
- versioned RetrievalPolicy
- optional tenant-scoped embeddings
- DiagnosisRequest
- Page Diagnosis Agent
- Diagnosis
- DiagnosisFinding
- DiagnosisFindingEvidence
- missing-evidence handling
- Recommendation
- RecommendationEvidence
- Decision
- human review queue
- diagnosis/recommendation history
- P3 Command Center
- audit events
- RAG safety tests
- tenant isolation
- investor Demo Mode

## 5. Non-goals

Do not implement in P3:

- WordPress publishing
- HubSpot publishing
- autonomous content deployment
- autonomous technical fixes
- autonomous approval
- full experiment/learning engine
- AI visibility tracking
- P4 execution

Approved Recommendations hand off to P4.

## 6. Model-provider independence

Domain entities must not depend on one AI vendor.

Conceptual interface:

```text
AiModelProvider
- generateStructured()
- embed()
- healthCheck()
```

Every AI run records provider and model.

## 7. AiRun

```text
id
organization_id
workspace_id
website_id
agent_type
task_type
provider
model
prompt_template_id
prompt_template_version
output_schema_version
evidence_package_id
status
started_at
finished_at
input_tokens
output_tokens
estimated_cost_optional
error_code
error_summary
created_by_user_id
created_at
```

Statuses:

```text
QUEUED
RUNNING
SUCCEEDED
FAILED
CANCELLED
```

Never log provider secrets.

## 8. PromptTemplate

```text
id
name
agent_type
task_type
version
system_instructions
output_schema_version
status
created_at
activated_at
retired_at
```

Statuses:

```text
DRAFT
ACTIVE
RETIRED
```

Prompt changes require a new version. Historical runs retain the prompt/model version used.

## 9. Evidence abstraction

P3 should use a normalized evidence interface over P0/P1/P2 records.

Conceptual shape:

```text
Evidence
id
website_id
type
source
source_entity_type
source_entity_id
captured_at
as_of_date
metric_key
numeric_value
text_value
context_json
reliability
```

Evidence types may include:

```text
BUSINESS_CONTEXT
BUSINESS_GOAL
BRAND_FACT
SEO_RULE
GSC_METRIC
GA4_METRIC
KEYWORD_METRIC
RANKING_SNAPSHOT
KEYWORD_OWNERSHIP
TOPIC_MAPPING
COMPETITOR_OBSERVATION
PAGE_CONTENT
INTERNAL_LINK
TECHNICAL_FINDING
PREVIOUS_CHANGE
PREVIOUS_DIAGNOSIS
PREVIOUS_LEARNING
MANUAL_VERIFICATION
```

Evidence may be a materialized table, service/view abstraction, or hybrid. Provenance must remain inspectable.

## 10. Evidence reliability

Controlled values:

```text
DIRECT_FIRST_PARTY
DIRECT_PROVIDER
USER_PROVIDED
SYSTEM_DERIVED
AI_INFERRED
UNKNOWN
```

AI-inferred evidence must never be presented as equivalent to direct evidence.

## 11. EvidencePackage

The Evidence Assembler creates the immutable package used by an AI run.

```text
id
website_id
target_type
target_id
purpose
assembled_at
context_version_id
period_start
period_end
evidence_count
retrieval_policy_version
retrieval_manifest_json
content_hash
created_at
```

The package references the exact evidence used at diagnosis time.

## 12. Evidence Assembler

Server-side deterministic service.

For a Page diagnosis it may retrieve:

```text
target Page
related Signal
related Opportunity
approved Business Context
Business Goal
SEO Rules
Brand Facts
GSC comparison
GA4 comparison
top Queries
priority Keywords
Keyword ownership
RankingSnapshots
Topic
Competitor evidence
current Page content
relevant previous changes/diagnoses/learnings
```

Responsibilities:

1. validate tenant access
2. select relevant evidence
3. apply date windows
4. deduplicate
5. label source/reliability
6. cap context
7. preserve evidence IDs
8. create EvidencePackage

The LLM does not browse arbitrary tenant records itself.

## 13. Retrieval policy

Retrieval must be named/versioned and inspectable.

Example:

```text
Business Context: current approved version
GSC: last 28d vs prior 28d
GA4: same comparison
Queries: top by impressions + largest declines
Keywords: active priority ownership
Rankings: latest + previous
Competitors: relevant overlaps
Content: current target Page + selected relevant passages
```

## 14. DiagnosisRequest

```text
id
website_id
target_type
target_id
signal_id_optional
opportunity_id_optional
requested_by_user_id
status
evidence_package_id
ai_run_id
created_at
started_at
completed_at
```

Statuses:

```text
REQUESTED
ASSEMBLING_EVIDENCE
READY
RUNNING
COMPLETED
FAILED
CANCELLED
```

## 15. Page Diagnosis Agent

Initial P3 agent:

```text
PAGE_DIAGNOSIS
```

Principle:

> one agent = one job

Job:

> Assess plausible causes using only supplied evidence; separate supported findings from hypotheses; identify missing evidence; produce structured recommendations.

It cannot execute changes.

## 16. Diagnostic categories

Initial taxonomy:

```text
INTENT_MISMATCH
CTR_SERP_MISMATCH
KEYWORD_OWNERSHIP_CONFLICT
CANNIBALIZATION
CONTENT_GAP
CONTENT_STALENESS
WEAK_INTERNAL_SUPPORT
COMPETITOR_DISPLACEMENT
TECHNICAL_INDEXATION
TECHNICAL_RENDERING
TECHNICAL_CANONICALIZATION
SERP_FEATURE_CHANGE
SEASONALITY
CONVERSION_MISMATCH
INSUFFICIENT_EVIDENCE
OTHER
```

Do not force a cause when evidence is insufficient.

## 17. DiagnosisFinding

```text
id
diagnosis_id
category
verdict
confidence
title
summary
supporting_evidence_count
contradicting_evidence_count
missing_evidence_json
created_at
```

Verdicts:

```text
CONFIRMED
STRONGLY_SUPPORTED
SUSPECT
CLEAR
UNKNOWN
NOT_APPLICABLE
```

Use `CONFIRMED` conservatively.

`UNKNOWN` is a valid result.

## 18. Finding evidence links

```text
DiagnosisFindingEvidence
id
diagnosis_finding_id
evidence_id
relationship
created_at
```

Relationships:

```text
SUPPORTS
CONTRADICTS
CONTEXT
```

A finding without supporting evidence cannot be CONFIRMED.

## 19. Diagnosis

```text
id
website_id
target_type
target_id
signal_id_optional
opportunity_id_optional
status
executive_summary
primary_finding_id_optional
overall_confidence
evidence_package_id
ai_run_id
created_by_user_id
reviewed_by_user_id
created_at
reviewed_at
archived_at
```

Statuses:

```text
DRAFT
AWAITING_REVIEW
REVIEWED
SUPERSEDED
ARCHIVED
```

Never overwrite prior diagnoses; create history.

## 20. Missing evidence

P3 must explicitly state unknowns such as:

```text
No crawl evidence available.
No current internal-link graph.
No SERP snapshot.
No deployment history.
No configured conversion evidence.
```

Missing evidence must not become an assumption.

## 21. Recommendation

```text
id
website_id
diagnosis_id_optional
opportunity_id_optional
type
status
priority
title
summary
rationale
page_id_optional
keyword_id_optional
topic_id_optional
expected_effect_description
confidence
effort
risk
owner_user_id
created_by_ai_run_id_optional
created_by_user_id_optional
created_at
updated_at
implemented_at
archived_at
```

P3 lifecycle:

```text
DRAFT
→ AWAITING_REVIEW
→ APPROVED / MODIFIED / REJECTED
```

Future states may support P4+:

```text
ASSIGNED
IN_PROGRESS
IMPLEMENTED
MEASURING
VALIDATED
NO_IMPACT
ROLLED_BACK
ARCHIVED
```

## 22. Recommendation types

```text
CONTENT_REFRESH
CONTENT_CREATE
TITLE_META_UPDATE
INTENT_REALIGNMENT
KEYWORD_OWNERSHIP_FIX
INTERNAL_LINK_UPDATE
PAGE_CONSOLIDATION
PAGE_SPLIT
TECHNICAL_INVESTIGATION
TECHNICAL_FIX
SERP_REVIEW
CONVERSION_REVIEW
MONITOR_ONLY
REQUEST_MORE_EVIDENCE
OTHER
```

P3 proposes. P4 executes approved work.

## 23. Recommendation guardrails

Every Recommendation must:

- cite evidence
- state confidence
- state effort
- state risk
- respect SEO Rules
- respect approved Brand Facts
- respect Business Context
- avoid unsupported numeric forecasts
- state when more evidence is required
- require human review

A BLOCKING SEO Rule must block or explicitly require authorized override.

## 24. Human review

Required actions:

```text
APPROVE
MODIFY
REJECT
REQUEST_MORE_EVIDENCE
```

Before deciding, user sees:

```text
Diagnosis
Evidence
Confidence
Missing Evidence
Recommendation
Risk
Effort
Rules / Constraints
```

## 25. Decision

```text
id
website_id
recommendation_id
decision
reason
modified_recommendation_json_optional
decided_by_user_id
decided_at
created_at
```

Values:

```text
APPROVED
MODIFIED
REJECTED
NEEDS_EVIDENCE
```

AI cannot approve its own Recommendation.

## 26. Structured AI output

Require typed output rather than free-form parsing.

Conceptual schema:

```text
executive_summary

findings[]
- category
- verdict
- confidence
- summary
- supporting_evidence_ids[]
- contradicting_evidence_ids[]
- missing_evidence[]

recommendations[]
- type
- title
- summary
- rationale
- confidence
- effort
- risk
- evidence_ids[]

overall_confidence
```

Validate every referenced evidence ID server-side.

## 27. RAG safety

Retrieved page/competitor content is untrusted data.

The AI layer must:

- ignore instructions embedded in retrieved content
- resist prompt injection
- follow only system/application instructions
- never reveal secrets
- never cross tenant boundaries
- never use model output for authorization

## 28. Page content snapshots

If content retrieval is implemented:

```text
PageContentSnapshot
id
website_id
page_id
captured_at
content_hash
title
meta_description
headings_json
body_text
source
object_storage_key_optional
created_at
```

Historical content snapshots are preserved.

## 29. Embeddings

Optional:

```text
EmbeddingRecord
id
website_id
source_entity_type
source_entity_id
chunk_index
chunk_text_hash
embedding_model
embedding_version
created_at
```

Requirements:

- tenant-scoped search
- source IDs retained
- model/version retained
- re-embedding supported
- vector similarity never overrides direct evidence

## 30. P3 Command Center

P3 question:

```text
Why, and what should we do?
```

Sections:

```text
Diagnosis Queue
Awaiting Review
Highest-Confidence Findings
Needs More Evidence
Approved Recommendations
Next Best Step
```

## 31. Page Diagnosis UI

Sections:

```text
Evidence
Diagnosis
Recommendations
History
```

Finding card:

```text
KEYWORD OWNERSHIP CONFLICT

Verdict
STRONGLY SUPPORTED

Confidence
HIGH

Supporting Evidence
...

Contradicting Evidence
...

Missing Evidence
...
```

## 32. Recommendation Review UI

Show:

```text
Recommendation
Priority
Confidence
Effort
Risk
Rationale
Evidence
Rules / Constraints
```

Actions:

```text
Approve
Modify
Reject
Request more evidence
```

No execution button in P3.

## 33. Demo Mode

Reuse:

```text
Demo Organization
→ Investor Demo
→ demo.example
```

Persistent:

```text
DEMO DATA
```

Create stories:

```text
1 keyword ownership conflict
1 CTR / SERP mismatch
1 content gap
1 insufficient-evidence diagnosis
1 rule-constrained recommendation
```

Never insert synthetic P3 records into `thecreativeseo.com`.

## 34. Investor flagship story

```text
P1
Traffic decline

P2
High-value commercial Opportunity

P3 Evidence
GSC: clicks down
GA4: Page contributes conversions
Semrush: position down
Ownership: commercial Page intended owner
Ranking: supporting article currently ranking
Business Goal: generate demos
```

Structured result:

```text
Keyword ownership conflict
STRONGLY SUPPORTED

CTR mismatch
SUSPECT

Technical indexation
UNKNOWN
No crawl evidence
```

Then an evidence-backed Recommendation requiring human review.

## 35. Audit events

Add equivalents:

```text
DIAGNOSIS_REQUESTED
EVIDENCE_PACKAGE_ASSEMBLED
AI_RUN_STARTED
AI_RUN_COMPLETED
AI_RUN_FAILED
DIAGNOSIS_CREATED
DIAGNOSIS_REVIEWED
RECOMMENDATION_CREATED
RECOMMENDATION_APPROVED
RECOMMENDATION_MODIFIED
RECOMMENDATION_REJECTED
RECOMMENDATION_NEEDS_EVIDENCE
DECISION_RECORDED
```

## 36. Security

Release blocking:

- tenant-safe evidence retrieval
- tenant-safe vector retrieval
- server validation of evidence IDs
- prompt-injection defense
- no unnecessary secrets sent to models
- model output never authorizes access
- human Decision authorization server-side
- no cross-tenant AI run/evidence references

## 37. Navigation

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

WEBSITE
├── Business Goals
├── Business Context
├── Brand Facts
└── SEO Rules

CONNECTIONS
├── Data Sources
├── Imports
└── Data Health

WORKSPACE
├── Team
├── Audit History
└── Settings
```

## 38. Service boundaries

Suggested:

```text
EvidenceService
EvidenceAssembler
RetrievalPolicyService
SemanticRetrievalService
AiProviderService
PromptTemplateService
AiRunService
PageDiagnosisService
DiagnosisValidationService
RecommendationService
RecommendationGuardrailService
DecisionService
```

## 39. P3 prototype definition of done

A stakeholder can follow:

```text
Signal / Opportunity
→ Evidence Package
→ AI Diagnosis
→ Finding verdicts
→ Evidence citations
→ Missing evidence
→ Recommendation
→ Human Decision
```

and understand that SEO OS uses AI to reason over bounded evidence rather than hallucinating from a generic prompt.

## 40. Production definition of done

P3 passes when:

1. Evidence Assembler works.
2. retrieval is tenant-safe.
3. EvidencePackages are immutable/auditable.
4. AI provider abstraction works.
5. prompts are versioned.
6. AI runs retain model/prompt provenance.
7. structured output validates.
8. Page Diagnosis works.
9. findings cite evidence.
10. missing evidence is explicit.
11. Recommendations work.
12. SEO Rule guardrails work.
13. human review/Decisions work.
14. diagnosis history persists.
15. RAG/prompt-injection tests pass.
16. tenant security tests pass.
17. typecheck/lint/tests/migrations/build pass.

## 41. P4 handoff

P4 may assume:

```text
Business Context
Evidence
Signals
Opportunities
Diagnoses
Recommendations
Human Decisions
Approved Recommendations
```

P4 then adds:

```text
Approved Recommendation
→ Brief / Draft
→ QA
→ Preview
→ Controlled Tool Execution
→ CMS Draft
→ Publish Approval
→ Execute
→ Verify
→ Measure
```
