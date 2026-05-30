import { createHash } from 'node:crypto';
import type { ReadEntry, ReadFormat } from './types.js';

/** Distilled fields extracted from Open Library; the shape we cache and merge into ReadEntry. */
export interface EnrichmentData {
  coverUrl?: string;
  pageCount?: number;
  publishYear?: number;
  subjects?: string[];
  /** The work OLID, normalized (e.g. 'OL12345W'). */
  olid?: string;
  format?: ReadFormat;
}

/** One row in the cache file. */
export interface CacheEntry {
  /** ISO date string (YYYY-MM-DD) of when this entry was fetched. */
  fetchedAt: string;
  /** The lookup key we used: 'isbn:{isbn}', 'olid:{olid}', or 'title-author:{hash}'. */
  lookupKey: string;
  data: EnrichmentData;
  /**
   * True when the lookup definitively returned 404 (Open Library doesn't
   * have this book). Distinguishes "we tried and it isn't there" from
   * "we got a sparse but valid record." Negative cache entries are
   * refetched on the same maxAgeDays schedule as positive ones; busting
   * a key forces a refetch regardless.
   */
  notFound?: boolean;
}

/** The full cache file shape. Keys are the lookupKey values. */
export type Cache = Record<string, CacheEntry>;

export interface EditionPreferences {
  /**
   * Preferred language codes in order of preference (Open Library uses 3-letter codes:
   * 'eng', 'spa', 'fre', 'jpn', etc.). Tried sequentially; the picker uses the first
   * language that has at least one matching edition. Default: ['eng'].
   *
   * Example: a Spanish-speaking user might pass ['spa', 'eng'] to prefer Spanish
   * editions but fall back to English when no Spanish edition exists.
   */
  languages?: string[];
  /**
   * Prefer editions that have BOTH a cover image AND a page count. Default: true.
   * Set false if you want the original publication edition regardless of completeness.
   */
  preferComplete?: boolean;
  /**
   * Prefer the most recent edition among otherwise-equal candidates. Default: true.
   * Set false to prefer the original publication (oldest edition).
   */
  preferRecent?: boolean;
}

export interface EnrichOptions {
  /** Required: Open Library asks for identifying requests. Format: 'package-name/version (email)'. */
  userAgent: string;
  /** The cache to read from and write to. Mutated by the function. */
  cache: Cache;
  /**
   * Refetch entries whose fetchedAt is older than this many days. Default 180.
   * Open Library data is mostly static but does get corrected occasionally.
   */
  maxAgeDays?: number;
  /** Force-refetch these lookup keys this run, even if cached. Use for surgical corrections. */
  bust?: string[];
  /** Disable cache reads (still writes for next build). Useful for debugging enrichment. */
  ignoreCache?: boolean;
  /** Injectable fetch for testability. Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Minimum ms between requests. Default 1000 (1 req/sec). */
  rateLimitMs?: number;
  /**
   * Shared rate-limiter state. When provided, sequential `enrich` calls
   * coordinate so that the 1 req/sec budget is honored across the entire
   * batch, not just within each call. The orchestrator creates one and
   * passes the same reference to every call.
   *
   * Shape: `{ nextAllowedAt: number }` where nextAllowedAt is a millisecond
   * timestamp. Both reads and writes happen during a single enrich call.
   *
   * When omitted, each enrich call uses its own per-call state (correct in
   * isolation but unsafe in batches).
   */
  rateLimiterState?: { nextAllowedAt: number };
  /**
   * Preferences applied when picking a representative edition from a work's editions list.
   * Defaults are Anglocentric and lean toward complete + recent editions; override via this
   * option to prefer a different language, original publications, etc.
   *
   * Note: the cache stores the picked edition's data, not the raw responses. If you change
   * these preferences between builds, cached entries reflect the OLD preferences until you
   * bust them. The package does not auto-detect preference changes; pass
   * `bust: Object.keys(cache)` to refetch everything and see the new picks take effect.
   */
  editionPreferences?: EditionPreferences;
}

export interface EnrichResult {
  /** The enriched entry. May equal the input if enrichment had no path or all fields failed. */
  entry: ReadEntry;
  /** Soft failures (404 from Open Library, fuzzy match fallback, missing fields, etc.). */
  warnings: string[];
}

