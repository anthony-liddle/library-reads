import { parse } from 'csv-parse/sync';
import type { RawLibbyEntry } from './types.js';

/**
 * Result of parsing a Libby CSV. Entries is the successfully-parsed rows;
 * warnings is a list of soft failures (malformed rows, unparseable dates)
 * collected during parsing. Parsing does NOT throw on a single bad row;
 * one weird entry should not kill the whole build.
 */
export interface ParseLibbyResult {
  entries: RawLibbyEntry[];
  warnings: string[];
}

/** A single CSV row keyed by header name. Every field may be absent or empty. */
type LibbyRow = Partial<Record<string, string>>;

/**
 * The columns a Libby all-loans export is expected to have. Order is NOT
 * significant: the parser below keys rows by column name, so this list is used
 * for set membership (which expected columns are present) and set difference
 * (which columns are unexpected), never for positional comparison.
 */
const EXPECTED_COLUMNS = [
  'cover',
  'title',
  'author',
  'publisher',
  'isbn',
  'timestamp',
  'activity',
  'library',
  'details',
] as const;

/**
 * Pull the first non-empty line of the CSV and split it into trimmed,
 * lower-cased column names. Returns undefined when there is no such line.
 * Header names never contain commas, so a naive split is sufficient.
 */
function extractHeaderColumns(csv: string): string[] | undefined {
  for (const line of csv.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    return line.split(',').map((column) => column.trim().toLowerCase());
  }
  return undefined;
}

/** The verdict on a header line: whether to parse at all, plus any soft warnings. */
interface HeaderCheck {
  /** False only when the line has none of the expected columns, so it is not an export. */
  looksLikeExport: boolean;
  warnings: string[];
}

/**
 * Check a header by column presence rather than position, because the parser
 * keys rows by name and does not care what order the columns arrive in.
 *
 * A reorder is not a signal of anything wrong and produces no warning. Missing
 * or unexpected columns warn once each but still parse: partial data beats no
 * data, and rows simply carry undefined for a column that is not there. Note
 * that a missing `title` or `timestamp` also makes every row unparseable, so
 * that case warns once here and then once per skipped row below.
 *
 * The only outright rejection is a line with zero recognized columns, which
 * means the file is not a Libby export (or the first line is a data row).
 */
function checkHeaderColumns(header: string[]): HeaderCheck {
  const present = new Set(header);
  const missing = EXPECTED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length === EXPECTED_COLUMNS.length) {
    return {
      looksLikeExport: false,
      warnings: [
        `Header unrecognized: found [${header.join(', ')}], which has none of the expected columns [${EXPECTED_COLUMNS.join(', ')}]; this does not look like a Libby export`,
      ],
    };
  }

  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(
      `Header is missing ${missing.length === 1 ? 'column' : 'columns'} [${missing.join(', ')}]; parsing anyway, those fields will be undefined on every row`,
    );
  }
  const expected = new Set<string>(EXPECTED_COLUMNS);
  const unexpected = [...present].filter((column) => !expected.has(column));
  if (unexpected.length > 0) {
    warnings.push(
      `Header has unexpected ${unexpected.length === 1 ? 'column' : 'columns'} [${unexpected.join(', ')}]; parsing anyway and ignoring ${unexpected.length === 1 ? 'it' : 'them'}`,
    );
  }
  return { looksLikeExport: true, warnings };
}

/** Full English month names to their two-digit number, for date normalization. */
const MONTHS = new Map<string, string>([
  ['January', '01'],
  ['February', '02'],
  ['March', '03'],
  ['April', '04'],
  ['May', '05'],
  ['June', '06'],
  ['July', '07'],
  ['August', '08'],
  ['September', '09'],
  ['October', '10'],
  ['November', '11'],
  ['December', '12'],
]);

/** Trim a field and treat an empty result as missing. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Normalize a Libby timestamp ("Month DD, YYYY HH:MM", US locale) to an ISO
 * date string (YYYY-MM-DD). The time is dropped. Returns undefined when the
 * value is missing or does not match the expected shape.
 */
function toIsoDate(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/.exec(timestamp.trim());
  if (match === null) {
    return undefined;
  }
  const [, monthName, day, year] = match;
  if (monthName === undefined || day === undefined || year === undefined) {
    return undefined;
  }
  const month = MONTHS.get(monthName);
  if (month === undefined) {
    return undefined;
  }
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

/**
 * Parse the text of a Libby timeline CSV export into raw entries.
 *
 * Dates are normalized to ISO YYYY-MM-DD. Empty-string fields become undefined.
 * Trailing whitespace and blank lines are tolerated. Rows missing a title or
 * with an unparseable date are skipped with a warning rather than throwing.
 *
 * The header is checked by column presence, not order: Libby is free to
 * reorder columns, and a missing or unexpected column warns but still parses.
 * See checkHeaderColumns for the one case that refuses outright.
 *
 * @param csv the raw text content of a libbytimeline-all-loans.csv file
 * @returns a ParseLibbyResult with successfully-parsed entries and any warnings
 */
export function parseLibbyCsv(csv: string): ParseLibbyResult {
  const entries: RawLibbyEntry[] = [];
  const warnings: string[] = [];

  const header = extractHeaderColumns(csv);
  if (header === undefined) {
    warnings.push(
      `Header missing: expected [${EXPECTED_COLUMNS.join(', ')}] but the CSV had no header row`,
    );
    return { entries, warnings };
  }
  const headerCheck = checkHeaderColumns(header);
  warnings.push(...headerCheck.warnings);
  if (!headerCheck.looksLikeExport) {
    return { entries, warnings };
  }

  let parsed: unknown;
  try {
    parsed = parse(csv, {
      // Normalize header keys to trimmed lower case so a case-only difference in
      // the export header still maps each column to the field we read below.
      columns: (record: string[]) => record.map((column) => column.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: false,
      relax_column_count: true,
    });
  } catch (error) {
    // csv-parse throws on damage the row-level tolerances cannot absorb, such
    // as an unclosed quote. Warn and return what we have rather than letting
    // the exception escape and take the whole build with it.
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`CSV could not be parsed (${message}); no entries were read`);
    return { entries, warnings };
  }
  const rows: LibbyRow[] = Array.isArray(parsed) ? (parsed as LibbyRow[]) : [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) {
      continue;
    }

    const title = clean(row.title);
    if (title === undefined) {
      warnings.push(`Skipping row ${i + 1}: missing title`);
      continue;
    }

    const borrowedAt = toIsoDate(row.timestamp);
    if (borrowedAt === undefined) {
      warnings.push(`Skipping "${title}": unparseable date ${JSON.stringify(row.timestamp ?? '')}`);
      continue;
    }

    entries.push({
      cover: clean(row.cover),
      title,
      author: clean(row.author),
      publisher: clean(row.publisher),
      isbn: clean(row.isbn),
      borrowedAt,
      activity: clean(row.activity) ?? '',
      library: clean(row.library),
      details: clean(row.details),
    });
  }

  return { entries, warnings };
}
