# SEO OS — P2_SPEC.md

**Version:** 1.0  
**Phase:** P2 — Market, Keyword & Opportunity Intelligence  
**Status:** Investor-prototype + implementation specification  
**Depends on:** P0 + P1  
**Primary product question:** Where should the SEO team focus next, and why is that opportunity commercially important?  
**Last updated:** 2026-09-02

---

# 1. P2 Objective

P2 turns first-party evidence into a prioritized market/search opportunity system.

P0 established business context.

P1 established first-party search and analytics evidence.

P2 adds market/search intelligence and joins it to:

```text
Business Goals
Customer / Conversion
Pages
Queries
Keywords
Topics
Competitors
Rankings
```

The P2 lifecycle is:

```text
FIRST-PARTY EVIDENCE
        +
MARKET / KEYWORD EVIDENCE
        ↓
NORMALIZE
        ↓
MAP KEYWORD → INTENT → TOPIC → PAGE
        ↓
DETECT OWNERSHIP / COVERAGE GAPS
        ↓
SCORE BUSINESS VALUE
        ↓
CREATE OPPORTUNITY
        ↓
PRIORITIZE
```

P2 does not diagnose root causes with AI yet. That belongs to P3.

---

# 2. P2 Product Promise

P2 must answer:

> Which search opportunities are worth working on next?

Not simply:

> Which keywords have the most volume?

Priority must be informed by business relevance, intent, evidence, current visibility, page ownership, and effort/confidence.

---

# 3. P2 Scope

P2 includes:

- Semrush connection/import architecture
- Semrush ranking snapshot normalization
- keyword metrics snapshots
- Keyword entity
- search intent
- Keyword → Page ownership
- ranking URL divergence
- ranking URL switch candidates
- basic cannibalization candidates
- Topic entity
- Topic hierarchy / cluster relationships
- Keyword ↔ Topic mapping
- Page ↔ Topic mapping
- competitor search intelligence
- keyword overlap / gap evidence
- topic coverage
- deterministic opportunity rules
- Opportunity entity
- OpportunityEvidence
- opportunity prioritization
- Opportunity Queue
- Keyword Explorer
- Topic Explorer
- Competitor Search Intelligence view
- P2 Command Center upgrades
- investor Demo Mode
- provenance / evidence retention
- tenant isolation
- audit events
- versioned scoring model references

---

# 4. P2 Non-Goals

Do not implement unless specification changes:

- AI Page Diagnosis
- AI root-cause reasoning
- Content Brief Agent
- Content Refresh Agent
- WordPress publishing
- HubSpot campaign execution
- autonomous content generation
- technical crawl engine
- backlink outreach automation
- AI visibility tracking
- n8n as source of truth
- autonomous recommendation approval

P2 may prepare data needed by P3/P4.

---

# 5. P2 Investor Narrative

P0:

```text
What matters to the business?
```

P1:

```text
What changed?
```

P2:

```text
Where should we focus?
```

Investor message:

> SEO OS does not prioritize work from search volume alone. It combines business context, first-party performance, market demand, current visibility, page ownership, and evidence into a transparent opportunity queue.

---

# 6. Data Sources

P2 should support:

## Required architecture

```text
Semrush
Manual CSV import
Existing GSC / GA4 from P1
Existing sitemap / Page inventory from P1
User-entered competitors from P0
```

## Optional future / later

```text
Similarweb
other keyword providers
other rank trackers
```

Do not make P2 dependent on Similarweb.

For investor prototype, Demo Mode may use clearly labeled synthetic Semrush-like data.

---

# 7. Semrush Connection / Import

P2 should support one or both:

```text
LIVE API MODE
authorized Semrush data access

IMPORT MODE
Semrush CSV export ingestion
```

For the investor prototype, IMPORT MODE or Demo Mode is acceptable before live API integration.

Normalized Semrush fields should support:

```text
keyword
intent
current_position
previous_position
search_volume
keyword_difficulty
landing_url
ranking_type
serp_features
captured_at
source_import_id / source_snapshot_id
```

Do not overwrite historical ranking/keyword metrics.

---

# 8. Keyword

Conceptual fields:

