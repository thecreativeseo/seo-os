# SEO OS — P4_PROTOTYPE_DEMO_BLUEPRINT.md

**Investor message:** P3 explains what to do. P4 turns the approved recommendation into governed execution.

## Flagship demo

```text
P3 Recommendation
APPROVED
→ Content Work Item
→ Brief
→ Draft
→ QA
→ Editor Approval
→ WordPress Draft
→ Preview
→ Publish Approval
→ Publish
→ Live Verification
```

## Content Work Queue

Show:

```text
Work Item | Type | Priority | Owner | Status | QA | CMS
```

## Brief

Show:

```text
Business Goal
Target Page
Primary Keyword
Intent
Audience
Customer problem
Required sections
Approved claims
Prohibited claims
SEO Rules
Internal-link targets
```

Investor line:

> The draft is created inside the customer's approved business context and governance rules.

## Draft Editor

Use a three-panel layout:

```text
BRIEF / EVIDENCE | CONTENT EDITOR | QA / RULES
```

QA example:

```text
Brand Facts       PASS
SEO Rules         PASS
Intent            PASS
On-page SEO       WARNING
Answer Readiness  PASS
Internal Linking  3 suggestions
```

## QA blocker story

```text
BLOCKING ISSUE

Unsupported claim:
"Trusted by 10,000 businesses"

No approved Brand Fact supports this claim.

[ Fix draft ]
```

Investor line:

> SEO OS is designed to stop plausible AI hallucinations before they become published claims.

## WordPress draft

```text
Status: Draft created
Post ID: 12345
Preview: [ Open preview ]
Publishing policy: PUBLISH WITH APPROVAL
```

## Publish approval

```text
Revision: v4
QA: PASS
Requested by: SEO Lead

[ Approve Publish ] [ Reject ]
```

Make the human gate visually obvious.

## Verification

Successful:

```text
✓ CMS reports published
✓ URL resolves
✓ Title matches
✓ Meta matches
✓ Main content present

VERIFIED
```

Failure example:

```text
Published but verification issue
Expected title: Payroll Software Philippines
Observed title: Old Payroll Platform Title
Needs review
```

## P4 Command Center

```text
Content Work Queue        7
Awaiting Editor Review    3
QA Blockers               1
CMS Drafts Ready          2
Publish Approvals         1
Recently Published        4
Verification Issues       1
```

Next Best Step:

```text
Review publish approval for Payroll Software refresh
```

## Demo execution modes

### SANDBOX
Use a disposable WordPress site.

### DEMO EXECUTION
Use a mock CMS provider when no safe sandbox is configured.

Never imply simulated execution changed a real site.

## Five-minute investor script

1. Start with approved P3 Recommendation.
2. Generate/show Brief and Draft.
3. Show QA and one blocked claim.
4. Create WordPress Draft and preview.
5. Approve publish and show live verification.

Close with:

> Context → Evidence → Opportunity → Diagnosis → Execution.

## Demo milestones

```text
P4-DEMO-01 Execution schema
P4-DEMO-02 Work Items + Briefs
P4-DEMO-03 Drafts + revisions
P4-DEMO-04 QA
P4-DEMO-05 Editor UX
P4-DEMO-06 CMS provider abstraction
P4-DEMO-07 WordPress draft + preview
P4-DEMO-08 Publish approval
P4-DEMO-09 Publish execution
P4-DEMO-10 Live verification
P4-DEMO-11 Command Center
P4-DEMO-12 Security + investor polish
```
