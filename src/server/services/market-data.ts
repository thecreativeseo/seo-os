import { prisma } from "@/server/db/prisma";
import type { TenantContext } from "@/server/auth/guards";
import { mapIntent, type NormalizedImportRow } from "@/lib/import/formats";
import { normalizeUrl } from "@/lib/url/normalize-url";
import type { ConnectionProvider } from "@/generated/prisma/client";

/**
 * Writing third-party market data (docs/P2_SPEC.md §7).
 *
 * One write path, two ways in. A Semrush figure can reach this product as a CSV
 * somebody exported or as a row the API returned, and P2_SPEC §7 treats those as
 * two modes of the same thing rather than two features. This is where that
 * becomes literally true: both arrive as `NormalizedImportRow` and go through the
 * code below, so a keyword created by a live sync is indistinguishable from one
 * created by an upload — same identity rules, same intent-provenance rules, same
 * snapshot keys, same refusal to invent a Page.
 *
 * The alternative was a second write path for the connector, which would have
 * meant maintaining two implementations of "is this the same keyword" and
 * discovering they had drifted the first time a customer used both.
 *
 * Attribution is the one thing that differs, and it is a parameter: an uploaded
 * row records the Import it came from, a fetched row records the Connection. Both
 * columns have existed on the snapshot tables since P2 for exactly this reason.
 */

/**
 * Where a row came from. Exactly one of these, never both, never neither.
 *
 * The connection variant also carries the specific pull, when there is one. A
 * connection says which account reported the figure; a snapshot says which
 * request did, which is what makes "why did this number change on Tuesday"
 * answerable rather than merely askable.
 */
export type RowAttribution =
  | { kind: "import"; importId: string }
  | { kind: "connection"; connectionId: string; snapshotId?: string };

export type PersistOptions = {
  /**
   * The vendor whose numbers these are, or null for a hand-written list.
   *
   * Null means keywords are created and no snapshot is: no provider value
   * honestly describes a CSV somebody typed, and attributing those figures to a
   * vendor would credit a measurement to a company that never made it.
   */
  provider: ConnectionProvider | null;
  attribution: RowAttribution;
  /** Used for rows that carry no date of their own. */
  fallbackCapturedAt: string;
  /**
   * Competitor rows are matched against the website's competitor list; a row
   * about a domain nobody added is skipped rather than adopted.
   */
  competitors?: { id: string; normalizedDomain: string | null; domain: string | null }[];
  /** Competitor reports write a different table. */
  mode?: "keywords" | "competitors";
};

export type PersistResult = {
  keywordsCreated: number;
  metricsWritten: number;
  rankingsWritten: number;
  competitorRowsWritten: number;
  skipped: number;
};

/**
 * Upserts keywords, metrics and rankings for a batch of normalized rows.
 *
 * Snapshots are keyed on (entity, capturedAt, provider) and upserted, so running
 * the same batch twice updates in place. That is what makes a retry after a
 * partial failure safe rather than merely tolerable — and it is why a daily sync
 * can re-fetch an overlapping window without doubling every reading.
 */