```text
id
website_id
keyword
normalized_keyword
locale
language
market
intent
business_relevance
commercial_value
status
first_seen_at
last_seen_at
created_at
updated_at
archived_at
```

Recommended uniqueness:

```text
(website_id, normalized_keyword, locale, language, market)
```

Do not assume one global keyword identity across all locales/markets.

---

# 9. Search Intent

Controlled values:

```text
INFORMATIONAL
COMMERCIAL
TRANSACTIONAL
NAVIGATIONAL
LOCAL
MIXED
UNKNOWN
```

Intent provenance may be:

```text
USER_PROVIDED
PROVIDER_PROVIDED
SYSTEM_CLASSIFIED
UNKNOWN
```

If classified later by automation/AI, preserve provenance and confidence.

---

# 10. Keyword Metrics Snapshot

Keyword metrics change over time and must not be stored only as mutable fields on Keyword.

```text
id
website_id
keyword_id
captured_at
search_volume
keyword_difficulty
cpc_optional
source_provider
source_connection_id
source_snapshot_id
created_at
```

Unavailable metrics remain null.

---

# 11. Ranking Snapshot

```text
id
website_id
keyword_id
page_id
captured_at
position
previous_position
ranking_url
ranking_type
serp_features_json
source_provider
source_connection_id
source_snapshot_id
created_at
```

Rules:

- preserve history
- do not overwrite previous snapshots
- map ranking URL to Page where possible
- retain raw URL when not resolvable
- preserve source/provider

---

# 12. Keyword → Page Ownership

```text
KeywordPageOwnership
id
website_id
keyword_id
page_id
ownership_type
status
market
language
locale
assigned_by_user_id
assigned_at
notes
created_at
updated_at
archived_at
```

Ownership types:

```text
PRIMARY
SECONDARY
EXPERIMENTAL
UNKNOWN
```

Statuses:

```text
ACTIVE
REVIEW_NEEDED
RETIRED
```

Recommended rule:

One active PRIMARY owning Page per:

```text
website
keyword
market
language / locale
```

unless an explicit exception exists.

---

# 13. Ownership Intelligence

P2 should detect observational candidates:

```text
NO_OWNING_PAGE
RANKING_URL_DIVERGENCE
RANKING_URL_SWITCH
MULTIPLE_RANKING_PAGES
CANNIBALIZATION_CANDIDATE
```

These remain candidates, not confirmed diagnoses.

Good:

> The intended owner is `/payroll-software/`, but `/blog/payroll-guide/` ranked for this keyword in the latest snapshot.

Bad:

> The blog post is cannibalizing the commercial page.

Confirmed diagnosis belongs to P3.

---

# 14. Topic

Topics are separate from Keywords.

```text
id
website_id
name
slug
description
customer_language
business_outcome
parent_topic_id
pillar_page_id
commercial_destination_page_id
coverage_status
authority_status
owner_user_id
priority
created_at
updated_at
archived_at
```

Coverage statuses:

```text
UNMAPPED
PLANNED
PARTIAL
COVERED
OVERLAPPING
UNKNOWN
```

Authority statuses:

```text
WEAK
DEVELOPING
STRONG
UNKNOWN
```

P2 should avoid pretending topic authority is scientifically precise.

---

# 15. Topic Relations

Use relational links:

```text
TopicKeyword
TopicPage
```

Page roles:

```text
PILLAR
SUPPORTING
COMMERCIAL
UTILITY
UNKNOWN
```

---

# 16. Competitor Search Intelligence

Use P0 Competitor records as canonical competitor entities.

P2 adds evidence such as:

```text
keyword overlap
keywords competitor ranks for
keywords we do not rank for
relative ranking position
competitor ranking URL
topic coverage observations
```

Suggested entity:

```text
CompetitorKeywordSnapshot
id
website_id
competitor_id
keyword_id
captured_at
position
ranking_url
source_provider
source_snapshot_id
created_at
```

Do not present third-party estimates as first-party truth.

---

# 17. Search Demand / Coverage Gaps

Candidate types:

```text
KEYWORD_GAP
TOPIC_GAP
COMMERCIAL_GAP
NO_OWNING_PAGE
WEAK_OWNING_PAGE
STRIKING_DISTANCE_COMMERCIAL
HIGH_IMPRESSION_LOW_CTR
RANKING_URL_DIVERGENCE
COMPETITOR_OVERLAP
CONTENT_REFRESH_CANDIDATE
```