/**
 * The narrowed shape of an Open Library edition we read from a work's editions list,
 * an `/isbn` lookup, or a `/books` lookup. Only the fields we actually use.
 */
export interface OpenLibraryEdition {
  physical_format?: string;
  languages?: { key: string }[];
  covers?: number[];
  number_of_pages?: number;
  publish_date?: string;
  works?: { key: string }[];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map Open Library's free-form `physical_format` to our format enum. Imperfect by
 * design: anything with a value that is not clearly audio or electronic is treated
 * as physical; the user can override via extras. Missing/empty yields undefined.
 */
export function inferFormat(physicalFormat: string | undefined): ReadFormat | undefined {
  if (physicalFormat === undefined || physicalFormat.trim() === '') {
    return undefined;
  }
  const value = physicalFormat.toLowerCase();
  if (value.includes('audio') || value.includes('mp3') || value.includes('sound recording')) {
    return 'audiobook';
  }
  if (value.includes('ebook') || value.includes('electronic') || value.includes('online')) {
    return 'ebook';
  }
  return 'physical';
}

/** Extract a four-digit year from a free-form publish date, or undefined. */
export function extractYear(publishDate: string | undefined): number | undefined {
  if (publishDate === undefined) {
    return undefined;
  }
  const match = publishDate.match(/\d{4}/);
  return match ? Number(match[0]) : undefined;
}

/** Construct the large-cover URL for an Open Library cover ID. */
export function coverUrlFromId(coverId: number): string {
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
}

/** Strip hyphens and whitespace from an ISBN; leave everything else as-is. */
export function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[-\s]/g, '');
}

