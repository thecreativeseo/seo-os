import { createHash } from "node:crypto";

import type { Import, ImportRow, ImportSource, Prisma } from "@/generated/prisma/client";

import { prisma } from "@/server/db/prisma";
import { recordAudit } from "@/server/audit/record";
import { websiteScope, type TenantContext } from "@/server/auth/guards";
import { CSV_PARSE_ERROR_MESSAGES, MAX_CSV_ROWS, parseCsv } from "@/lib/import/csv";
import {
  detectFormat,
  IMPORT_SOURCE_LABELS,
  mapRow,
  providerForSource,
  type NormalizedImportRow,
} from "@/lib/import/formats";
import { persistMarketRows } from "@/server/services/market-data";

/**
 * The import pipeline (docs/P2_SPEC.md §28).
 *
 * Upload → identify → parse → validate → preview → commit, and nothing reaches a
 * live table until a person has seen the preview. That ordering is the whole
 * design: an import is somebody handing the product a file full of numbers that
 * will go on to drive prioritization, and the expensive failure is not a crash but
 * a plausible-looking wrong number nobody questioned.
 *
 * Three properties hold throughout:
 *
 *   - **The website comes from the resolved tenant context, never from the file
 *     or the form.** A row cannot name a website, and a changed id in a request
 *     resolves through the guard to nothing.
 *   - **A row that cannot be understood is reported, not repaired.** Guessing at
 *     a missing keyword or an unparseable position would put a number in the
 *     product that nobody measured.
 *   - **The same file twice is the same import.** Checksum identity makes a retry
 *     safe, and snapshot keys make a re-commit an update rather than a duplicate.
 */

export type ImportErrorCode =
  | "empty_file"
  | "too_large"
  | "unsupported_type"
  | "unreadable"
  | "unrecognised_format"
  | "provider_required"
  | "wrong_state"
  | "not_found"
  | "no_valid_rows";

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportErrorCode,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/** Comfortably above a large Semrush export, well below anything alarming. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const ALLOWED_EXTENSIONS = [".csv", ".txt"];

/**
 * Rejects a file before it is read.
 *
 * Extension and size only — the content type a browser reports is supplied by the
 * client and is not evidence of anything.
 */
export function validateUpload(
  fileName: string,
  byteSize: number,
): { ok: true } | { ok: false; code: ImportErrorCode } {
  const lower = fileName.toLowerCase();

  if (!ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return { ok: false, code: "unsupported_type" };
  }

  if (byteSize === 0) return { ok: false, code: "empty_file" };
  if (byteSize > MAX_IMPORT_BYTES) return { ok: false, code: "too_large" };

  return { ok: true };
}

export function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export type UploadResult = {
  record: Import;
  detected: { source: ImportSource; label: string; confidence: number } | null;
  /** True when this checksum was already imported for this website. */
  duplicate: boolean;
};

/**
 * Stages a file: stores it, identifies the format, parses every row.
 *
 * Rows land in ImportRow as text. Nothing is coerced yet, so a malformed number is
 * a row somebody can look at rather than an import that failed as a whole.
 */
export async function uploadImport(
  context: TenantContext,
  input: { fileName: string; content: string; source?: ImportSource; capturedAt?: string },
): Promise<UploadResult> {
  const byteSize = Buffer.byteLength(input.content, "utf8");
  const allowed = validateUpload(input.fileName, byteSize);

  if (!allowed.ok) {
    throw new ImportError(IMPORT_ERROR_MESSAGES[allowed.code], allowed.code);
  }

  const checksum = checksumOf(input.content);

  const existing = await prisma.import.findFirst({
    where: { checksum, ...websiteScope(context) },
  });

  if (existing) {
    // Re-uploading the same file returns the import it already produced rather
    // than a second one competing with it.
    return {
      record: existing,
      detected: {
        source: existing.source,
        label: IMPORT_SOURCE_LABELS[existing.source],
        confidence: 1,
      },
      duplicate: true,
    };
  }

  const parsed = parseCsv(input.content, MAX_CSV_ROWS);

  if (!parsed.ok) {
    throw new ImportError(CSV_PARSE_ERROR_MESSAGES[parsed.reason], "unreadable");
  }

  const detected = input.source
    ? { source: input.source, label: IMPORT_SOURCE_LABELS[input.source], confidence: 1 }
    : detectFormat(parsed.headers);

  if (!detected) {
    throw new ImportError(
      "That file does not look like a keyword export. Check the column headings.",
      "unrecognised_format",
    );
  }

  const source = detected.source;

  if (!source) {
    // The file carries volume, difficulty or positions, but nothing in it says
    // whose they are. Three things could be done here and only one is honest:
    // guess a vendor (attributes a difficulty score to the wrong scale, and the
    // mistake is invisible afterwards), treat it as a plain keyword list (drops
    // every metric silently, looking like a successful import of far less data),
    // or say so and ask. The third costs one click.
    throw new ImportError(
      "This looks like a keyword export, but nothing in it names Semrush or Ahrefs. Choose the format and upload again.",
      "provider_required",
    );
  }

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.import.create({
      data: {
        websiteId: context.website.id,
        source,
        status: "PARSING",
        fileName: input.fileName,
        checksum,
        byteSize,
        rowCount: parsed.rows.length,
        // Retained so the import stays auditable: what was claimed, in the words
        // of the file, rather than only our reading of it.
        rawContent: input.content,
        capturedAt: input.capturedAt ? new Date(`${input.capturedAt}T00:00:00.000Z`) : null,
        uploadedByUserId: context.user.id,
        startedAt: new Date(),
      },
    });

    if (parsed.rows.length > 0) {
      await tx.importRow.createMany({
        data: parsed.rows.map((row, index) => ({
          importId: created.id,
          rowNumber: index + 1,
          rawJson: row as Prisma.InputJsonValue,
        })),
      });
    }

    await recordAudit(tx, context, {
      entityType: "Import",
      entityId: created.id,
      action: "CREATE",
      after: {
        fileName: input.fileName,
        source,
        rowCount: parsed.rows.length,
      },
    });

    return created;
  });

  return { record, detected: { ...detected, source }, duplicate: false };
}