export async function persistMarketRows(
  context: TenantContext,
  rows: NormalizedImportRow[],
  options: PersistOptions,
): Promise<PersistResult> {
  const result: PersistResult = {
    keywordsCreated: 0,
    metricsWritten: 0,
    rankingsWritten: 0,
    competitorRowsWritten: 0,
    skipped: 0,
  };

  const attribution =
    options.attribution.kind === "import"
      ? { sourceImportId: options.attribution.importId }
      : {
          sourceConnectionId: options.attribution.connectionId,
          sourceSnapshotId: options.attribution.snapshotId,
        };

  for (const row of rows) {
    const keyword = await upsertKeyword(context, row);
    if (keyword.created) result.keywordsCreated += 1;

    if (options.provider === null) continue;

    const capturedAt = new Date(`${row.capturedAt ?? options.fallbackCapturedAt}T00:00:00.000Z`);

    if (options.mode === "competitors") {
      const competitor = matchCompetitor(options.competitors ?? [], row.domain);

      if (!competitor) {
        // A row about a domain nobody added as a competitor is not silently
        // adopted: competitors are a deliberate P0 list, not an import artefact.
        result.skipped += 1;
        continue;
      }

      await prisma.competitorKeywordSnapshot.upsert({
        where: {
          competitorId_keywordId_capturedAt_sourceProvider: {
            competitorId: competitor.id,
            keywordId: keyword.id,
            capturedAt,
            sourceProvider: options.provider,
          },
        },
        update: { position: row.position, rankingUrl: row.landingUrl, ...attribution },
        create: {
          websiteId: context.website.id,
          competitorId: competitor.id,
          keywordId: keyword.id,
          capturedAt,
          position: row.position,
          rankingUrl: row.landingUrl,
          sourceProvider: options.provider,
          ...attribution,
        },
      });

      result.competitorRowsWritten += 1;
      continue;
    }

    if (row.searchVolume !== null || row.keywordDifficulty !== null || row.cpc !== null) {
      await prisma.keywordMetricsSnapshot.upsert({
        where: {
          keywordId_capturedAt_sourceProvider: {
            keywordId: keyword.id,
            capturedAt,
            sourceProvider: options.provider,
          },
        },
        update: {
          searchVolume: row.searchVolume,
          keywordDifficulty: row.keywordDifficulty,
          cpc: row.cpc,
          ...attribution,
        },
        create: {
          websiteId: context.website.id,
          keywordId: keyword.id,
          capturedAt,
          // Null where the source said nothing. A zero would be a measurement
          // nobody took.
          searchVolume: row.searchVolume,
          keywordDifficulty: row.keywordDifficulty,
          cpc: row.cpc,
          sourceProvider: options.provider,
          ...attribution,
        },
      });

      result.metricsWritten += 1;
    }

    if (row.position !== null) {
      const pageId = await resolvePageId(context, row.landingUrl);

      await prisma.rankingSnapshot.upsert({
        where: {
          keywordId_capturedAt_sourceProvider: {
            keywordId: keyword.id,
            capturedAt,
            sourceProvider: options.provider,
          },
        },
        update: {
          position: row.position,
          previousPosition: row.previousPosition,
          rankingUrl: row.landingUrl,
          rankingType: row.rankingType,
          pageId,
          ...attribution,
        },
        create: {
          websiteId: context.website.id,
          keywordId: keyword.id,
          // Null when the ranking URL is not in our Page inventory, and the raw
          // URL is kept. That null is information: Google is ranking something we
          // do not know about.
          pageId,
          capturedAt,
          position: row.position,
          previousPosition: row.previousPosition,
          rankingUrl: row.landingUrl,
          rankingType: row.rankingType,
          serpFeaturesJson: row.serpFeatures.length > 0 ? row.serpFeatures : undefined,
          sourceProvider: options.provider,
          ...attribution,
        },
      });

      result.rankingsWritten += 1;
    }
  }

  return result;
}

/**
 * Finds or creates the Keyword a row is about.
 *
 * Identity is (website, normalized keyword, locale, language, market) per
 * P2_SPEC §8 — deliberately not one global keyword per string, because "insurance"
 * in en-PH and en-US are different markets with different volumes and the same
 * word.
 */
export async function upsertKeyword(
  context: TenantContext,
  row: NormalizedImportRow,
): Promise<{ id: string; created: boolean }> {
  const language = (context.website.primaryLanguage ?? "en").toLowerCase();
  const market = (context.website.primaryMarket ?? "PH").toUpperCase();
  const locale = `${language}-${market}`;

  const identity = {
    websiteId: context.website.id,
    normalizedKeyword: row.normalizedKeyword,
    locale,
    language,
    market,
  };

  const existing = await prisma.keyword.findUnique({
    where: { websiteId_normalizedKeyword_locale_language_market: identity },
  });

  if (existing) {
    const intent = mapIntent(row.intent);

    await prisma.keyword.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        // An intent a person set is never overwritten by a provider: their
        // judgement is the more expensive of the two to reproduce.
        ...(existing.intentProvenance === "USER_PROVIDED" || intent === "UNKNOWN"
          ? {}
          : {
              intent,
              intentProvenance: "PROVIDER_PROVIDED",
            }),
      },
    });

    return { id: existing.id, created: false };
  }

  const intent = mapIntent(row.intent);

  const created = await prisma.keyword.create({
    data: {
      ...identity,
      keyword: row.keyword,
      intent,
      intentProvenance: intent === "UNKNOWN" ? "UNKNOWN" : "PROVIDER_PROVIDED",
    },
  });

  return { id: created.id, created: true };
}

/**
 * Maps a ranking URL onto a Page we already know about.
 *
 * Deliberately does not create one. A Page is our inventory of this website; a
 * ranking URL is a third party's claim about what Google showed. Creating pages
 * from the second would let a provider invent inventory.
 */
export async function resolvePageId(
  context: TenantContext,
  landingUrl: string | null,
): Promise<string | null> {
  if (!landingUrl) return null;

  const normalized = normalizeUrl(landingUrl, context.website.normalizedDomain);
  if (!normalized.ok) return null;

  const page = await prisma.page.findFirst({
    where: { websiteId: context.website.id, normalizedUrl: normalized.value.normalized },
    select: { id: true },
  });

  return page?.id ?? null;
}

export function matchCompetitor(
  competitors: { id: string; normalizedDomain: string | null; domain: string | null }[],
  domain: string | null,
): { id: string } | null {
  if (!domain) return null;

  const candidate = domain.trim().toLowerCase().replace(/^www\./, "");

  return (
    competitors.find((competitor) => {
      const known = (competitor.normalizedDomain ?? competitor.domain ?? "")
        .toLowerCase()
        .replace(/^www\./, "");
      return known !== "" && known === candidate;
    }) ?? null
  );
}