/** Normalize a string for hashing: lowercase, collapse internal whitespace, trim. */
function normalizeForHash(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 16-char sha256 prefix of the normalized 'title|author' key, for compact cache keys. */
export function hashTitleAuthor(title: string, author: string): string {
  const key = `${normalizeForHash(title)}|${normalizeForHash(author)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** True when a cache entry is older than maxAgeDays and should be refetched. */
export function shouldRefetch(cacheEntry: CacheEntry, maxAgeDays: number): boolean {
  const fetchedAt = new Date(cacheEntry.fetchedAt).getTime();
  const ageDays = (Date.now() - fetchedAt) / (1000 * 60 * 60 * 24);
  return ageDays > maxAgeDays;
}

/** True when an edition is compatible with a language code (missing languages match anything). */
function editionMatchesLanguage(edition: OpenLibraryEdition, code: string): boolean {
  if (!edition.languages || edition.languages.length === 0) {
    return true;
  }
  return edition.languages.some((language) => language.key === `/languages/${code}`);
}

/** True when an edition has both a cover and a page count. */
function editionIsComplete(edition: OpenLibraryEdition): boolean {
  return (
    edition.covers !== undefined &&
    edition.covers.length > 0 &&
    edition.number_of_pages !== undefined
  );
}

/**
 * Pick a representative edition from a work's editions list, applying a sequence of
 * filters that each degrade gracefully: format match (when a format is declared),
 * language preference (first preferred language with any match wins), completeness,
 * then recency. Falls back to the first remaining edition when no year resolves a tie.
 *
 * The caller fills in all preference defaults before calling, so this function never
 * has to reason about unset fields.
 */
export function pickEdition(
  editions: OpenLibraryEdition[],
  preferences: Required<EditionPreferences>,
  entryFormat?: ReadFormat,
): OpenLibraryEdition | undefined {
  if (editions.length === 0) {
    return undefined;
  }

  let candidates = editions;

  // 1. Format match (only when the entry declares a format).
  if (entryFormat !== undefined) {
    const matches = candidates.filter((e) => inferFormat(e.physical_format) === entryFormat);
    if (matches.length > 0) {
      candidates = matches;
    }
  }

  // 2. Language preference: first preferred language with at least one match wins.
  for (const code of preferences.languages) {
    const matches = candidates.filter((e) => editionMatchesLanguage(e, code));
    if (matches.length > 0) {
      candidates = matches;
      break;
    }
  }

  // 3. Completeness.
  if (preferences.preferComplete) {
    const matches = candidates.filter(editionIsComplete);
    if (matches.length > 0) {
      candidates = matches;
    }
  }

  // 4. Recency, among editions with a parseable year.
  const dated = candidates
    .map((edition) => ({ edition, year: extractYear(edition.publish_date) }))
    .filter(
      (item): item is { edition: OpenLibraryEdition; year: number } => item.year !== undefined,
    )
    .sort((a, b) => a.year - b.year);
  if (dated.length > 0) {
    return preferences.preferRecent ? dated[dated.length - 1].edition : dated[0].edition;
  }

  // 5. Fallback: the first remaining candidate.
  return candidates[0];
}

/**
 * Apply enrichment data to an entry without overwriting fields the entry already has.
 * User-provided title and author always win; Open Library fills only the gaps.
 */
export function mergeEnrichment(entry: ReadEntry, data: EnrichmentData): ReadEntry {
  const merged: ReadEntry = { ...entry };
  if (merged.coverUrl === undefined && data.coverUrl !== undefined) {
    merged.coverUrl = data.coverUrl;
  }
  if (merged.pageCount === undefined && data.pageCount !== undefined) {
    merged.pageCount = data.pageCount;
  }
  if (merged.publishYear === undefined && data.publishYear !== undefined) {
    merged.publishYear = data.publishYear;
  }
  if (merged.subjects === undefined && data.subjects !== undefined) {
    merged.subjects = data.subjects;
  }
  if (merged.olid === undefined && data.olid !== undefined) {
    merged.olid = data.olid;
  }
  if (merged.format === undefined && data.format !== undefined) {
    merged.format = data.format;
  }
  return merged;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize an OLID for lookup keys and endpoint construction: trim and uppercase. */
function normalizeOlid(olid: string): string {
  return olid.trim().toUpperCase();
}

/** Strip the `/works/` (or `/books/`, `/authors/`) prefix from a key, leaving the OLID. */
function olidFromKey(key: string): string | undefined {
  const olid = key.split('/').pop();
  return olid && olid.length > 0 ? olid : undefined;
}

/** Narrow an unknown JSON value to the edition fields we read. */
function asEdition(data: unknown): OpenLibraryEdition {
  if (!isPlainObject(data)) {
    return {};
  }
  const edition: OpenLibraryEdition = {};
  if (isString(data.physical_format)) {
    edition.physical_format = data.physical_format;
  }
  if (Array.isArray(data.covers)) {
    edition.covers = data.covers.filter((cover): cover is number => typeof cover === 'number');
  }
  if (typeof data.number_of_pages === 'number') {
    edition.number_of_pages = data.number_of_pages;
  }
  if (isString(data.publish_date)) {
    edition.publish_date = data.publish_date;
  }
  if (Array.isArray(data.languages)) {
    edition.languages = data.languages
      .filter(isPlainObject)
      .map((language) => language.key)
      .filter(isString)
      .map((key) => ({ key }));
  }
  if (Array.isArray(data.works)) {
    edition.works = data.works
      .filter(isPlainObject)
      .map((work) => work.key)
      .filter(isString)
      .map((key) => ({ key }));
  }
  return edition;
}

/** Narrow a `/works/{olid}/editions.json` response to an editions array. */
function asEditionsList(data: unknown): OpenLibraryEdition[] {
  if (isPlainObject(data) && Array.isArray(data.entries)) {
    return data.entries.map(asEdition);
  }
  return [];
}

/** Narrow a work response to its subjects array, if any non-empty strings are present. */
function asSubjects(data: unknown): string[] | undefined {
  if (isPlainObject(data) && Array.isArray(data.subjects)) {
    const subjects = data.subjects.filter(isString);
    return subjects.length > 0 ? subjects : undefined;
  }
  return undefined;
}

/** The first doc of a `/search.json` response, narrowed to the fields we read. */
interface SearchDoc {
  workOlid?: string;
  coverId?: number;
  subjects?: string[];
}

/** Narrow a `/search.json` response to its first doc's relevant fields. */
function asSearchDoc(data: unknown): SearchDoc | undefined {
  if (!isPlainObject(data) || !Array.isArray(data.docs) || data.docs.length === 0) {
    return undefined;
  }
  const doc = data.docs[0];
  if (!isPlainObject(doc)) {
    return undefined;
  }
  const result: SearchDoc = {};
  if (isString(doc.key)) {
    result.workOlid = olidFromKey(doc.key);
  }
  if (typeof doc.cover_i === 'number') {
    result.coverId = doc.cover_i;
  }
  if (Array.isArray(doc.subject)) {
    const subjects = doc.subject.filter(isString);
    if (subjects.length > 0) {
      result.subjects = subjects;
    }
  }
  return result;
}

/** The work OLID linked from an edition's `works` array, if present. */
function workOlidFromEdition(edition: OpenLibraryEdition): string | undefined {
  const key = edition.works?.[0]?.key;
  return key ? olidFromKey(key) : undefined;
}

/** Apply an edition's fields to the accumulating enrichment data, filling only gaps. */
function applyEdition(edition: OpenLibraryEdition, data: EnrichmentData): void {
  if (data.coverUrl === undefined && edition.covers && edition.covers.length > 0) {
    data.coverUrl = coverUrlFromId(edition.covers[0]);
  }
  if (data.pageCount === undefined && edition.number_of_pages !== undefined) {
    data.pageCount = edition.number_of_pages;
  }
  if (data.publishYear === undefined) {
    const year = extractYear(edition.publish_date);
    if (year !== undefined) {
      data.publishYear = year;
    }
  }
  if (data.format === undefined) {
    const format = inferFormat(edition.physical_format);
    if (format !== undefined) {
      data.format = format;
    }
  }
}

/** Whether a string is present and non-whitespace. */
function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

const OPEN_LIBRARY = 'https://openlibrary.org';

/**
 * Enrich a single ReadEntry with metadata from Open Library, using and updating the
 * provided cache. See the module docs and EnrichOptions for the lookup strategy.
 *
 * User-provided title and author always win; Open Library fills only missing fields.
 * The cache is mutated in place and is only written when every request in the lookup
 * sequence succeeded (a 2xx, parseable response). Transport and HTTP failures push a
 * warning, leave the cache untouched (so the next build retries), and return whatever
 * partial enrichment was gathered.
 */
export async function enrich(entry: ReadEntry, options: EnrichOptions): Promise<EnrichResult> {
  const warnings: string[] = [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAgeDays = options.maxAgeDays ?? 180;
  const rateLimitMs = options.rateLimitMs ?? 1000;
  const bust = new Set(options.bust ?? []);
  const preferences: Required<EditionPreferences> = {
    languages: options.editionPreferences?.languages ?? ['eng'],
    preferComplete: options.editionPreferences?.preferComplete ?? true,
    preferRecent: options.editionPreferences?.preferRecent ?? true,
  };

  const label = entry.title;

  // Resolve the lookup key and the path we will take.
  let lookupKey: string;
  if (isNonEmpty(entry.olid)) {
    lookupKey = `olid:${normalizeOlid(entry.olid)}`;
  } else if (isNonEmpty(entry.isbn)) {
    lookupKey = `isbn:${normalizeIsbn(entry.isbn)}`;
  } else if (isNonEmpty(entry.title) && isNonEmpty(entry.author)) {
    lookupKey = `title-author:${hashTitleAuthor(entry.title, entry.author)}`;
  } else {
    warnings.push(`Entry '${label}': no enrichment path (missing olid, isbn, and title+author)`);
    return { entry, warnings };
  }

  const hasTitleAndAuthor = isNonEmpty(entry.title) && isNonEmpty(entry.author);

  // Cache read. A fresh entry that is not busted is reused as-is. A notFound
  // entry (data is {}) merges to a no-op, so the entry is returned unenriched
  // with no fetch and no warning. The one wrinkle is the ISBN-404 fallback
  // (see below): a fallback hit caches the result under the title-author key and
  // a notFound under the ISBN key, so when an ISBN is a known dead end we look to
  // the title-author key for a cached fallback result before giving up.
  const usable = (c: CacheEntry | undefined): c is CacheEntry =>
    c !== undefined && !bust.has(c.lookupKey) && !shouldRefetch(c, maxAgeDays);
  if (!options.ignoreCache) {
    const cached = options.cache[lookupKey];
    if (usable(cached)) {
      if (cached.notFound && lookupKey.startsWith('isbn:') && hasTitleAndAuthor) {
        const fallbackKey = `title-author:${hashTitleAuthor(entry.title, entry.author)}`;
        const fallback = options.cache[fallbackKey];
        if (usable(fallback)) {
          return { entry: mergeEnrichment(entry, fallback.data), warnings };
        }
      }
      return { entry: mergeEnrichment(entry, cached.data), warnings };
    }
  }

  // Rate limiter: sleep until the next allowed time before each request. When a
  // shared rateLimiterState is provided, the budget is coordinated across calls;
  // otherwise a per-call state object is used (fresh on every call).
  const rateLimiter = options.rateLimiterState ?? { nextAllowedAt: 0 };
  let anyFailure = false;
  const data: EnrichmentData = {};

  const today = new Date().toISOString().slice(0, 10);
  /** Cache a successful (possibly sparse) enrichment under a key. */
  const writePositive = (key: string): void => {
    options.cache[key] = { fetchedAt: today, lookupKey: key, data };
  };
  /** Cache a definitive 404 ("Open Library has no record") under a key. */
  const writeNotFound = (key: string): void => {
    options.cache[key] = { fetchedAt: today, lookupKey: key, data: {}, notFound: true };
  };

  type Fetched = { ok: true; data: unknown } | { ok: false; notFound: boolean };

  /**
   * Fetch a JSON endpoint with the shared rate limit. A 404 is a definitive
   * "not found": it returns `{ ok: false, notFound: true }` without a warning
   * or setting anyFailure, because what a 404 means depends on the caller (a
   * primary lookup caches it as a dead end; a secondary lookup just yields no
   * extra data). Transport errors, other non-2xx, and parse failures push a
   * warning and set anyFailure so the positive cache is skipped and the next
   * build retries.
   */
  const fetchJson = async (url: string): Promise<Fetched> => {
    const now = Date.now();
    if (now < rateLimiter.nextAllowedAt) {
      await sleep(rateLimiter.nextAllowedAt - now);
    }
    rateLimiter.nextAllowedAt = Date.now() + rateLimitMs;

    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { 'User-Agent': options.userAgent } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Entry '${label}': failed to reach Open Library (${message})`);
      anyFailure = true;
      return { ok: false, notFound: false };
    }
    if (response.status === 404) {
      return { ok: false, notFound: true };
    }
    if (!response.ok) {
      // Non-404 HTTP failure. The orchestrator's isTransportFailure() matches
      // this "returned {status}" template (and excludes 404); keep them in sync.
      warnings.push(`Entry '${label}': Open Library returned ${response.status} for ${url}`);
      anyFailure = true;
      return { ok: false, notFound: false };
    }
    try {
      return { ok: true, data: await response.json() };
    } catch {
      warnings.push(`Entry '${label}': Open Library returned an unparseable response for ${url}`);
      anyFailure = true;
      return { ok: false, notFound: false };
    }
  };

  /** Fetch a work and apply its subjects. Secondary lookup; a miss is non-fatal. */
  const fetchWork = async (workOlid: string): Promise<void> => {
    const result = await fetchJson(`${OPEN_LIBRARY}/works/${workOlid}.json`);
    if (!result.ok) {
      return;
    }
    data.olid = workOlid;
    const subjects = asSubjects(result.data);
    if (data.subjects === undefined && subjects !== undefined) {
      data.subjects = subjects;
    }
  };

  /** Fetch a work's editions list and apply a representative edition. Secondary; a miss is non-fatal. */
  const fetchRepresentativeEdition = async (workOlid: string): Promise<void> => {
    const result = await fetchJson(`${OPEN_LIBRARY}/works/${workOlid}/editions.json`);
    if (!result.ok) {
      return;
    }
    const picked = pickEdition(asEditionsList(result.data), preferences, entry.format);
    if (picked !== undefined) {
      applyEdition(picked, data);
    }
  };

  /**
   * Run the title+author search, applying any matched doc to `data`. Returns
   * 'found' (a doc matched and was applied), 'empty' (a clean response with no
   * usable doc: the book is not in Open Library), or 'failed' (a transport/HTTP/
   * parse problem already warned; leave the cache untouched for a retry). The
   * caller pushes the verify-this warning, since the wording differs between a
   * primary search and an ISBN-404 fallback.
   */
  const searchTitleAuthor = async (): Promise<'found' | 'empty' | 'failed'> => {
    const url =
      `${OPEN_LIBRARY}/search.json?title=${encodeURIComponent(entry.title)}` +
      `&author=${encodeURIComponent(entry.author)}&limit=1`;
    const result = await fetchJson(url);
    if (!result.ok) {
      return result.notFound ? 'empty' : 'failed';
    }
    const doc = asSearchDoc(result.data);
    if (doc === undefined) {
      return 'empty';
    }
    if (doc.subjects !== undefined) {
      data.subjects = doc.subjects;
    }
    if (doc.workOlid !== undefined) {
      data.olid = doc.workOlid;
      await fetchRepresentativeEdition(doc.workOlid);
    }
    if (data.coverUrl === undefined && doc.coverId !== undefined) {
      data.coverUrl = coverUrlFromId(doc.coverId);
    }
    return 'found';
  };

  const noRecord = `Entry '${label}': Open Library has no record for ${lookupKey}`;

  if (isNonEmpty(entry.olid)) {
    const olid = normalizeOlid(entry.olid);
    const url = olid.endsWith('W')
      ? `${OPEN_LIBRARY}/works/${olid}.json`
      : `${OPEN_LIBRARY}/books/${olid}.json`;
    const result = await fetchJson(url);
    if (result.ok) {
      if (olid.endsWith('W')) {
        // Work OLID: subjects from the work, then a representative edition.
        data.olid = olid;
        const subjects = asSubjects(result.data);
        if (subjects !== undefined) {
          data.subjects = subjects;
        }
        await fetchRepresentativeEdition(olid);
      } else {
        // Edition OLID: the edition, then the linked work for subjects.
        const edition = asEdition(result.data);
        applyEdition(edition, data);
        const workOlid = workOlidFromEdition(edition);
        if (workOlid !== undefined) {
          await fetchWork(workOlid);
        }
      }
      if (!anyFailure) {
        writePositive(lookupKey);
      }
    } else if (result.notFound) {
      warnings.push(noRecord);
      writeNotFound(lookupKey);
    }
    // Transport/HTTP/parse failure: already warned; leave the cache for a retry.
  } else if (isNonEmpty(entry.isbn)) {
    const isbn = normalizeIsbn(entry.isbn);
    const result = await fetchJson(`${OPEN_LIBRARY}/isbn/${isbn}.json`);
    if (result.ok) {
      const edition = asEdition(result.data);
      applyEdition(edition, data);
      const workOlid = workOlidFromEdition(edition);
      if (workOlid !== undefined) {
        await fetchWork(workOlid);
      }
      if (!anyFailure) {
        writePositive(lookupKey);
      }
    } else if (result.notFound) {
      // The exact ISBN is not in Open Library. Libby ships audiobook ISBNs that
      // Open Library rarely indexes, so fall back to title+author when we have
      // both. The two writes carry a dual intent, kept side by side: the entity
      // is cached under its title-author key, and the ISBN lookup is remembered
      // as a dead end so future builds skip it.
      if (hasTitleAndAuthor) {
        const fallbackKey = `title-author:${hashTitleAuthor(entry.title, entry.author)}`;
        const outcome = await searchTitleAuthor();
        if (outcome === 'found') {
          warnings.push(
            `Entry '${label}': ISBN not found in Open Library; fell back to title+author search`,
          );
          if (!anyFailure) {
            writePositive(fallbackKey);
          }
          writeNotFound(lookupKey);
        } else if (outcome === 'empty') {
          warnings.push(noRecord);
          writeNotFound(lookupKey);
          writeNotFound(fallbackKey);
        }
        // outcome 'failed': transport problem on the fallback; leave for a retry.
      } else {
        warnings.push(noRecord);
        writeNotFound(lookupKey);
      }
    }
  } else {
    const outcome = await searchTitleAuthor();
    if (outcome === 'found') {
      warnings.push(
        `Entry '${label}': matched by fuzzy title+author search; verify the result and consider adding an olid override`,
      );
      if (!anyFailure) {
        writePositive(lookupKey);
      }
    } else if (outcome === 'empty') {
      warnings.push(noRecord);
      writeNotFound(lookupKey);
    }
  }

  return { entry: mergeEnrichment(entry, data), warnings };
}