export type PreviewRow = {
  rowNumber: number;
  valid: boolean;
  reason: string | null;
  keyword: string | null;
  position: number | null;
  searchVolume: number | null;
  landingUrl: string | null;
};

export type ImportPreview = {
  record: Import;
  headers: string[];
  totals: { rows: number; valid: number; invalid: number; distinctKeywords: number };
  /** A sample of what will be written, plus every row that will not be. */
  sample: PreviewRow[];
  invalid: PreviewRow[];
};

function headersOf(rows: Pick<ImportRow, "rawJson">[]): string[] {
  const first = rows[0]?.rawJson;
  return first && typeof first === "object" && !Array.isArray(first)
    ? Object.keys(first as Record<string, unknown>)
    : [];
}

/**
 * Validates every staged row and records the outcome, then returns what a person
 * needs to decide whether to commit.
 *
 * Deliberately re-runnable: validating twice produces the same answer, and the
 * preview is read from stored state rather than recomputed at render time.
 */
export async function validateImport(
  context: TenantContext,
  importId: string,
): Promise<ImportPreview> {
  const record = await requireImport(context, importId);

  const rows = await prisma.importRow.findMany({
    where: { importId: record.id },
    orderBy: { rowNumber: "asc" },
  });

  const headers = headersOf(rows);
  const fallbackCapturedAt = (record.capturedAt ?? record.createdAt).toISOString().slice(0, 10);

  const results: { row: ImportRow; mapped: ReturnType<typeof mapRow> }[] = rows.map((row) => ({
    row,
    mapped: mapRow(row.rawJson as Record<string, string>, {
      headers,
      language: context.website.primaryLanguage,
      market: context.website.primaryMarket,
      fallbackCapturedAt,
    }),
  }));

  const distinctKeywords = new Set(
    results.flatMap(({ mapped }) => (mapped.ok ? [mapped.value.normalizedKeyword] : [])),
  );

  const valid = results.filter(({ mapped }) => mapped.ok).length;
  const invalid = results.length - valid;

  const updated = await prisma.$transaction(async (tx) => {
    for (const { row, mapped } of results) {
      await tx.importRow.update({
        where: { id: row.id },
        data: {
          isValid: mapped.ok,
          errorReason: mapped.ok ? null : mapped.reason,
        },
      });
    }

    return tx.import.update({
      where: { id: record.id },
      data: {
        status: "PREVIEWED",
        validRowCount: valid,
        invalidRowCount: invalid,
      },
    });
  });

  const toPreviewRow = ({
    row,
    mapped,
  }: {
    row: ImportRow;
    mapped: ReturnType<typeof mapRow>;
  }): PreviewRow => ({
    rowNumber: row.rowNumber,
    valid: mapped.ok,
    reason: mapped.ok ? null : mapped.reason,
    keyword: mapped.ok ? mapped.value.keyword : null,
    position: mapped.ok ? mapped.value.position : null,
    searchVolume: mapped.ok ? mapped.value.searchVolume : null,
    landingUrl: mapped.ok ? mapped.value.landingUrl : null,
  });

  return {
    record: updated,
    headers,
    totals: { rows: results.length, valid, invalid, distinctKeywords: distinctKeywords.size },
    sample: results
      .filter(({ mapped }) => mapped.ok)
      .slice(0, 20)
      .map(toPreviewRow),
    // Every invalid row, not a sample: "invalid rows surfaced safely" means a
    // person can see all of what was rejected and why.
    invalid: results.filter(({ mapped }) => !mapped.ok).map(toPreviewRow),
  };
}

