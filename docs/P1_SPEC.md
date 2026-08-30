# SEO OS — P1_SPEC.md

**Phase:** P1 — First-Party Search & Analytics Intelligence  
**Depends on:** P0  
**Goal:** Connect first-party evidence to pages, queries, changes, and operational signals.

## 1. Product question

P1 answers:

> What is actually happening in organic search and on the website?

P1 lifecycle:

```text
CONNECT
→ INGEST
→ NORMALIZE
→ TRACE TO PAGE / QUERY
→ COMPARE
→ DETECT
→ SURFACE SIGNAL
```

P1 does not perform causal AI diagnosis.

## 2. P1 scope

Implement:

- GSC connection architecture
- GA4 connection architecture
- sitemap ingestion
- provider/property selection
- read-only source permissions
- SyncRun
- SourceSnapshot
- Page
- Query
- GSC daily metrics
- GA4 landing-page daily metrics
- Page Explorer
- Page Detail
- Query Explorer
- Data Health
- period comparison
- deterministic Signals
- SignalEvidence
- P1 Command Center
- investor Demo Mode
- tenant/security tests

## 3. P1 non-goals

Do not implement:

- Semrush
- Similarweb
- HubSpot CRM/pipeline
- Screaming Frog automation
- full Keyword Master
- Topic clusters
- Page Diagnosis Agent
- Content Brief Agent
- WordPress publishing
- experiments
- AI visibility
- P2/P3/P4 logic

## 4. Google identity vs data access

P0 Google login proves identity.

P1 GSC/GA4 authorizations are separate.

```text
Google Sign-In → identity

GSC OAuth → authorized Search Console property
GA4 OAuth → authorized Analytics property
```

Never mark GSC/GA4 connected merely because the user signed in with Google.

## 5. Demo modes

### Live Mode

Real authorized first-party data.

### Demo Mode

Synthetic data in a dedicated workspace only:

```text
Demo Organization
→ Investor Demo
→ demo.example
```

Display:

```text
DEMO DATA
```

Never place synthetic SEO metrics in:

```text
The Creative SEO
→ SEO Team
→ thecreativeseo.com
```

## 6. Page

```text
id
website_id
url
normalized_url
path
hostname
protocol
page_type
content_type
source_first_seen
first_seen_at
last_seen_at
sitemap_present
status
created_at
updated_at
archived_at
```

Unique:

```text
(website_id, normalized_url)
```

## 7. Query

```text
id
website_id
query
normalized_query
first_seen_at
last_seen_at
created_at
updated_at
```

Unique:

```text
(website_id, normalized_query)
```

## 8. GSC daily metric grain

Use:

```text
website
date
page
query
country
device
search_type
```

Model:

```text
GscMetricDaily
id
website_id
page_id
query_id
date
country
device
search_type
clicks
impressions
ctr
position
source_connection_id
source_snapshot_id
created_at
updated_at
```

Unique key should prevent duplicate metric rows for the documented grain.

### Aggregation rules

Clicks:

```text
SUM(clicks)
```

Impressions:

```text
SUM(impressions)
```

CTR:

```text
SUM(clicks) / SUM(impressions)
```

Do not average row CTR.

Do not use undocumented naive average position.

## 9. GA4 landing-page metrics

```text
Ga4LandingPageMetricDaily
id
website_id
page_id
date
sessions
engaged_sessions
users
new_users
key_events
conversions
revenue
source_connection_id
source_snapshot_id
created_at
updated_at
```

Unavailable values remain null.

Do not invent conversions or revenue.

## 10. SourceSnapshot

```text
id
website_id
connection_id
provider
captured_at
period_start
period_end
object_storage_key
checksum
metadata_json
created_at
```

Never store tokens in snapshots.

## 11. SyncRun

```text
id
website_id
connection_id
provider
sync_type
status
period_start
period_end
started_at
finished_at
records_received
records_written
records_skipped
error_code
error_summary
idempotency_key
created_at
```

Statuses:

```text
QUEUED
RUNNING
SUCCEEDED
PARTIAL
FAILED
CANCELLED
```

Syncs must be idempotent and retry-safe.

## 12. Sitemap

Support:

- manual sitemap URL
- fetch status
- last successful fetch
- URL count
- mapping discovered URLs into Page inventory

Sitemap presence is not proof of indexation.

## 13. Date comparison

Default:

```text
Last 28 days
vs
Previous 28 days
```

Also support:

```text
7d
28d
90d
custom
```

