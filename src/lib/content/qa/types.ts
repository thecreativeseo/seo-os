/**
 * What the deterministic QA checks are given (M5 plan §3). The service reads
 * the database under the tenant's scope and hands the checks plain values;
 * the checks read nothing else. Every field here is something a result can
 * name as considered.
 */

export type ClaimRef =
  | { kind: "fact"; id: string }
  | { kind: "context"; id: string }
  | { kind: "unknown"; raw: string };

export type QaClaim = {
  text: string;
  evidenceId: string | null;
  /** Resolved by the service from the evidence id; null when no evidence was cited. */
  ref: ClaimRef | null;
};

export type QaSubject = {
  /** ContentWorkItemType, as a string so the checks stay free of the client. */
  workType: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  bodyMarkdown: string;
  claims: QaClaim[];
  /** What the writer said the piece covers, by heading. */
  sectionsCovered: string[];
};

export type QaFact = {
  id: string;
  value: string;
  /** APPROVED and not archived, as of QA time. */
  approved: boolean;
};

export type QaRule = {
  ruleId: string;
  rule: string;
  severity: "INFO" | "WARNING" | "BLOCKING";
  /** The machine check, when the rule has one. */
  check: unknown | null;
};

export type QaPage = {
  id: string;
  path: string;
  title: string | null;
  metaDescription: string | null;
  bodyText: string | null;
};

/** A claim the approved brief allowed, with the evidence it cited. */
export type QaBriefClaim = {
  text: string;
  evidenceId: string | null;
  ref: ClaimRef | null;
};

export type QaBrief = {
  requiredSections: string[];
  keyQuestions: string[];
  linkTargets: { pageId: string; path: string | null }[];
  /** Claims the approved brief allows. Each is held to its fact as of QA time. */
  approvedClaims: QaBriefClaim[];
  primaryKeyword: string | null;
  /** Secondary keywords with the pages that own them, for link suggestions. */
  secondaryKeywords: { keyword: string; pages: { pageId: string; path: string }[] }[];
  searchIntent: string | null;
  primaryConversion: string | null;
};

export type QaContext = {
  siteHost: string;
  facts: QaFact[];
  rules: QaRule[];
  contextVersion: { id: string; prohibitedClaims: string[]; avoidTopics: string[] } | null;
  brief: QaBrief;
  targetPage: QaPage | null;
  /** Every other page of the website with what was last captured of it. */
  otherPages: QaPage[];
  /** Whether an AI judge is available for the checks that need one. False in M5.1. */
  aiAvailable: boolean;
  checkerVersion: string;
};
