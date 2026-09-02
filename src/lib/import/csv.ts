/**
 * A strict CSV reader (RFC 4180), written rather than installed.
 *
 * This parses a file somebody uploaded, which makes it the most hostile input in
 * the product. A hand-written parser here is a deliberate trade: the algorithm is
 * small and completely understood, it has no configuration that could be turned
 * into a footgun, and it cannot be talked into evaluating anything — which is the
 * property that matters when the file is a spreadsheet export.
 *
 * What it does NOT do is as important as what it does. It does not coerce types,
 * infer schemas, evaluate formulas, follow references, or interpret a leading
 * equals sign as anything but a character. Every value comes back as the text that
 * was in the file.
 */

export type CsvParseError = "empty" | "no_header" | "too_many_rows" | "ragged_row";

export type CsvRow = Record<string, string>;

export type CsvParseResult =
  | { ok: true; headers: string[]; rows: CsvRow[] }
  | { ok: false; reason: CsvParseError; line?: number };

/** Generous for a keyword export, and a hard stop well short of memory trouble. */
export const MAX_CSV_ROWS = 50_000;

/**
 * Splits CSV text into fields, honouring quotes.
 *
 * Quoted fields may contain commas, newlines and doubled quotes. Everything else
 * is literal. Unterminated quotes are tolerated rather than fatal: a truncated
 * export should surface as a bad row a person can see, not a stack trace.
 */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let index = 0;

  // A byte-order mark survives most exports and would otherwise become part of
  // the first header name, quietly breaking header detection.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    record.push(field);
    field = "";
  };

  const endRecord = () => {
    endField();
    // A trailing newline produces one empty field, which is not a record.
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
  };

  while (index < input.length) {
    const char = input[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      endField();
      index += 1;
      continue;
    }

    if (char === "\r") {
      // CRLF and lone CR both end a record; Semrush exports use CRLF.
      if (input[index + 1] === "\n") index += 1;
      endRecord();
      index += 1;
      continue;
    }

    if (char === "\n") {
      endRecord();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== "" || record.length > 0) endRecord();

  return records;
}

export function parseCsv(text: string, maxRows = MAX_CSV_ROWS): CsvParseResult {
  const records = splitRecords(text);

  if (records.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const headers = records[0]!.map((header) => header.trim());

  if (headers.every((header) => header === "")) {
    return { ok: false, reason: "no_header" };
  }

  const body = records.slice(1);

  if (body.length > maxRows) {
    return { ok: false, reason: "too_many_rows" };
  }

  const rows: CsvRow[] = [];

  for (const record of body) {
    // A row that is entirely empty is spacing, not data.
    if (record.every((value) => value.trim() === "")) continue;

    const row: CsvRow = {};
    headers.forEach((header, position) => {
      if (header !== "") row[header] = record[position] ?? "";
    });
    rows.push(row);
  }

  return { ok: true, headers, rows };
}

export const CSV_PARSE_ERROR_MESSAGES: Record<CsvParseError, string> = {
  empty: "That file has no rows.",
  no_header: "That file has no header row.",
  too_many_rows: `That file has more than ${MAX_CSV_ROWS.toLocaleString("en-GB")} rows.`,
  ragged_row: "A row has more values than the header describes.",
};