---

# 18. Opportunity

```text
id
website_id
type
status
priority
title
summary
page_id
keyword_id
topic_id
competitor_id
business_goal_id
source_signal_id_optional
effort
confidence
business_importance
expected_effect_description
score
scoring_model_version
owner_user_id
identified_at
qualified_at
scheduled_at
closed_at
created_at
updated_at
archived_at
```

Statuses:

```text
IDENTIFIED
QUALIFIED
SCHEDULED
IN_PROGRESS
DECLINED
COMPLETED
ARCHIVED
```

Priorities:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

Expected effect must be descriptive unless supported by an explicit model.

Do not fabricate numeric traffic/revenue forecasts.

---

# 19. Opportunity Evidence

```text
id
opportunity_id
evidence_type
source_entity_type
source_entity_id
metric_key
numeric_value
text_value
captured_at
period_start
period_end
source_provider
source_snapshot_id
created_at
```

Every Opportunity must be traceable to evidence.

---

# 20. Opportunity Scoring

P2 scoring must be transparent and versioned.

Recommended initial criteria, each 0–5:

```text
Business relevance
Intent match
Search demand
Current visibility
Commercial importance
Competitive gap
Confidence
Effort inverse
```

Example weighted model:

```text
Business relevance × 3
Intent match × 3
Search demand × 2
Current visibility × 2
Commercial importance × 3
Confidence × 2
Effort inverse × 1
```

This is a prioritization heuristic, not a scientific prediction.

Requirements:

- scoring model version retained
- inputs inspectable
- no hidden black-box priority
- score does not equal guaranteed outcome
- thresholds configurable

---

# 21. P2 Command Center

P2 upgrades the Command Center question from:

```text
What changed?
```

to:

```text
What should we work on?
```

Recommended sections:

```text
Top Opportunities
- High-value keyword opportunities
- Commercial page opportunities
- Topic gaps
- CTR opportunities
- Ownership conflicts

Market Movement
- competitor overlap
- ranking gains/losses
- new gap candidates

Opportunity Mix
- Content
- CTR
- Ownership
- Topic
- Competitive

Next Best Step
- Review highest-priority qualified Opportunity
```

Keep P1 freshness / first-party metric context visible.

---

# 22. Keyword Explorer

Columns:

```text
Keyword
Intent
Search Volume
KD
Current Position
Previous Position
Owning Page
Ranking Page
Business Relevance
Topic
Opportunity
```

Support search and filters.

---

# 23. Keyword Detail

Sections:

```text
Keyword identity
Business context
Intent
Market metrics
Ranking history
Owning Page
Current ranking URL
Related Pages
Topic
Competitor overlap
P1 first-party query evidence
Opportunities
Evidence
```

Do not diagnose causal issues.

---

# 24. Topic Explorer

Each Topic shows:

```text
Name
Priority
Customer language
Pillar Page
Commercial destination
Keyword count
Page count
Coverage
Authority status
Open Opportunities
```

Topic Detail:

```text
Topic summary
Keywords
Pages
Pillar/supporting structure
Commercial destination
Coverage gaps
Competitor overlap
Opportunities
```

---

# 25. Opportunity Queue

Flagship P2 screen.

Columns/cards:

```text
Opportunity
Type
Priority
Business Goal
Page
Keyword / Topic
Evidence
Effort
Confidence
Owner
Status
```

Filters:

```text
Priority
Type
Goal
Owner
Status
Topic
Page
Intent
```

---

# 26. Opportunity Detail

Sections:

```text
Why this was identified
Business relevance
Evidence
Affected Page / Keyword / Topic
Scoring breakdown
Confidence
Effort
Expected effect description
Related Signals
Owner
Status
```

Actions:

```text
Qualify
Schedule
Decline
Assign
```

Do not generate AI diagnosis yet.

---

# 27. Data Provenance

Every third-party metric must expose:

```text
provider
captured_at
source snapshot / import
```

Visually distinguish:

```text
GSC — First-party
GA4 — First-party
Semrush — Third-party
```

