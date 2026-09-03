# SEO OS — P3_PROTOTYPE_DEMO_BLUEPRINT.md

**Investor message:** P1 shows what changed. P2 shows what is worth investigating. P3 retrieves evidence, diagnoses the issue, and proposes an action for human review.

## Demo journey

```text
P2 Opportunity
→ Evidence Package
→ Structured Diagnosis
→ Confidence / Missing Evidence
→ Recommendation
→ Human Decision
```

## Flagship case

Show:

```text
GSC — First-party
Clicks -25.8%

GA4 — First-party
Page contributes conversions

Semrush — Third-party
Position 8 → 14

Keyword ownership
Intended: /payroll-software/
Ranking: /payroll-guide/

Business Goal
Generate demos
```

Then:

```text
KEYWORD OWNERSHIP CONFLICT
STRONGLY SUPPORTED
Confidence: High

CTR / SERP MISMATCH
SUSPECT
Confidence: Medium

TECHNICAL INDEXATION
UNKNOWN
No crawl/indexation evidence available
```

## Recommendation

```text
Clarify ownership of the commercial keyword cluster

Priority: High
Confidence: High
Effort: Medium
Risk: Medium

Evidence:
GSC
Semrush
Keyword ownership
Business Goal

[ Approve ]
[ Modify ]
[ Reject ]
[ Request more evidence ]
```

No execution button.

## Investor talking points

1. SEO OS retrieves evidence before AI reasoning.
2. Findings are structured, not giant prose answers.
3. Every important finding links to evidence.
4. UNKNOWN is an intentional outcome.
5. AI cannot approve its own action.
6. P4 executes only approved Recommendations.

## RAG architecture visual

```text
Business Context
GSC / GA4
Semrush
Keywords / Topics
Page Content
Historical Decisions
        ↓
Evidence Assembler
        ↓
Bounded Evidence Package
        ↓
AI Diagnosis
        ↓
Recommendation
        ↓
Human Review
```

## Demo Mode

Reuse `Demo Organization → Investor Demo → demo.example`.

Create:

- 5 DiagnosisRequests
- 5 EvidencePackages
- 5 Diagnoses
- 10–15 Findings
- 5–8 Recommendations
- several Decisions

Persistent `DEMO DATA` label.

## P3 demo milestones

```text
P3-DEMO-01 AI/provider + schema
P3-DEMO-02 Evidence abstraction
P3-DEMO-03 Evidence Assembler
P3-DEMO-04 Prompt/version registry
P3-DEMO-05 Page Diagnosis Agent
P3-DEMO-06 Findings + evidence links
P3-DEMO-07 Recommendations
P3-DEMO-08 Human Review + Decisions
P3-DEMO-09 Diagnosis/Recommendation UI
P3-DEMO-10 Command Center
P3-DEMO-11 RAG safety + security
P3-DEMO-12 Investor polish
```
