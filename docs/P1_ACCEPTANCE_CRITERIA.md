# SEO OS — P1_ACCEPTANCE_CRITERIA.md

**Release rule:** Metric integrity, provenance, and tenant isolation are release blocking.

## Connection separation

- [ ] Google login does not automatically connect GSC.
- [ ] Google login does not automatically connect GA4.
- [ ] GSC property selection is explicit.
- [ ] GA4 property selection is explicit.
- [ ] selected property maps only to an authorized Website.
- [ ] read-only permissions are used where possible.
- [ ] tokens are stored securely and not returned in normal APIs.

## Sync

- [ ] SyncRun created.
- [ ] valid state transitions.
- [ ] period recorded.
- [ ] records received/written recorded.
- [ ] idempotency key used.
- [ ] retry does not duplicate normalized metric rows.
- [ ] failed sync does not update freshness as if successful.
- [ ] errors are redacted.

## Pages

- [ ] unique `(website_id, normalized_url)`.
- [ ] tenant isolation.
- [ ] source first seen retained.
- [ ] sitemap presence does not imply indexation.
- [ ] meaningful URL distinctions preserved.

## Queries

- [ ] unique `(website_id, normalized_query)`.
- [ ] tenant isolation.
- [ ] first/last seen works.

## GSC metric integrity

- [ ] documented grain retained.
- [ ] unique constraint prevents duplicates.
- [ ] clicks retained.
- [ ] impressions retained.
- [ ] source connection retained.
- [ ] source snapshot retained.
- [ ] aggregate CTR = total clicks / total impressions.
- [ ] row CTR is not averaged.
- [ ] aggregate position does not use undocumented naive average.

Any metric-integrity failure = **P1 FAIL**.

## GA4 metric integrity

- [ ] landing page maps safely to Page.
- [ ] date retained.
- [ ] sessions retained when available.
- [ ] engagement retained when available.
- [ ] key events/conversions retained when available.
- [ ] revenue null if unavailable.
- [ ] no invented conversion values.
- [ ] source retained.

## Sitemap

- [ ] URL can be added/fetched.
- [ ] last success visible.
- [ ] URLs map into Page inventory.
- [ ] sitemap presence not mislabeled as indexed.

## Period comparison

- [ ] default 28d vs prior 28d correct.
- [ ] deltas correct.
- [ ] CTR recomputed correctly.
- [ ] zero-denominator safe.
- [ ] data freshness visible.

## Signals

Minimum demo signals:

```text
TRAFFIC_DECLINE
IMPRESSION_GROWTH
CTR_OPPORTUNITY
STRIKING_DISTANCE
PAGE_WINNER
PAGE_LOSER
```

For every signal:

- [ ] valid type.
- [ ] correct Website.
- [ ] detection date.
- [ ] comparison periods.
- [ ] evidence.
- [ ] observational language.
- [ ] no root-cause claim.
- [ ] can be reviewed/dismissed.

## Command Center

- [ ] data freshness.
- [ ] organic clicks from GSC.
- [ ] impressions from GSC.
- [ ] CTR calculated correctly.
- [ ] GA4 sessions separately labeled.
- [ ] conversions shown only if available.
- [ ] Attention section.
- [ ] Winners/Losers.
- [ ] Next Best Step links to a real signal/page.
- [ ] no AI diagnosis.

## Page Explorer

- [ ] search.
- [ ] sort.
- [ ] filters.
- [ ] date comparison.
- [ ] pagination.
- [ ] GSC metrics.
- [ ] GA4 metrics where available.
- [ ] Signals.
- [ ] tenant-safe queries.

## Page Detail

- [ ] URL identity.
- [ ] GSC performance.
- [ ] GA4 performance.
- [ ] top queries.
- [ ] active Signals.
- [ ] evidence/source freshness.
- [ ] no causal language.

## Query Explorer

- [ ] query.
- [ ] clicks.
- [ ] impressions.
- [ ] CTR.
- [ ] position.
- [ ] top Page.
- [ ] comparison.
- [ ] Signals.
- [ ] tenant isolation.

## Data Health

- [ ] source status.
- [ ] last success.
- [ ] latest data.
- [ ] coverage.
- [ ] errors.
- [ ] stale warning.
- [ ] no secrets.

## Demo Mode

If used:

- [ ] dedicated Demo Organization.
- [ ] dedicated Demo Workspace.
- [ ] dedicated demo Website.
- [ ] visible `DEMO DATA` indicator.
- [ ] no synthetic metrics in `thecreativeseo.com`.
- [ ] at least 90 days of comparison-capable data.
- [ ] multiple Pages and Queries.
- [ ] multiple Signals.
- [ ] demo seed is idempotent.

## Tenant security attack

Tenant A must not access Tenant B:

- [ ] GSC Connection
- [ ] GA4 Connection
- [ ] Page
- [ ] Query
- [ ] GscMetricDaily
- [ ] Ga4LandingPageMetricDaily
- [ ] Sitemap
- [ ] SourceSnapshot
- [ ] SyncRun
- [ ] Signal
- [ ] SignalEvidence

Any successful cross-tenant access = **P1 FAIL**.

## Build quality

```text
typecheck = PASS
lint = PASS
tests = PASS
migrations = PASS
production build = PASS
security tests = PASS
```
