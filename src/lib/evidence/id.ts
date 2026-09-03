/**
 * Evidence identity (docs/P3_SPEC.md §9, §11, §36).
 *
 * The security keystone of P3, and the reason it is written before any schema.
 *
 * A model returns evidence IDs to justify what it says. Three of the seven
 * automatic-FAIL conditions concern those IDs: a hallucinated one, a cross-tenant
 * one, and one accepted without validation. All three close through the same
 * mechanism if — and only if — an evidence ID is *deterministic and
 * re-resolvable* rather than a token handed out and matched against a list.
 *
 * So an ID encodes what it points at:
 *
 *     gsc:page:<pageId>:2026-08-03..2026-08-30
 *     rank:<keywordId>:SEMRUSH:2026-08-30
 *     own:<ownershipId>
 *
 * Validating one is then not a lookup but a *scoped resolution*: parse it, then
 * fetch the row it names inside the requesting tenant's scope. An ID that does not
 * parse is refused here. An ID that parses but belongs to another tenant resolves
 * to nothing. An invented ID resolves to nothing. The same code path handles all
 * three, so none of them depends on somebody remembering a separate check.
 *
 * Two properties this module must hold, and its tests assert:
 *
 *   - **Total.** parse() never throws, whatever it is given. It receives strings
 *     written by a language model, which is to say strings shaped by whatever was
 *     in the evidence — including text an attacker put on a web page.
 *   - **Round-trip stable.** build(parse(x)) === x for every valid id, so the same
 *     evidence always produces the same identity and a package hash means
 *     something.
 */

/** The kinds of thing evidence can point at. Maps to P3_SPEC §9 evidence types. */
export type EvidenceKind =
  | "ctx" // approved Business Context version
  | "goal" // Business Goal
  | "fact" // Brand Fact
  | "rule" // SEO Rule
  | "gsc" // Search Console metrics over a window
  | "ga4" // Analytics metrics over a window
  | "kwm" // keyword metrics snapshot
  | "rank" // ranking snapshot
  | "own" // keyword ownership
  | "topic" // topic membership
  | "comp" // competitor observation
  | "content" // page content snapshot
  | "signal" // P1 signal
  | "opp" // P2 opportunity
  | "diag" // previous diagnosis
  | "dec"; // previous decision

/** What a windowed metric is grouped by. */
export type MetricSubject = "page" | "query" | "site";

export type EvidenceId =
  | { kind: "ctx"; contextVersionId: string }
  | { kind: "goal"; goalId: string }
  | { kind: "fact"; brandFactId: string }
  | { kind: "rule"; seoRuleId: string }
  | { kind: "gsc"; subject: MetricSubject; subjectId: string; start: string; end: string }
  | { kind: "ga4"; subject: MetricSubject; subjectId: string; start: string; end: string }
  | { kind: "kwm"; keywordId: string; provider: string; capturedAt: string }
  | { kind: "rank"; keywordId: string; provider: string; capturedAt: string }
  | { kind: "own"; ownershipId: string }
  | { kind: "topic"; topicId: string; keywordId: string | null }
  | {
      kind: "comp";
      competitorId: string;
      keywordId: string;
      provider: string;
      capturedAt: string;
    }
  | { kind: "content"; pageId: string; contentHash: string }
  | { kind: "signal"; signalId: string }
  | { kind: "opp"; opportunityId: string }
  | { kind: "diag"; diagnosisId: string }
  | { kind: "dec"; decisionId: string };

/**
 * Deliberately strict.
 *
 * A UUID pattern rather than "any string": an identifier is going into a database
 * query, and while Prisma parameterises it, refusing a malformed one here means a
 * hostile value never reaches the query layer at all. Defence in depth costs one
 * regex.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Provider names are our own enum; uppercase and underscores only. */
const PROVIDER = /^[A-Z][A-Z_]{1,40}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * The longest an evidence ID can be.
 *
 * A model can return anything, including a megabyte of text where an ID belongs.
 * Bounding the input before parsing keeps a hostile payload from becoming a
 * performance problem.
 */
export const MAX_ID_LENGTH = 200;

const isUuid = (value: string | undefined): value is string =>
  typeof value === "string" && UUID.test(value);

const isDate = (value: string | undefined): value is string =>
  typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));

const isProvider = (value: string | undefined): value is string =>
  typeof value === "string" && PROVIDER.test(value);

const isSubject = (value: string | undefined): value is MetricSubject =>
  value === "page" || value === "query" || value === "site";

function parseWindow(value: string | undefined): { start: string; end: string } | null {
  if (typeof value !== "string") return null;

  const parts = value.split("..");
  if (parts.length !== 2) return null;

  const [start, end] = parts;
  if (!isDate(start) || !isDate(end)) return null;
  // An inverted window would silently retrieve nothing and look like an absence
  // of data rather than a malformed request.
  if (start > end) return null;

  return { start, end };
}

/**
 * Reads an evidence ID.
 *
 * Total by construction: every path returns either a value or null, and nothing
 * here throws. Callers treat null as "this evidence does not exist", which is the
 * correct handling for a hallucinated ID and a hostile one alike.
 */