---

# 28. Imports

Safe path:

```text
Upload
→ identify source
→ parse
→ validate
→ preview
→ commit
→ deduplicate
→ normalize
→ map to Keyword/Page
→ create snapshots
→ run opportunity rules
```

Recommended Import record:

```text
id
website_id
source
file_name
checksum
status
row_count
started_at
finished_at
error_summary
object_storage_key
created_at
```

---

# 29. Audit Events Added in P2

```text
SEMRUSH_CONNECTED
SEMRUSH_IMPORT_STARTED
SEMRUSH_IMPORT_COMPLETED
SEMRUSH_IMPORT_FAILED
KEYWORD_CREATED
KEYWORD_OWNERSHIP_ASSIGNED
KEYWORD_OWNERSHIP_CHANGED
TOPIC_CREATED
TOPIC_UPDATED
TOPIC_KEYWORD_MAPPED
TOPIC_PAGE_MAPPED
OPPORTUNITY_IDENTIFIED
OPPORTUNITY_QUALIFIED
OPPORTUNITY_SCHEDULED
OPPORTUNITY_DECLINED
SCORING_MODEL_APPLIED
```

Never include secret values.

---

# 30. P2 Demo Mode

If live Semrush access is unavailable, create synthetic Semrush-like market data only in:

```text
Demo Organization
→ Investor Demo
→ demo.example
```

Persistent label:

```text
DEMO DATA
```

Do not insert synthetic metrics into `thecreativeseo.com`.

Demo dataset:

```text
50–100 Keywords
5–10 Topics
3–5 Competitors
multiple RankingSnapshots
several ownership conflicts
8–15 Opportunities
```

Investor stories:

```text
1 high-value commercial keyword near page one
1 keyword with wrong ranking URL
1 topic gap
1 competitor gap
1 high-impression CTR opportunity carried from P1
1 no-owning-page opportunity
1 strong business-goal-aligned opportunity
```

---

# 31. P2 Security

- tenant isolation for all Keyword/Topic/Opportunity records
- imports map only to authorized Website
- provider credentials encrypted/referenced
- imports cannot target another tenant through ID changes
- file contents sanitized
- no spreadsheet formulas/scripts executed
- audit events tenant-scoped
- scoring inputs cannot reference another tenant

Any cross-tenant failure is release blocking.

---

# 32. P2 Navigation

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

---

# 33. P2 Service Boundaries

Suggested:

```text
SemrushConnector
ImportService
KeywordService
RankingService
KeywordOwnershipService
TopicService
CompetitorIntelligenceService
OpportunityDetectionService
OpportunityScoringService
OpportunityService
P2EvidenceService
```

---

# 34. P2 Investor Prototype Definition of Done

A stakeholder can follow:

```text
P1 Signal
↓
Keyword / Topic / Competitor context
↓
Owning Page
↓
Business Goal
↓
Transparent scoring
↓
Opportunity
↓
Opportunity Queue
```

and understand:

> SEO OS is prioritizing work based on business relevance and evidence, not search volume alone.

---

# 35. P2 Production Definition of Done

P2 production-ready requires:

1. Semrush live connection or validated import path works.
2. import preview/validation works.
3. Keyword entities normalize safely.
4. historical metrics retained.
5. ranking snapshots retained.
6. keyword ownership works.
7. ownership conflicts detected.
8. Topic mapping works.
9. competitor keyword evidence works.
10. Opportunity rules work.
11. Opportunity evidence retained.
12. scoring model transparent/versioned.
13. Opportunity Queue works.
14. Keyword Explorer works.
15. Topic Explorer works.
16. P2 Command Center works.
17. tenant isolation tests pass.
18. typecheck/lint/tests/migrations/build pass.

---

# 36. P3 Handoff

P3 may assume:

```text
Business Context exists
First-party evidence exists
Pages / Queries exist
Keywords / Topics exist
Competitor search evidence exists
Keyword ownership exists
Signals exist
Opportunities exist
Evidence is traceable
```

P3 then adds:

```text
Evidence Assembler
→ Page Diagnosis Workflow
→ Diagnosis Findings
→ AI-assisted reasoning
→ Recommendation
→ Human Review
```
