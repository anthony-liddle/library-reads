import { parse as parseYaml } from 'yaml';
import type { RawExtrasEntry, ReadFormat, ReadStatus } from './types.js';

/**
 * Result of parsing an extras file. Entries is the successfully-parsed and
 * validated entries; warnings is a list of soft failures collected during
 * parsing (malformed entries, unknown fields, bad dates).
 */
export interface ParseExtrasResult {
  entries: RawExtrasEntry[];
  warnings: string[];
}

const READ_STATUSES: readonly ReadStatus[] = ['borrowed', 'reading', 'finished', 'abandoned'];
const READ_FORMATS: readonly ReadFormat[] = ['audiobook', 'ebook', 'physical'];

/** Fields the schema knows about. Anything else triggers an unknown-field warning. */
const KNOWN_FIELDS = new Set<string>([
  'isbn',
  'olid',
  'title',
  'author',
  'status',
  'format',
  'source',
  'startedAt',
  'finishedAt',
  'borrowedAt',
  'notes',
  'private',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** A present, non-whitespace string. Whitespace-only counts as empty. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReadStatus(value: unknown): value is ReadStatus {
  return isString(value) && (READ_STATUSES as readonly string[]).includes(value);
}

function isReadFormat(value: unknown): value is ReadFormat {
  return isString(value) && (READ_FORMATS as readonly string[]).includes(value);
}

/** Render a value for a warning message: strings in single quotes, others as JSON. */
function show(value: unknown): string {
  return isString(value) ? `'${value}'` : JSON.stringify(value);
}

/** Human-readable label for an entry in warnings: title, else isbn, else position. */
function entryLabel(item: Record<string, unknown>, index: number): string {
  if (isNonEmptyString(item.title)) {
    return `'${item.title}'`;
  }
  if (isNonEmptyString(item.isbn)) {
    return `'${item.isbn}'`;
  }
  return `#${index + 1}`;
}

/** Describe the JSON-ish type of a value for the root-not-a-list warning. */
function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/**
 * Validate a present date value against strict ISO YYYY-MM-DD, rejecting
 * rollover dates like 2026-13-45 and non-dates like 2026-02-30. On failure a
 * warning is pushed and undefined is returned.
 */
function validateDate(
  value: unknown,
  field: string,
  label: string,
  warnings: string[],
): string | undefined {
  if (isString(value) && ISO_DATE.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return value;
    }
  }
  warnings.push(`Entry ${label}: '${field}' must be ISO YYYY-MM-DD, got ${show(value)}`);
  return undefined;
}

/**
 * Validate one raw item against the extras schema. Returns a RawExtrasEntry on
 * success, or undefined (with a warning pushed) when the item is rejected.
 * Unknown fields produce warnings but do not reject the entry.
 */
function validateEntry(
  item: unknown,
  index: number,
  warnings: string[],
): RawExtrasEntry | undefined {
  if (!isPlainObject(item)) {
    warnings.push(`Entry #${index + 1}: entry must be an object`);
    return undefined;
  }

  const label = entryLabel(item, index);

  if (!isReadStatus(item.status)) {
    if (isPresent(item.status)) {
      warnings.push(
        `Entry ${label}: 'status' must be one of ${READ_STATUSES.join(', ')}, got ${show(item.status)}`,
      );
    } else {
      warnings.push(`Entry ${label}: missing required field 'status'`);
    }
    return undefined;
  }
  const status = item.status;

  const hasIsbn = isNonEmptyString(item.isbn);
  const hasTitleAndAuthor = isNonEmptyString(item.title) && isNonEmptyString(item.author);
  if (!hasIsbn && !hasTitleAndAuthor) {
    warnings.push(`Entry ${label}: must have either 'isbn' or both 'title' and 'author'`);
    return undefined;
  }

  const entry: RawExtrasEntry = { status };

  for (const field of ['isbn', 'olid', 'title', 'author', 'notes'] as const) {
    const value = item[field];
    if (!isPresent(value)) {
      continue;
    }
    if (!isNonEmptyString(value)) {
      warnings.push(`Entry ${label}: '${field}' must be a non-empty string`);
      return undefined;
    }
    entry[field] = value;
  }

  if (isPresent(item.format)) {
    if (!isReadFormat(item.format)) {
      warnings.push(
        `Entry ${label}: 'format' must be one of ${READ_FORMATS.join(', ')}, got ${show(item.format)}`,
      );
      return undefined;
    }
    entry.format = item.format;
  }

  if (isPresent(item.source)) {
    if (!isNonEmptyString(item.source)) {
      warnings.push(`Entry ${label}: 'source' must be a non-empty string`);
      return undefined;
    }
    entry.source = item.source;
  }

  for (const field of ['startedAt', 'finishedAt', 'borrowedAt'] as const) {
    if (!isPresent(item[field])) {
      continue;
    }
    const validated = validateDate(item[field], field, label, warnings);
    if (validated === undefined) {
      return undefined;
    }
    entry[field] = validated;
  }

  if (isPresent(item.private)) {
    if (!isBoolean(item.private)) {
      warnings.push(`Entry ${label}: 'private' must be a boolean`);
      return undefined;
    }
    entry.private = item.private;
  }

  for (const key of Object.keys(item)) {
    if (!KNOWN_FIELDS.has(key)) {
      warnings.push(`Entry ${label}: unknown field '${key}'`);
    }
  }

  return entry;
}

/**
 * Parse the text content of an extras file into raw entries.
 *
 * The file must be a list (YAML sequence or JSON array) of entry objects.
 * Each entry is validated against the schema; entries that fail validation
 * are skipped with a warning rather than throwing. A completely malformed
 * file (invalid YAML/JSON, root not a list) returns empty entries with one
 * warning describing the failure.
 *
 * @param content the raw text of the extras file
 * @param format 'yaml' or 'json'
 * @returns a ParseExtrasResult with successfully-validated entries and warnings
 */
export function parseExtras(content: string, format: 'yaml' | 'json'): ParseExtrasResult {
  const warnings: string[] = [];

  let parsed: unknown;
  try {
    parsed = format === 'yaml' ? parseYaml(content) : JSON.parse(content);
  } catch (error) {
    const kind = format === 'yaml' ? 'YAML' : 'JSON';
    const message = error instanceof Error ? error.message : String(error);
    return { entries: [], warnings: [`Invalid ${kind}: ${message}`] };
  }

  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      warnings: [`Extras root must be a list of entries, got ${describeType(parsed)}`],
    };
  }

  const entries: RawExtrasEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = validateEntry(parsed[i], i, warnings);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }

  return { entries, warnings };
}
