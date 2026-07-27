import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { type Cache, type EditionPreferences, enrich } from './enrich.js';
import { parseExtras } from './extras.js';
import { parseLibbyCsv } from './libby.js';
import type { RawExtrasEntry, RawLibbyEntry, ReadEntry, ReadResult, ReadStatus } from './types.js';

export interface LibbyInput {
  path?: string;
  content?: string;
  fetch?: () => Promise<string>;
}

export interface ExtrasInput {
  path?: string;
  content?: string;
  /** Required when using `content`; inferred from the path extension when using `path`. */
  format?: 'yaml' | 'json';
  fetch?: () => Promise<{ content: string; format: 'yaml' | 'json' }>;
}

export interface CacheConfig {
  path: string;
  maxAgeDays?: number;
  bust?: string[];
  ignoreReads?: boolean;
}

export interface GetReadsOptions {
  libby?: LibbyInput;
  extras?: ExtrasInput;
  /**
   * Enrichment cache config. Omit it entirely to disable caching: there is no
   * `false` spelling, and no cache file is read or written when it is absent.
   */
  cache?: CacheConfig;
  /** Required: Open Library asks for identifying requests. */
  userAgent: string;
  /** Skip Open Library enrichment entirely. Default false. */
  skipEnrichment?: boolean;
  /** Include entries marked `private: true`. Default false. */
  includePrivate?: boolean;
  /** Cap on returned entries after sort. Default unbounded. */
  limit?: number;
  /** Edition picker preferences passed through to the enricher. */
  editionPreferences?: EditionPreferences;
  /** Override fetch (testability). Passed through to the enricher. */
  fetchImpl?: typeof globalThis.fetch;
  /** Min ms between Open Library requests. Default 1000. */
  rateLimitMs?: number;
}

/**
 * Resolve the cache file path, or undefined when caching is off.
 *
 * Caching is off when `cache` is omitted, which is the documented spelling.
 * The nullish-path checks also absorb an untyped caller passing `cache: false`
 * or a config with no `path`, both of which used to reach the filesystem with
 * an undefined path and crash the build rather than simply not caching.
 */
function cachePathOf(cache: CacheConfig | undefined): string | undefined {
  const path: unknown = cache?.path;
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/** Map `.yaml`/`.yml` to yaml, `.json` to json, anything else to undefined. */
function inferFormatFromPath(path: string): 'yaml' | 'json' | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    return 'yaml';
  }
  if (ext === '.json') {
    return 'json';
  }
  return undefined;
}

/** Resolve a LibbyInput to its raw text content, dispatching on the mode provided. */
async function resolveLibbyInput(
  input: LibbyInput,
): Promise<{ content?: string; warnings: string[] }> {
  if (input.content !== undefined) {
    return { content: input.content, warnings: [] };
  }
  if (input.path !== undefined) {
    return { content: await readFile(input.path, 'utf-8'), warnings: [] };
  }
  if (input.fetch !== undefined) {
    return { content: await input.fetch(), warnings: [] };
  }
  return { warnings: ['Libby input provided but none of `path`, `content`, or `fetch` was set'] };
}

/** Resolve an ExtrasInput to its raw content and format, dispatching on the mode provided. */
async function resolveExtrasInput(
  input: ExtrasInput,
): Promise<{ content?: string; format?: 'yaml' | 'json'; warnings: string[] }> {
  if (input.content !== undefined) {
    if (input.format === undefined) {
      return {
        warnings: ["Extras `content` requires an explicit `format` ('yaml' or 'json')"],
      };
    }
    return { content: input.content, format: input.format, warnings: [] };
  }
  if (input.path !== undefined) {
    const format = inferFormatFromPath(input.path);
    if (format === undefined) {
      return {
        warnings: [
          `Extras path ${input.path} has an unknown extension; expected .yaml, .yml, or .json`,
        ],
      };
    }
    return { content: await readFile(input.path, 'utf-8'), format, warnings: [] };
  }
  if (input.fetch !== undefined) {
    const { content, format } = await input.fetch();
    return { content, format, warnings: [] };
  }
  return { warnings: ['Extras input provided but none of `path`, `content`, or `fetch` was set'] };
}

/**
 * Read and parse the cache file. A missing file is the normal first-build case
 * (empty cache, no warning). Malformed JSON or any other read error yields an
 * empty cache plus a warning, so a bad cache file never blocks a build.
 */
async function readCacheFile(path: string): Promise<{ cache: Cache; warnings: string[] }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { cache: {}, warnings: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      cache: {},
      warnings: [`Cache file ${path} could not be read (${message}); starting fresh`],
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return { cache: parsed as Cache, warnings: [] };
  } catch {
    return { cache: {}, warnings: [`Cache file ${path} is not valid JSON; starting fresh`] };
  }
}