export type CommitResult = {
  record: Import;
  keywordsCreated: number;
  metricsWritten: number;
  rankingsWritten: number;
  competitorRowsWritten: number;
  skipped: number;
};

/**
 * Writes the validated rows.
 *
 * Snapshots are keyed on (entity, capturedAt, provider) and upserted, so
 * committing the same import twice updates in place. That is what makes a retry
 * after a partial failure safe rather than merely tolerable.
 */
export async function commitImport(
  context: TenantContext,
  importId: string,
): Promise<CommitResult> {
  const record = await requireImport(context, importId);

  if (record.status === "COMMITTED") {
    throw new ImportError("That import has already been committed.", "wrong_state");
  }

  const rows = await prisma.importRow.findMany({
    where: { importId: record.id, isValid: true },
    orderBy: { rowNumber: "asc" },
  });

  if (rows.length === 0) {
    throw new ImportError("No valid rows to commit.", "no_valid_rows");
  }

  await prisma.import.update({ where: { id: record.id }, data: { status: "COMMITTING" } });

  const headers = headersOf(rows);
  const fallbackCapturedAt = (record.capturedAt ?? record.createdAt).toISOString().slice(0, 10);

  /**
   * The provider whose numbers these are — Semrush or Ahrefs — or null for a
   * hand-written list.
   *
   * A manual list creates Keywords and nothing else. Every snapshot carries the
   * provider that produced it, and no provider value honestly describes a CSV
   * somebody typed; attributing those figures to a vendor would credit a
   * measurement to a company that never made it.
   *
   * Downstream, this is what keeps the two vendors apart. Their volumes come from
   * different models and their difficulty scores are both labelled 0–100 while
   * meaning different things, so an unattributed snapshot would be a number nobody
   * could interpret.
   */
  const provider = providerForSource(record.source);

  const mapped: NormalizedImportRow[] = [];

  for (const row of rows) {
    const result = mapRow(row.rawJson as Record<string, string>, {
      headers,
      language: context.website.primaryLanguage,
      market: context.website.primaryMarket,
      fallbackCapturedAt,
    });

    if (result.ok) mapped.push(result.value);
  }

  const competitors =
    record.source.endsWith("_COMPETITORS")
      ? await prisma.competitor.findMany({ where: { websiteId: context.website.id } })
      : [];

  const { keywordsCreated, metricsWritten, rankingsWritten, competitorRowsWritten, skipped } =
    await persistMarketRows(context, mapped, {
      provider,
      attribution: { kind: "import", importId: record.id },
      fallbackCapturedAt,
      competitors,
      mode: record.source.endsWith("_COMPETITORS") ? "competitors" : "keywords",
    });

  const committed = await prisma.$transaction(async (tx) => {
    const updated = await tx.import.update({
      where: { id: record.id },
      data: {
        status: "COMMITTED",
        committedRowCount: mapped.length - skipped,
        finishedAt: new Date(),
      },
    });

    await recordAudit(tx, context, {
      entityType: "Import",
      entityId: updated.id,
      action: "COMPLETE",
      after: {
        source: record.source,
        keywordsCreated,
        metricsWritten,
        rankingsWritten,
        competitorRowsWritten,
        skipped,
      },
    });

    return updated;
  });

  return {
    record: committed,
    keywordsCreated,
    metricsWritten,
    rankingsWritten,
    competitorRowsWritten,
    skipped,
  };
}

async function requireImport(context: TenantContext, importId: string): Promise<Import> {
  const record = await prisma.import.findFirst({
    where: { id: importId, ...websiteScope(context) },
  });

  if (!record) {
    // Scoped, so an id belonging to another tenant is indistinguishable from one
    // that does not exist.
    throw new ImportError("That import is not available.", "not_found");
  }

  return record;
}

export async function listImports(context: TenantContext, limit = 20): Promise<Import[]> {
  return prisma.import.findMany({
    where: websiteScope(context),
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function cancelImport(context: TenantContext, importId: string): Promise<Import> {
  const record = await requireImport(context, importId);

  if (record.status === "COMMITTED") {
    throw new ImportError("A committed import cannot be cancelled.", "wrong_state");
  }

  return prisma.import.update({
    where: { id: record.id },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
}

export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  empty_file: "That file is empty.",
  too_large: "That file is larger than 5 MB.",
  unsupported_type: "Upload a .csv file.",
  unreadable: "That file could not be read as CSV.",
  unrecognised_format: "That file does not look like a keyword export.",
  provider_required: "Choose whether this export came from Semrush or Ahrefs.",
  wrong_state: "That import cannot be changed in its current state.",
  not_found: "That import is not available.",
  no_valid_rows: "No valid rows to commit.",
};
