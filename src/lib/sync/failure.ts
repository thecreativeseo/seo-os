/**
 * Naming a failure without repeating it (P1 sync observability).
 *
 * A sync that fails inside the database is recorded as `unknown`, which is the
 * right answer for a person and a useless one for whoever has to fix it. On the
 * ninth of September a Search Console run wrote seventy thousand rows, stalled
 * for nine seconds, and failed on the next statement — and nothing anywhere
 * said what the statement was refused with, because the error was mapped to a
 * code and discarded.
 *
 * What was discarded had to be discarded. A database error's message can carry
 * the SQL, the parameters, a row's contents; a driver error can carry the host.
 * None of that may be stored or logged. But an error also has a shape that
 * carries no data at all: the class it is an instance of, Prisma's own code,
 * the five-character SQLSTATE Postgres attaches, and the stage of the sync it
 * happened in. `40P01` says deadlock. `57P01` says the server closed the
 * connection. `P2024` says the pool ran dry. Those are what this keeps.
 *
 * Everything here is allow-listed by pattern. A value that does not look like a
 * code is not a code and is dropped, so a message that happened to be stored in
 * a field named `code` could never leak through.
 */

/** Where in a sync an error was raised. Diagnostic only; nothing branches on it. */
export type SyncStage =
  | "provider_fetch"
  | "normalize"
  | "identity_lookup"
  | "database_write"
  | "snapshot_open"
  | "snapshot_finalize"
  | "sync_run_finalize"
  /** Reported by the queue itself in the job's output, never by the sync. */
  | "queue_acknowledgement";

export const SYNC_STAGES: readonly SyncStage[] = [
  "provider_fetch",
  "normalize",
  "identity_lookup",
  "database_write",
  "snapshot_open",
  "snapshot_finalize",
  "sync_run_finalize",
  "queue_acknowledgement",
];

/**
 * The safe shape of a failure.
 *
 * Every field is either null or a short token that matched an allow-list. There
 * is deliberately no field a message could fit in.
 */
export type SyncFailureFingerprint = {
  /** The error's class: PrismaClientKnownRequestError, SearchConsoleError, TypeError. */
  name: string | null;
  /** Prisma's own code, P followed by four digits. */
  prismaCode: string | null;
  /** The Postgres SQLSTATE, or a Node socket errno such as ECONNRESET. */
  sqlState: string | null;
  stage: SyncStage | null;
};

/** A mutable marker the sync advances as it goes, read only when it fails. */
export type StageTracker = { stage: SyncStage | null };

export function newStageTracker(): StageTracker {
  return { stage: null };
}

const PRISMA_CODE = /^P\d{4}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const NODE_ERRNO = /^E[A-Z0-9]{2,24}$/;
/** A class name, not a sentence. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;

/** How far down a chain of `cause`s to look. Errors wrap errors, twice at most in practice. */
const MAX_CAUSE_DEPTH = 4;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function tokenAt(value: unknown): string | null {
  return typeof value === "string" && value.length <= 32 ? value : null;
}

/**
 * Every place a driver or ORM has been seen to put a code, on this error and
 * on the errors it wraps. Only the values that look like codes survive.
 */
function collectCodes(error: unknown): string[] {
  const found: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    const record = asRecord(current);
    if (!record) break;

    const meta = asRecord(record.meta);
    const driver = meta ? asRecord(meta.driverAdapterError) : null;
    const driverCause = driver ? asRecord(driver.cause) : null;

    for (const candidate of [
      record.code,
      record.originalCode,
      record.sqlState,
      meta?.code,
      meta?.originalCode,
      driver?.code,
      driver?.originalCode,
      driverCause?.code,
      driverCause?.originalCode,
    ]) {
      const token = tokenAt(candidate);
      if (token) found.push(token);
    }

    current = record.cause;
  }

  return found;
}

/**
 * Reduces an error to what may safely be said about it.
 *
 * The class name is taken from the constructor rather than `error.name`, since
 * `name` is a writable string that some libraries set to a sentence. A Prisma
 * code is the first token matching its pattern; a SQLSTATE is the first
 * five-character token that is not a Prisma code, with Node's socket errnos
 * accepted in its place because a dropped connection surfaces as one of those
 * rather than as anything Postgres said.
 */
export function fingerprintError(
  error: unknown,
  stage: SyncStage | null = null,
): SyncFailureFingerprint {
  let name: string | null = null;

  if (error !== null && typeof error === "object") {
    const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof constructorName === "string" && IDENTIFIER.test(constructorName)) {
      name = constructorName;
    }
  }

  const codes = collectCodes(error);
  const prismaCode = codes.find((code) => PRISMA_CODE.test(code)) ?? null;
  const sqlState =
    codes.find((code) => SQLSTATE.test(code) && !PRISMA_CODE.test(code)) ??
    codes.find((code) => NODE_ERRNO.test(code)) ??
    null;

  return { name, prismaCode, sqlState, stage };
}

/** The fingerprint as flat log fields, so a log line stays one level deep. */
export function fingerprintFields(fingerprint: SyncFailureFingerprint | null | undefined): {
  errorName: string | null;
  prismaCode: string | null;
  sqlState: string | null;
  stage: SyncStage | null;
} {
  return {
    errorName: fingerprint?.name ?? null,
    prismaCode: fingerprint?.prismaCode ?? null,
    sqlState: fingerprint?.sqlState ?? null,
    stage: fingerprint?.stage ?? null,
  };
}