/**
 * Write the cache to disk atomically: write a sibling tmp file, then rename it
 * over the target (atomic on POSIX and modern Windows). On failure the tmp file
 * is cleaned up and the error is re-thrown.
 */
async function writeCacheFile(path: string | undefined, cache: Cache): Promise<void> {
  // Defense in depth: getReads only calls this once cachePath has resolved to a
  // real path, but a nullish path reaching fs.rename crashes the whole build
  // with ERR_INVALID_ARG_TYPE. No path means no caching, so there is nothing to do.
  if (path === undefined || path === '') {
    return;
  }
  const tmpPath = `${path}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(cache, null, 2), 'utf-8');
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/** Convert a raw Libby row into a borrowed ReadEntry. sortDate is filled later. */
function normalizeLibbyEntry(raw: RawLibbyEntry): ReadEntry {
  return {
    title: raw.title,
    author: raw.author ?? '',
    isbn: raw.isbn,
    status: 'borrowed',
    borrowedAt: raw.borrowedAt,
    library: raw.library,
    publisher: raw.publisher,
    source: 'library',
    sortDate: '',
    provenance: 'libby',
  };
}

/** Convert a raw extras entry into a ReadEntry, preserving every user field. sortDate filled later. */
function normalizeExtrasEntry(raw: RawExtrasEntry): ReadEntry {
  return {
    title: raw.title ?? '',
    author: raw.author ?? '',
    isbn: raw.isbn,
    olid: raw.olid,
    status: raw.status,
    format: raw.format,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    borrowedAt: raw.borrowedAt,
    source: raw.source,
    notes: raw.notes,
    private: raw.private,
    sortDate: '',
    provenance: 'extras',
  };
}

/** Normalize an ISBN for matching: strip hyphens and whitespace, then lowercase. */
function isbnMatchKey(isbn: string | undefined): string | undefined {
  if (isbn === undefined || isbn.trim() === '') {
    return undefined;
  }
  return isbn.replace(/[-\s]/g, '').toLowerCase();
}

/**
 * Merge a Libby entry and an extras entry that share an ISBN into one entry.
 * The extras entry is canonical: its status wins (so a borrow can be promoted
 * to finished), and most fields prefer extras with Libby as fallback. Dates are
 * additive (a union), and Libby's library/publisher are always preserved.
 */
function mergePair(libby: ReadEntry, extras: ReadEntry): ReadEntry {
  return {
    title: extras.title || libby.title,
    author: extras.author || libby.author,
    isbn: extras.isbn ?? libby.isbn,
    olid: extras.olid ?? libby.olid,
    status: extras.status,
    format: extras.format ?? libby.format,
    startedAt: extras.startedAt ?? libby.startedAt,
    finishedAt: extras.finishedAt ?? libby.finishedAt,
    borrowedAt: extras.borrowedAt ?? libby.borrowedAt,
    source: extras.source ?? libby.source,
    notes: extras.notes ?? libby.notes,
    private: extras.private ?? false,
    library: libby.library,
    publisher: libby.publisher,
    sortDate: '',
    provenance: 'extras',
  };
}

/**
 * Merge Libby and extras entries by normalized ISBN. Entries sharing an ISBN
 * are merged into one (extras canonical); entries without a counterpart, or
 * without an ISBN at all, pass through unchanged.
 *
 * `libbyCoverByEntry` carries the Libby cover fallback (see getReads). When a
 * merge consumes a Libby entry that had a fallback cover, the association is
 * forwarded to the new merged entry so the fallback survives the merge.
 */
function mergeByIsbn(
  libby: ReadEntry[],
  extras: ReadEntry[],
  libbyCoverByEntry: Map<ReadEntry, string>,
): { merged: ReadEntry[]; warnings: string[] } {
  const extrasByIsbn = new Map<string, ReadEntry>();
  for (const entry of extras) {
    const key = isbnMatchKey(entry.isbn);
    if (key !== undefined) {
      extrasByIsbn.set(key, entry);
    }
  }

  const consumed = new Set<string>();
  const merged: ReadEntry[] = [];

  for (const entry of libby) {
    const key = isbnMatchKey(entry.isbn);
    const match = key !== undefined ? extrasByIsbn.get(key) : undefined;
    if (key !== undefined && match !== undefined) {
      const mergedEntry = mergePair(entry, match);
      const libbyCover = libbyCoverByEntry.get(entry);
      if (libbyCover !== undefined) {
        libbyCoverByEntry.set(mergedEntry, libbyCover);
      }
      merged.push(mergedEntry);
      consumed.add(key);
    } else {
      merged.push(entry);
    }
  }

  for (const entry of extras) {
    const key = isbnMatchKey(entry.isbn);
    if (key !== undefined && consumed.has(key)) {
      continue;
    }
    merged.push(entry);
  }

  return { merged, warnings: [] };
}

/** Derive the canonical sort date for an entry from its status. */
function computeSortDate(entry: ReadEntry): string {
  const status: ReadStatus = entry.status;
  if (status === 'finished' || status === 'abandoned') {
    return entry.finishedAt ?? entry.startedAt ?? '';
  }
  if (status === 'reading') {
    return entry.startedAt ?? '';
  }
  return entry.borrowedAt ?? '';
}

/**
 * Whether a warning signals a transport/HTTP failure (Open Library failing to
 * answer), as opposed to a definitive 404 ("not found"), a fuzzy match, or a
 * missing enrichment path. A 404 is a clean answer, not unavailability, so it
 * must NOT count toward the rollup. The enricher reports a primary 404 as
 * "...has no record for..." (not matched here), but a secondary 404 can still
 * surface as "returned 404", so the status matcher explicitly excludes 404.
 */
function isTransportFailure(warning: string): boolean {
  if (warning.includes('failed to reach Open Library')) {
    return true;
  }
  if (warning.includes('Open Library returned an unparseable response')) {
    return true;
  }
  const httpMatch = /Open Library returned (\d+) for/.exec(warning);
  return httpMatch !== null && httpMatch[1] !== '404';
}

/** Count the warnings that signal a transport/HTTP failure (excludes 404, fuzzy match, no path). */
function countTransportFailures(warnings: string[]): number {
  return warnings.filter(isTransportFailure).length;
}

/**
 * The package's main entry point. Reads Libby and/or extras input, parses,
 * normalizes, enriches via Open Library, and returns a sorted, deduplicated,
 * privacy-filtered array of ReadEntry.
 *
 * At least one of `libby` or `extras` must be provided. Calling with neither
 * returns an empty result with a warning.
 *
 * @param options the source inputs, cache config, and behavior flags
 * @returns ReadResult with entries (sorted desc by sortDate), warnings, lastEntryDate
 */
export async function getReads(options: GetReadsOptions): Promise<ReadResult> {
  const warnings: string[] = [];

  if (options.libby === undefined && options.extras === undefined) {
    warnings.push('No input provided: pass at least one of `libby` or `extras`');
    return { entries: [], warnings };
  }

  // 1. Resolve inputs.
  let libbyContent: string | undefined;
  if (options.libby !== undefined) {
    const resolved = await resolveLibbyInput(options.libby);
    libbyContent = resolved.content;
    warnings.push(...resolved.warnings);
  }
  let extrasContent: string | undefined;
  let extrasFormat: 'yaml' | 'json' | undefined;
  if (options.extras !== undefined) {
    const resolved = await resolveExtrasInput(options.extras);
    extrasContent = resolved.content;
    extrasFormat = resolved.format;
    warnings.push(...resolved.warnings);
  }

  // 2. Parse.
  const libbyRaw: RawLibbyEntry[] = [];
  if (libbyContent !== undefined) {
    const parsed = parseLibbyCsv(libbyContent);
    libbyRaw.push(...parsed.entries);
    warnings.push(...parsed.warnings);
  }
  const extrasRaw: RawExtrasEntry[] = [];
  if (extrasContent !== undefined && extrasFormat !== undefined) {
    const parsed = parseExtras(extrasContent, extrasFormat);
    extrasRaw.push(...parsed.entries);
    warnings.push(...parsed.warnings);
  }

  // 3. Read cache (skipped when ignoreReads is set, but still written back later).
  const cachePath = cachePathOf(options.cache);
  let cache: Cache = {};
  if (cachePath !== undefined && options.cache?.ignoreReads !== true) {
    const resolved = await readCacheFile(cachePath);
    cache = resolved.cache;
    warnings.push(...resolved.warnings);
  }

  // 4. Normalize. Stash each Libby row's cover URL keyed by the normalized
  // entry, so it can fall back into coverUrl after enrichment (it is NOT set
  // as coverUrl now, which would block Open Library from filling that field).
  const libbyCoverByEntry = new Map<ReadEntry, string>();
  const libbyEntries = libbyRaw.map((raw) => {
    const entry = normalizeLibbyEntry(raw);
    if (raw.cover !== undefined && raw.cover.trim() !== '') {
      libbyCoverByEntry.set(entry, raw.cover);
    }
    return entry;
  });

  // 5. Merge by ISBN (forwarding the cover fallback onto merged entries).
  const { merged, warnings: mergeWarnings } = mergeByIsbn(
    libbyEntries,
    extrasRaw.map(normalizeExtrasEntry),
    libbyCoverByEntry,
  );
  warnings.push(...mergeWarnings);

  // 6. Enrich, sharing rate-limiter state and tracking transport failures.
  let entries = merged;
  if (options.skipEnrichment !== true) {
    entries = await enrichAll(merged, cache, options, warnings, libbyCoverByEntry);
  }

  // 6b. Fall back to the Libby cover for any entry Open Library could not give
  // a cover (enrichment off, failed, or sparse). Open Library always got first
  // crack; this only fills a still-empty coverUrl.
  for (const entry of entries) {
    if (entry.coverUrl === undefined) {
      const libbyCover = libbyCoverByEntry.get(entry);
      if (libbyCover !== undefined) {
        entry.coverUrl = libbyCover;
      }
    }
  }

  // 7. Compute sortDate from status.
  for (const entry of entries) {
    entry.sortDate = computeSortDate(entry);
  }

  // 8. Filter private entries unless opted in.
  if (options.includePrivate !== true) {
    entries = entries.filter((entry) => entry.private !== true);
  }

  // 9. Sort descending by sortDate (lexicographic ISO comparison).
  entries.sort((a, b) => (a.sortDate < b.sortDate ? 1 : a.sortDate > b.sortDate ? -1 : 0));

  // 10. Limit.
  if (options.limit !== undefined) {
    entries = entries.slice(0, Math.max(0, options.limit));
  }

  // 11. Write the cache back atomically when a cache path was configured.
  await writeCacheFile(cachePath, cache);

  // 12. lastEntryDate is the max sortDate (entries are sorted descending).
  const lastEntryDate = entries.length > 0 ? entries[0].sortDate : undefined;

  return { entries, warnings, lastEntryDate };
}

/**
 * Enrich every entry with a shared rate limiter and a fetch wrapper that counts
 * requests, so the orchestrator can tell which entries actually hit the network
 * (cache hits and no-path entries never do). Prepends an "Open Library appears
 * to be unavailable" rollup when more than half of the real attempts failed at
 * the transport/HTTP layer.
 *
 * `enrich` returns a fresh entry object, so the Libby cover fallback association
 * is forwarded from each input entry to its enriched counterpart, keeping the
 * post-enrichment fallback pass keyed on the entries that are actually returned.
 */
async function enrichAll(
  merged: ReadEntry[],
  cache: Cache,
  options: GetReadsOptions,
  warnings: string[],
  libbyCoverByEntry: Map<ReadEntry, string>,
): Promise<ReadEntry[]> {
  const rateLimiterState = { nextAllowedAt: 0 };
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  let fetchCount = 0;
  const countingFetch: typeof globalThis.fetch = (input, init) => {
    fetchCount++;
    return baseFetch(input, init);
  };

  let attempts = 0;
  let failedAttempts = 0;
  const enriched: ReadEntry[] = [];

  for (const entry of merged) {
    const before = fetchCount;
    const result = await enrich(entry, {
      userAgent: options.userAgent,
      cache,
      fetchImpl: countingFetch,
      rateLimiterState,
      rateLimitMs: options.rateLimitMs,
      editionPreferences: options.editionPreferences,
      maxAgeDays: options.cache?.maxAgeDays,
      bust: options.cache?.bust,
    });
    // Copy the match quality onto the entry. Undefined (transport failure, or a
    // cache hit from an entry written before the field existed) leaves it unset.
    if (result.matchQuality !== undefined) {
      result.entry.matchQuality = result.matchQuality;
    }
    enriched.push(result.entry);
    warnings.push(...result.warnings);

    // Forward the cover fallback onto the (possibly new) enriched object.
    const libbyCover = libbyCoverByEntry.get(entry);
    if (libbyCover !== undefined && result.entry !== entry) {
      libbyCoverByEntry.set(result.entry, libbyCover);
    }

    // An attempt is an entry that actually fetched something this run.
    if (fetchCount > before) {
      attempts += 1;
      if (countTransportFailures(result.warnings) > 0) {
        failedAttempts += 1;
      }
    }
  }

  if (attempts > 0 && failedAttempts * 2 > attempts) {
    warnings.unshift(
      `Open Library appears to be unavailable (${failedAttempts} of ${attempts} enrichment attempts failed); cached data was used where possible`,
    );
  }

  return enriched;
}
