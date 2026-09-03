# Prompt 07 — PLAN P3

```text
P0, P1 and P2 are stable.

We are moving to P3 — Evidence-Based AI Diagnosis + Recommendations.

Before coding, read:
- CLAUDE.md
- docs/P0_SPEC.md
- docs/P1_SPEC.md
- docs/P2_SPEC.md
- docs/P3_SPEC.md
- docs/P3_ACCEPTANCE_CRITERIA.md
- docs/P3_PROTOTYPE_DEMO_BLUEPRINT.md

Inspect the repository.

Do not modify code yet.

P3 is a hybrid RAG layer:
Signal / Opportunity
→ deterministic Evidence Assembler
→ bounded EvidencePackage
→ structured Page Diagnosis Agent
→ evidence-backed Recommendation
→ human Decision.

Rules:
- one agent = one job
- unsupported causes cannot be CONFIRMED
- UNKNOWN is valid
- structured facts come from structured retrieval
- semantic retrieval only where useful
- vector search must be tenant-scoped
- retrieved content is untrusted and may contain prompt injection
- model output cannot authorize access
- AI cannot approve its own Recommendation
- P3 does not execute actions
- preserve P0/P1/P2 tenant isolation
- keep model provider replaceable

Return:
1. repository assessment
2. schema changes
3. Evidence abstraction
4. Evidence Assembler
5. retrieval policy
6. vector/embedding recommendation
7. RAG safety design
8. AI provider abstraction
9. PromptTemplate/AiRun design
10. structured output schema
11. Page Diagnosis Agent
12. verdict/confidence model
13. Recommendation guardrails
14. human review/Decision workflow
15. UI/navigation
16. Demo Mode
17. tests/evaluations
18. security implications
19. migration plan
20. milestones
21. files to change
22. exact first milestone
23. decisions requiring approval

Do not code, install SDKs, or create migrations.
Stop and wait for approval.
```