Expose:

```text
current
previous
absolute change
percentage change
data freshness
```

If prior denominator is zero, show a safe state such as `New`.

## 14. Signals

Signals are observations, not diagnoses.

Initial types:

```text
TRAFFIC_DECLINE
TRAFFIC_GROWTH
IMPRESSION_GROWTH
CTR_OPPORTUNITY
STRIKING_DISTANCE
PAGE_WINNER
PAGE_LOSER
QUERY_WINNER
QUERY_LOSER
DATA_FRESHNESS_RISK
```

Investor-demo minimum:

```text
TRAFFIC_DECLINE
IMPRESSION_GROWTH
CTR_OPPORTUNITY
STRIKING_DISTANCE
PAGE_WINNER
PAGE_LOSER
```

## 15. Signal model

```text
id
website_id
type
status
severity
page_id
query_id
detected_at
current_period_start
current_period_end
comparison_period_start
comparison_period_end
score
scoring_model_version
headline
summary
evidence_json
created_at
updated_at
resolved_at
```

Statuses:

```text
DETECTED
REVIEWED
DISMISSED
PROMOTED
RESOLVED
```

## 16. SignalEvidence

```text
id
signal_id
evidence_type
source_entity_type
source_entity_id
metric_key
current_value
previous_value
period_start
period_end
created_at
```

Every signal must be explainable from persisted data.

## 17. Command Center

P1 changes the Command Center from:

> What is missing from setup?

to:

> What changed?

Recommended sections:

```text
Data freshness

Executive snapshot
- Organic clicks
- Impressions
- CTR
- Organic sessions
- Conversions if available

Attention
- Traffic declines
- CTR opportunities
- Striking-distance queries
- Data freshness risks

Winners
Losers

Next Best Step
```

## 18. Page Explorer

Columns:

```text
Page
Clicks
Δ Clicks
Impressions
Δ Impressions
CTR
Δ CTR
Position
Organic Sessions
Conversions
Signals
Last Seen
```

Support:

- search
- sort
- filter
- date range
- comparison
- pagination

## 19. Page Detail

Sections:

```text
Identity
Search Performance
Analytics
Top Queries
Active Signals
Evidence / source freshness
```

Do not show causal diagnosis.

## 20. Query Explorer

Columns:

```text
Query
Clicks
Δ Clicks
Impressions
Δ Impressions
CTR
Position
Top Page
Signals
```

## 21. Data Health

Show:

```text
Source
Connection status
Selected property
Last successful sync
Latest data date
Coverage
Errors
```

## 22. Navigation

```text
COMMAND CENTER

INTELLIGENCE
├── Pages
├── Queries
└── Signals

WEBSITE
├── Business Goals
├── Business Context
├── Brand Facts
├── Competitors
└── SEO Rules

CONNECTIONS
├── Data Sources
└── Data Health

WORKSPACE
├── Team
├── Audit History
└── Settings
```

## 23. Background jobs

Conceptual jobs:

```text
gsc.sync
ga4.sync
sitemap.fetch
metrics.refresh
signals.detect
```

Do not make the browser the durable job engine.

## 24. Demo dataset

If live data is unavailable, create in the Demo Workspace:

```text
90 days
20–40 Pages
100–300 Queries
GSC-like first-party fixture metrics
GA4-like landing-page fixture metrics
5–10 Signals
```

Demo stories:

```text
1 meaningful traffic decline
1 strong winner
2 CTR opportunities
3 striking-distance queries
1 conversion decline
```

All clearly labeled DEMO DATA.

## 25. P1 definition of done

P1 passes when:

- GSC/GA4 connection architecture is secure
- Live Mode or documented Demo Mode works
- Page/Query entities work
- source provenance exists
- sync runs are idempotent
- GSC metrics aggregate correctly
- GA4 metrics preserve source/date
- sitemap works
- Page Explorer works
- Page Detail works
- Query Explorer works
- deterministic Signals work
- Signals preserve evidence
- data freshness is visible
- no causal diagnosis is claimed
- Tenant A cannot access Tenant B data
- typecheck/lint/tests/migrations/build pass

## 26. P2 handoff

P2 can assume:

```text
Business context exists
Pages exist
Queries exist
First-party performance exists
Signals exist
Provenance exists
```

P2 then adds:

```text
Semrush
→ Keywords
→ Topics
→ Competitor search intelligence
→ Keyword/Page ownership
→ Opportunity Engine
```
