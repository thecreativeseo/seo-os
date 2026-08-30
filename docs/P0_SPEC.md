# SEO OS — P0_SPEC.md

**Phase:** P0 — Foundation + Intelligent Onboarding  
**Goal:** Establish identity, tenancy, website context, business truth, governance, and connection architecture.

## 1. Product question

P0 must answer:

> Who is the user, which business and website are they authorized to operate on, what does the business explicitly say is true, what goals and rules govern SEO work, and which systems can SEO OS connect to later?

## 2. P0 journey

```text
Continue with Google
→ Organization
→ Workspace
→ Website/domain
→ Product / Service
→ Primary Customer
→ Primary Conversion
→ Main Market
→ Competitors
→ Business Goals
→ SEO Priorities
→ CMS
→ Connections
→ Review Context
→ Approve Context
→ Command Center
```

## 3. P0 scope

Implement:

- Google Sign-In
- authenticated sessions
- internal User
- Organization
- OrganizationMembership
- Workspace
- Website
- domain normalization
- resumable onboarding
- Business Goals
- Business Context + immutable versions
- Competitors
- Brand Facts
- SEO Rules
- Technical Context shell
- Connections provider registry/UI
- audit history
- setup-readiness Command Center
- tenant/security tests
- development seed support

## 4. P0 non-goals

Do not implement:

- live GSC ingestion
- live GA4 ingestion
- Semrush ingestion
- HubSpot ingestion
- Similarweb ingestion
- crawling automation
- keyword intelligence
- Page Diagnosis
- AI agents
- WordPress publishing
- n8n workflows
- MCP execution
- AI visibility tracking

## 5. Authentication

Primary login:

```text
Continue with Google
```

Authentication and authorization are separate:

```text
Google OAuth/OIDC
→ authenticated identity
→ internal SEO OS User
→ OrganizationMembership
→ authorized Workspace/Website
```

Matching an email domain must not automatically grant tenant access.

## 6. Tenant hierarchy

```text
Organization
  ↓
Workspace
  ↓
Website
```

Every tenant-owned record must be resolvable to an Organization.

Server-side authorization is mandatory.

## 7. Roles

```text
OWNER
ADMIN
SEO_LEAD
MEMBER
VIEWER
```

Keep RBAC simple in P0.

## 8. Initial internal identifiers

```text
Organization: The Creative SEO
Workspace: SEO Team
Website: thecreativeseo.com
```

Do not seed unconfirmed business facts.

## 9. Website

Minimum fields:

```text
id
workspace_id
name
domain
normalized_domain
canonical_url
website_type
cms_type
primary_market
primary_language
timezone
verification_status
status
created_at
updated_at
archived_at
```

Normalize:

```text
https://www.Example.com/
www.example.com
example.com/
```

to:

```text
example.com
```

Preserve meaningful subdomains.

Recommended unique key:

```text
(workspace_id, normalized_domain)
```

## 10. Onboarding

Order:

```text
1 Website
2 Product / Service
3 Primary Customer
4 Primary Conversion
5 Main Market
6 Competitors
7 Business Goals
8 SEO Priorities
9 CMS
10 Connections
11 Review
```

Onboarding must be:

- server-persisted
- resumable
- refresh-safe
- tenant-scoped
- server-validated

## 11. OnboardingSession

```text
id
organization_id
workspace_id
website_id
current_step
status
answers_json
started_by_user_id
started_at
completed_at
created_at
updated_at
```

Statuses:

```text
IN_PROGRESS
REVIEW
COMPLETED
ABANDONED
```

## 12. Business Goals

```text
id
website_id
title
description
period_start
period_end
business_objective
seo_outcome
primary_metric
leading_indicator
baseline
baseline_source
baseline_date
owner_user_id
status
created_at
updated_at
archived_at
```

Statuses:

```text
DRAFT
ACTIVE
MET
MISSED
RETIRED
```

Unknown baseline stays null.

## 13. Business Context

Use:

```text
BusinessContext
→ current_approved_version_id

BusinessContextVersion
→ immutable snapshot
```

Version fields should support:

```text
company_summary
product_service
business_model
primary_customer
buyer_roles
primary_market
languages
primary_conversion
secondary_conversions
business_priorities
seo_priorities
competitor_summary
differentiators
brand_voice
priority_topics
avoid_topics
approved_claims
prohibited_claims
owner_user_id
created_by_user_id
approved_by_user_id
status
version_number
created_at
approved_at
```

Statuses:

```text
DRAFT
IN_REVIEW
APPROVED
ARCHIVED
```

Approved versions are immutable.

## 14. Brand Facts

```text
id
website_id
category
fact_key
value
source
source_url
approval_status
owner_user_id
verified_at
created_at
updated_at
archived_at
```

Approval:

```text
PROPOSED
APPROVED
REJECTED
ARCHIVED
```

Only approved facts are canonical.

## 15. Competitors

```text
id
website_id
name
domain
normalized_domain
type
provided_by_user
source
notes
status
created_at
updated_at
archived_at
```

Types:

```text
DIRECT
ADJACENT
SEARCH
PUBLISHER
AGGREGATOR
UNKNOWN
```

P0 does not scrape or auto-classify them.

## 16. SEO Rules

```text
id
website_id
category
rule
severity
applies_to
owner_user_id
effective_from
active
created_at
updated_at
archived_at
```

Severities:

```text
INFO
WARNING
BLOCKING
```

## 17. Technical Context shell

```text
id
website_id
cms
hosting_notes
known_migrations
known_constraints
staging_available
developer_contact
publication_process
technical_notes
owner_user_id
created_at
updated_at
```

Do not infer crawl/indexation/technical health.

## 18. Connections framework

Show provider cards for:

```text
Google Search Console
Google Analytics 4
HubSpot
Semrush
Similarweb
Screaming Frog
WordPress
```

Statuses:

```text
NOT_CONNECTED
CONNECTING
CONNECTED
ERROR
REAUTH_REQUIRED
DISABLED
```

Connection stores a `credential_reference`, never plaintext credentials.

P0 must represent availability honestly:

```text
Coming in P1
Coming later
```

## 19. AuditEvent

```text
id
organization_id
workspace_id
website_id
actor_user_id
entity_type
entity_id
action
before_snapshot_json
after_snapshot_json
created_at
```

Audit important context/governance changes.

Never include secrets.

## 20. P0 Command Center

This is a setup dashboard, not an SEO analytics dashboard.

Show readiness for:

```text
Website
Business Context
Customer
Conversion
Market
Competitors
Goals
Brand Facts
SEO Rules
Connections
```

If showing a percentage, call it:

```text
Setup completion
```

not an SEO Score.

Show one deterministic Next Best Step.

## 21. Navigation

```text
COMMAND CENTER

WEBSITE
├── Overview
├── Business Goals
├── Business Context
├── Brand Facts
├── Competitors
└── SEO Rules

CONNECTIONS
└── Data & Publishing

WORKSPACE
├── Team
├── Audit History
└── Settings
```

## 22. P0 definition of done

P0 passes when:

- Google login works
- repeat login resolves same user
- membership controls authorization
- onboarding persists/resumes
- domain normalization works
- Business Goals work
- initial Business Context can be approved
- approved context cannot be mutated
- historical versions remain available
- Brand Facts work
- Competitors work
- SEO Rules work
- Connections screen works truthfully
- Audit History works
- Command Center readiness works
- sign out/sign in preserves data
- Tenant A cannot access Tenant B
- migrations/typecheck/lint/tests/build pass
