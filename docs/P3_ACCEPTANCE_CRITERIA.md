# SEO OS — P3_ACCEPTANCE_CRITERIA.md

**Phase:** P3 — Evidence-Based AI Diagnosis + Recommendations

Automatic FAIL:

- cross-tenant evidence retrieval
- unsupported causal claim marked CONFIRMED
- forged/unauthorized human approval
- model output used for authorization
- secrets exposed to logs/model unnecessarily
- hallucinated evidence IDs accepted
- retrieved prompt injection overrides system rules

## Evidence / RAG
- [ ] EvidencePackage uses authorized Website only.
- [ ] Business Context version retained.
- [ ] exact evidence IDs retained.
- [ ] retrieval policy/version retained.
- [ ] first-party / provider / AI-inferred evidence distinguishable.
- [ ] EvidencePackage immutable after completed run.
- [ ] structured retrieval used for structured metrics.
- [ ] vector retrieval, if used, is tenant-scoped.
- [ ] retrieved content treated as untrusted data.

## AI Runs
- [ ] provider/model retained.
- [ ] PromptTemplate/version retained.
- [ ] output schema version retained.
- [ ] EvidencePackage link retained.
- [ ] failures redacted.
- [ ] no credentials in AI logs.

## Findings
- [ ] typed category/verdict/confidence.
- [ ] supporting evidence linked.
- [ ] contradicting evidence supported.
- [ ] missing evidence supported.
- [ ] UNKNOWN supported.
- [ ] unsupported finding cannot be CONFIRMED.
- [ ] nonexistent/cross-tenant evidence ID rejected.

## Recommendations
- [ ] evidence linked.
- [ ] confidence/effort/risk retained.
- [ ] respects Business Context/Brand Facts/SEO Rules.
- [ ] BLOCKING rule prevents silent approval.
- [ ] no unsupported traffic/revenue forecast.
- [ ] no execution in P3.

## Human Review
- [ ] APPROVE works for authorized reviewer.
- [ ] MODIFY works.
- [ ] REJECT works.
- [ ] REQUEST_MORE_EVIDENCE works.
- [ ] Decision user/time/reason retained.
- [ ] client cannot forge approval.
- [ ] AI cannot self-approve.

## UI
- [ ] Evidence tab.
- [ ] Diagnosis tab.
- [ ] Recommendations tab.
- [ ] History tab.
- [ ] Review Queue.
- [ ] P3 Command Center.
- [ ] evidence provenance visible.

## Demo Mode
- [ ] uses Demo Organization / Investor Demo / demo.example.
- [ ] DEMO DATA visible.
- [ ] ownership-conflict story.
- [ ] CTR/intent story.
- [ ] insufficient-evidence story.
- [ ] rule-constrained recommendation.
- [ ] no synthetic P3 records in thecreativeseo.com.

## Safety tests
- [ ] prompt injection in Page content.
- [ ] malicious instruction in competitor content.
- [ ] cross-tenant evidence ID.
- [ ] nonexistent evidence ID.
- [ ] contradictory evidence.
- [ ] insufficient evidence.
- [ ] blocking SEO Rule.

## Final gate

```text
typecheck = PASS
lint = PASS
tests = PASS
migrations = PASS
production build = PASS
tenant security tests = PASS
RAG safety tests = PASS
```

Final report:

```text
P3 STATUS:
PASS / FAIL / PASS WITH NON-BLOCKING TECHNICAL DEBT
```