export function parseEvidenceId(raw: unknown): EvidenceId | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return null;

  const parts = value.split(":");
  const kind = parts[0];

  switch (kind) {
    case "ctx":
      return parts.length === 2 && isUuid(parts[1])
        ? { kind, contextVersionId: parts[1] }
        : null;

    case "goal":
      return parts.length === 2 && isUuid(parts[1]) ? { kind, goalId: parts[1] } : null;

    case "fact":
      return parts.length === 2 && isUuid(parts[1])
        ? { kind, brandFactId: parts[1] }
        : null;

    case "rule":
      return parts.length === 2 && isUuid(parts[1]) ? { kind, seoRuleId: parts[1] } : null;

    case "gsc":
    case "ga4": {
      if (parts.length !== 4) return null;
      const [, subject, subjectId] = parts;
      const window = parseWindow(parts[3]);

      if (!isSubject(subject) || !window) return null;
      // A site-wide window names no row, and "site" is the only subject allowed
      // to carry a placeholder identifier.
      if (subject === "site") {
        return subjectId === "-"
          ? { kind, subject, subjectId: "-", start: window.start, end: window.end }
          : null;
      }

      return isUuid(subjectId)
        ? { kind, subject, subjectId, start: window.start, end: window.end }
        : null;
    }

    case "kwm":
    case "rank": {
      if (parts.length !== 4) return null;
      const [, keywordId, provider, capturedAt] = parts;

      return isUuid(keywordId) && isProvider(provider) && isDate(capturedAt)
        ? { kind, keywordId, provider, capturedAt }
        : null;
    }

    case "own":
      return parts.length === 2 && isUuid(parts[1])
        ? { kind, ownershipId: parts[1] }
        : null;

    case "topic": {
      if (parts.length === 2) {
        return isUuid(parts[1]) ? { kind, topicId: parts[1], keywordId: null } : null;
      }
      if (parts.length === 3) {
        return isUuid(parts[1]) && isUuid(parts[2])
          ? { kind, topicId: parts[1], keywordId: parts[2] }
          : null;
      }
      return null;
    }

    case "comp": {
      if (parts.length !== 5) return null;
      const [, competitorId, keywordId, provider, capturedAt] = parts;

      return isUuid(competitorId) &&
        isUuid(keywordId) &&
        isProvider(provider) &&
        isDate(capturedAt)
        ? { kind, competitorId, keywordId, provider, capturedAt }
        : null;
    }

    case "content": {
      if (parts.length !== 3) return null;
      const [, pageId, contentHash] = parts;

      return isUuid(pageId) && typeof contentHash === "string" && SHA256.test(contentHash)
        ? { kind, pageId, contentHash: contentHash.toLowerCase() }
        : null;
    }

    case "signal":
      return parts.length === 2 && isUuid(parts[1]) ? { kind, signalId: parts[1] } : null;

    case "opp":
      return parts.length === 2 && isUuid(parts[1])
        ? { kind, opportunityId: parts[1] }
        : null;

    case "diag":
      return parts.length === 2 && isUuid(parts[1])
        ? { kind, diagnosisId: parts[1] }
        : null;

    case "dec":
      return parts.length === 2 && isUuid(parts[1]) ? { kind, decisionId: parts[1] } : null;

    default:
      return null;
  }
}

/** Writes an evidence ID. The inverse of parse, and asserted to be so. */
export function buildEvidenceId(id: EvidenceId): string {
  switch (id.kind) {
    case "ctx":
      return `ctx:${id.contextVersionId}`;
    case "goal":
      return `goal:${id.goalId}`;
    case "fact":
      return `fact:${id.brandFactId}`;
    case "rule":
      return `rule:${id.seoRuleId}`;
    case "gsc":
    case "ga4":
      return `${id.kind}:${id.subject}:${id.subjectId}:${id.start}..${id.end}`;
    case "kwm":
    case "rank":
      return `${id.kind}:${id.keywordId}:${id.provider}:${id.capturedAt}`;
    case "own":
      return `own:${id.ownershipId}`;
    case "topic":
      return id.keywordId === null
        ? `topic:${id.topicId}`
        : `topic:${id.topicId}:${id.keywordId}`;
    case "comp":
      return `comp:${id.competitorId}:${id.keywordId}:${id.provider}:${id.capturedAt}`;
    case "content":
      return `content:${id.pageId}:${id.contentHash}`;
    case "signal":
      return `signal:${id.signalId}`;
    case "opp":
      return `opp:${id.opportunityId}`;
    case "diag":
      return `diag:${id.diagnosisId}`;
    case "dec":
      return `dec:${id.decisionId}`;
  }
}

/** True when a string is a well-formed evidence ID. Says nothing about existence. */
export function isEvidenceId(raw: unknown): boolean {
  return parseEvidenceId(raw) !== null;
}

/**
 * Filters a model's evidence IDs down to the well-formed ones.
 *
 * Returns what was kept and what was rejected, because a rejected ID is worth
 * showing rather than silently dropping: it is the visible trace of the model
 * having invented something, and a reviewer is entitled to see it.
 */
export function partitionEvidenceIds(raw: unknown[]): {
  valid: { raw: string; id: EvidenceId }[];
  invalid: string[];
} {
  const valid: { raw: string; id: EvidenceId }[] = [];
  const invalid: string[] = [];

  for (const candidate of raw) {
    const parsed = parseEvidenceId(candidate);

    if (parsed) {
      valid.push({ raw: buildEvidenceId(parsed), id: parsed });
    } else {
      // Truncated: this is going into a database column and onto a screen, and it
      // is a string an attacker may have influenced.
      invalid.push(
        typeof candidate === "string"
          ? candidate.slice(0, 120)
          : `<${typeof candidate}>`,
      );
    }
  }

  return { valid, invalid };
}

/** The scope an ID belongs to, for a resolver to check. Filled in at D4. */
export const EVIDENCE_KINDS: EvidenceKind[] = [
  "ctx",
  "goal",
  "fact",
  "rule",
  "gsc",
  "ga4",
  "kwm",
  "rank",
  "own",
  "topic",
  "comp",
  "content",
  "signal",
  "opp",
  "diag",
  "dec",
];
