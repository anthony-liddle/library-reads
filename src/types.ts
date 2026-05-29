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
 * Pipeline provenance: which parser produced this entry. This is a structural
 * value about the data path, not the user-facing origin of the book. For the
 * latter, see the free-form `source` field on ReadEntry.
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

  /**
   * The canonical date for sorting and "lately" calculations, derived from
   * status. ISO date string (YYYY-MM-DD). The orchestrator computes this.
   *
   * Derivation:
   * - finished, abandoned -> finishedAt (preferred) or startedAt
   * - reading -> startedAt
   * - borrowed -> borrowedAt
   *
   * If none of the relevant dates exist, sortDate is the empty string and
   * the entry will sort to the end. This shouldn't happen for valid entries
   * but the field is required so consumers don't have to optional-chain.
   */
  sortDate: string;

  // Provenance
  /** Which parser produced this entry. Pipeline provenance, not user-facing origin. */
  provenance: ReadSource;
  /** When true, excluded from output unless the consumer opts in. Set from extras. */
  private?: boolean;
  /**
   * Free-form origin of this read, written by the user or defaulted by the
   * orchestrator. Examples: 'library', "Powell's", 'Audible', 'borrowed from
   * Joel'. Distinct from `provenance`, which records which parser produced
   * the entry. The consumer page renders this when present.
   */
  source?: string;
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

/**
 * The raw shape of a single entry from a hand-edited extras file (YAML or JSON),
 * after parsing but before normalization into a ReadEntry. Fields appear exactly
 * as the user wrote them, with status and format validated against their enums
 * and dates validated against ISO YYYY-MM-DD.
 *
 * An entry must have either `isbn` OR both `title` and `author`. Entries
 * missing both identifier paths are rejected with a warning during parse.
 */
export interface RawExtrasEntry {
  isbn?: string;
  /** Open Library ID, for manual override of fuzzy enrichment matches. */
  olid?: string;
  title?: string;
  author?: string;
  status: ReadStatus;
  format?: ReadFormat;
  /** Free-form origin of this read: 'library', "Powell's", 'Audible', etc. */
  source?: string;
  /** ISO date YYYY-MM-DD. */
  startedAt?: string;
  /** ISO date YYYY-MM-DD. */
  finishedAt?: string;
  /** ISO date YYYY-MM-DD. */
  borrowedAt?: string;
  notes?: string;
  /** If true, the orchestrator will exclude this entry from output by default. */
  private?: boolean;
}
