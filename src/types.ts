/**
 * The state of a book in the reader's life.
 *
 * `borrowed` means it came into the reader's life (a Libby loan, a library
 * pickup) but no read-through is asserted. Libby imports default to this.
 *
 * `reading`, `finished`, and `abandoned` are reader-asserted states that
 * typically come from a manual entry in extras, or override a Libby borrow
 * for the same book.
 */
export type ReadStatus = 'borrowed' | 'reading' | 'finished' | 'abandoned';

/**
 * The physical or digital form of the book. Optional because Libby's export
 * does not expose this field reliably; Open Library enrichment may populate
 * it when known, and manual entries in extras can declare it explicitly.
 */
export type ReadFormat = 'audiobook' | 'ebook' | 'physical';

/**
 * Where this entry came from in the pipeline. Useful for consumers that want
 * to render Libby-sourced and manually-entered books differently.
 */
export type ReadSource = 'libby' | 'extras';

/**
 * A single book in the reader's recent activity. Dates are ISO date strings
 * (YYYY-MM-DD), not Date objects, so the output is trivially serializable
 * and free of timezone surprises.
 */
export interface ReadEntry {
  // Identity
  title: string;
  author: string;
  isbn?: string;
  /** Open Library ID, when known. */
  olid?: string;

  // State
  status: ReadStatus;
  format?: ReadFormat;
  /** ISO date (YYYY-MM-DD). */
  startedAt?: string;
  /** ISO date (YYYY-MM-DD). */
  finishedAt?: string;
  /** ISO date (YYYY-MM-DD). For Libby entries, the borrow date. */
  borrowedAt?: string;

  // Enrichment (from Open Library, when available)
  coverUrl?: string;
  pageCount?: number;
  publishYear?: number;
  subjects?: string[];

  // Provenance
  source: ReadSource;
  /** Library system name, when known (e.g. from Libby). */
  library?: string;
  publisher?: string;
  notes?: string;
}

/**
 * The wrapped result returned by getReads. Wraps the entries array so we can
 * surface freshness signals and soft warnings (Open Library match fallbacks,
 * etc.) without throwing them away.
 */
export interface ReadResult {
  /** Entries sorted descending by the most recent date available on each entry. */
  entries: ReadEntry[];
  /** ISO date of the most recent activity, useful for staleness UI. */
  lastEntryDate?: string;
  /** Soft failures and notable events from the build (fallback matches, missing covers, etc.). */
  warnings: string[];
}

/**
 * The raw shape of a single row from a Libby timeline CSV export, after
 * parsing but before normalization into a ReadEntry. Fields appear exactly
 * as they do in the source CSV, with dates normalized to ISO YYYY-MM-DD.
 * Empty-string fields in the source surface as undefined here.
 *
 * Field names match the CSV columns: cover, title, author, publisher, isbn,
 * timestamp, activity, library, details.
 */
export interface RawLibbyEntry {
  /** OverDrive CDN URL for the cover. May be used as fallback if Open Library has no cover. */
  cover?: string;
  title: string;
  author?: string;
  publisher?: string;
  /** ISBN as it appeared in the CSV. May be ISBN-10 or ISBN-13; not normalized here. */
  isbn?: string;
  /** Borrow date, normalized from the source timestamp to ISO YYYY-MM-DD. */
  borrowedAt: string;
  /** The activity column value. In all-loans exports this is always "Borrowed". */
  activity: string;
  /** Library system name, e.g. "Washington County Cooperative Library Services". */
  library?: string;
  /** Trimmed details column (e.g. "21 days"). Empty/whitespace-only values become undefined. */
  details?: string;
}
