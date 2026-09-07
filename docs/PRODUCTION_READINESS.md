# SEO OS — PRODUCTION_READINESS.md

Work that must be done before real customers, that no milestone owns yet.
Each item records what was found, why it matters, and what "done" looks like.
Nothing here is implemented by being written down.

---

## 1. Google OAuth is still in Testing

**Found:** 2026-09-07. A valid SEO OS user, with a valid membership, tried to
connect Google Search Console and was told by Google:

> The app has not completed the Google verification process. The app is
> currently being tested, and can only be accessed by developer-approved
> testers.

This is not an SEO OS authorization failure and not a tenant or team problem.
It is the Google OAuth application's **publishing status**, which is _Testing_.
In that state Google only lets accounts listed as test users complete the
consent flow, whatever SEO OS thinks of them.

**Operating procedure until this is resolved:**

```
Google Cloud Console
→ Google Auth Platform
→ Audience
→ Test users
```

The exact Google account that will connect Search Console or Analytics must be
listed there first. This is a manual, per-account step and is not acceptable
for a public launch.

**What production readiness must verify:**

1. Google sign-in identity stays conceptually separate from Search Console
   authorization and from Analytics authorization. Signing in proves who
   someone is; a connection is a separate grant, made per website, revocable
   on its own.
2. The production OAuth configuration carries correct app branding, a support
   and contact email, a verified production domain, a privacy policy, terms of
   service where Google requires them, the exact production redirect URIs, and
   only the minimum scopes SEO OS actually uses.
3. Every scope SEO OS requests is registered under Google Auth Platform → Data
   Access. A scope requested in code but not registered fails at consent time.
4. The verification classification of each final scope is determined for
   Search Console and for Analytics, because sensitive and restricted scopes
   carry different review requirements and timelines.
5. The production OAuth application is submitted for whatever verification
   those scopes require, and passes, before public customer onboarding.
6. A public SaaS launch does not depend on manually added test users.
7. Testing or staging and production OAuth projects and configuration are
   clearly separated where practical, so a change to one cannot break the
   other.
8. The Connections screen eventually tells these apart, in words a customer
   can act on: the OAuth app is still in testing and this account is not an
   approved tester; authorization was denied; the redirect URI does not match;
   a scope is not approved or configured; the token has expired;
   reauthorization is required.
9. OAuth access tokens, refresh tokens, authorization codes and full state
   payloads never appear in user-visible error messages or in audit records.
   The existing redaction in `src/lib/redact.ts` and the fixed error vocabulary
   in `src/app/api/connections/[provider]/callback/route.ts` are the pattern.

**Status:** recorded, not started. No code changed.
