import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditionPreferences } from './enrich.js';
import {
  type Cache,
  coverUrlFromId,
  enrich,
  extractYear,
  hashTitleAuthor,
  inferFormat,
  mergeEnrichment,
  normalizeIsbn,
  type OpenLibraryEdition,
  pickEdition,
  shouldRefetch,
} from './enrich.js';
import type { ReadEntry } from './types.js';

const USER_AGENT = 'library-reads/0.0.1 (test@example.com)';

/** Build a JSON Response with a given status. */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface Route {
  body?: unknown;
  status?: number;
  throws?: string;
}

/**
 * A mock fetch that routes by URL substring, records each call with a timestamp,
 * and throws on any URL it was not told about (so unexpected requests fail loudly).
 */
const routerFetch = (routes: Record<string, Route>) => {
  const calls: { url: string; at: number }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push({ url, at: Date.now() });
    for (const [needle, route] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (route.throws !== undefined) {
          throw new Error(route.throws);
        }
        return json(route.body ?? {}, route.status ?? 200);
      }
    }
    throw new Error(`unexpected url: ${url}`);
  });
  return { fn, calls };
};

const makeEntry = (overrides: Partial<ReadEntry> = {}): ReadEntry => ({
  title: 'The Overstory',
  author: 'Richard Powers',
  status: 'finished',
  sortDate: '',
  provenance: 'extras',
  ...overrides,
});

/** An edition fixture shaped like what /editions.json or /isbn returns. */
const editionFixture = (overrides: Partial<OpenLibraryEdition> = {}): OpenLibraryEdition => ({
  covers: [7],
  number_of_pages: 502,
  publish_date: '2018',
  physical_format: 'Hardcover',
  languages: [{ key: '/languages/eng' }],
  ...overrides,
});

/** Default preferences with every field filled, as the caller would build them. */
const defaultPrefs: Required<EditionPreferences> = {
  languages: ['eng'],
  preferComplete: true,
  preferRecent: true,
};

/** An ISO date string N days before now (date-only YYYY-MM-DD). */
const daysAgo = (n: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

describe('enrich: format inference', () => {
  it('maps "Audiobook" to audiobook', () => {
    expect(inferFormat('Audiobook')).toBe('audiobook');
  });

  it('maps "MP3 CD" to audiobook', () => {
    expect(inferFormat('MP3 CD')).toBe('audiobook');
  });

  it('maps "Audible Audio" to audiobook', () => {
    expect(inferFormat('Audible Audio')).toBe('audiobook');
  });

  it('maps "Sound recording" to audiobook', () => {
    expect(inferFormat('Sound recording')).toBe('audiobook');
  });

  it('maps "Ebook" to ebook', () => {
    expect(inferFormat('Ebook')).toBe('ebook');
  });

  it('maps "Electronic resource" to ebook', () => {
    expect(inferFormat('Electronic resource')).toBe('ebook');
  });

  it('maps "Hardcover" to physical', () => {
    expect(inferFormat('Hardcover')).toBe('physical');
  });

  it('maps "Mass market paperback" to physical', () => {
    expect(inferFormat('Mass market paperback')).toBe('physical');
  });

  it('maps an unknown free-form value to physical (not undefined)', () => {
    expect(inferFormat('Spiral-bound zine')).toBe('physical');
  });

  it('maps an empty string to undefined', () => {
    expect(inferFormat('')).toBeUndefined();
  });

  it('maps undefined to undefined', () => {
    expect(inferFormat(undefined)).toBeUndefined();
  });
});

describe('enrich: publish year extraction', () => {
  it('extracts 2018 from "2018"', () => {
    expect(extractYear('2018')).toBe(2018);
  });

  it('extracts 2018 from "September 2018"', () => {
    expect(extractYear('September 2018')).toBe(2018);
  });

  it('extracts 2018 from "2018-09-15"', () => {
    expect(extractYear('2018-09-15')).toBe(2018);
  });

  it('returns undefined for "unknown"', () => {
    expect(extractYear('unknown')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(extractYear(undefined)).toBeUndefined();
  });
});

describe('enrich: cover URL construction (helper)', () => {
  it('builds a -L.jpg URL from a cover ID', () => {
    expect(coverUrlFromId(12345)).toBe('https://covers.openlibrary.org/b/id/12345-L.jpg');
  });
});

describe('enrich: ISBN normalization', () => {
  it('strips hyphens', () => {
    expect(normalizeIsbn('978-0-374-27563-1')).toBe('9780374275631');
  });

  it('strips whitespace', () => {
    expect(normalizeIsbn('  9780374275631 ')).toBe('9780374275631');
  });

  it('leaves an already-clean ISBN unchanged', () => {
    expect(normalizeIsbn('9780374275631')).toBe('9780374275631');
  });
});

describe('enrich: title+author hashing', () => {
  it('produces a 16-char hex string', () => {
    expect(hashTitleAuthor('The Overstory', 'Richard Powers')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('normalizes case, whitespace, and surrounding space before hashing', () => {
    const a = hashTitleAuthor('The Overstory', 'Richard Powers');
    const b = hashTitleAuthor('  the   OVERSTORY ', '  richard   powers  ');
    expect(b).toBe(a);
  });

  it('produces different hashes for different books', () => {
    const a = hashTitleAuthor('The Overstory', 'Richard Powers');
    const b = hashTitleAuthor('The Midnight Library', 'Matt Haig');
    expect(a).not.toBe(b);
  });

  it('matches a sha256 prefix of the normalized "title|author" key', () => {
    const expected = createHash('sha256')
      .update('the overstory|richard powers')
      .digest('hex')
      .slice(0, 16);
    expect(hashTitleAuthor('The Overstory', 'Richard Powers')).toBe(expected);
  });
});

describe('enrich: staleness check', () => {
  it('returns false for an entry fetched today', () => {
    const entry = { fetchedAt: daysAgo(0), lookupKey: 'isbn:x', data: {} };
    expect(shouldRefetch(entry, 180)).toBe(false);
  });

  it('returns true for an entry older than maxAgeDays', () => {
    const entry = { fetchedAt: daysAgo(200), lookupKey: 'isbn:x', data: {} };
    expect(shouldRefetch(entry, 180)).toBe(true);
  });

  it('returns false for an entry within maxAgeDays', () => {
    const entry = { fetchedAt: daysAgo(30), lookupKey: 'isbn:x', data: {} };
    expect(shouldRefetch(entry, 180)).toBe(false);
  });
});

describe('enrich: edition picker', () => {
  const edition = (overrides: Partial<OpenLibraryEdition>): OpenLibraryEdition => ({
    ...overrides,
  });

  it('prefers an audio edition when entry format is audiobook', () => {
    const editions = [
      edition({ physical_format: 'Hardcover', languages: [{ key: '/languages/eng' }] }),
      edition({ physical_format: 'Audiobook', languages: [{ key: '/languages/eng' }] }),
    ];
    expect(pickEdition(editions, defaultPrefs, 'audiobook')?.physical_format).toBe('Audiobook');
  });

  it('prefers an English edition over a translation with default preferences', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/fre' }], publish_date: '2020' }),
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2020' }),
    ];
    expect(pickEdition(editions, defaultPrefs)?.languages?.[0]?.key).toBe('/languages/eng');
  });

  it('prefers a Spanish edition when languages preference is ["spa"]', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2020' }),
      edition({ languages: [{ key: '/languages/spa' }], publish_date: '2020' }),
    ];
    const prefs = { ...defaultPrefs, languages: ['spa'] };
    expect(pickEdition(editions, prefs)?.languages?.[0]?.key).toBe('/languages/spa');
  });

  it('falls back to English when languages is ["spa", "eng"] and no Spanish edition exists', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/fre' }], publish_date: '2020' }),
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2020' }),
    ];
    const prefs = { ...defaultPrefs, languages: ['spa', 'eng'] };
    expect(pickEdition(editions, prefs)?.languages?.[0]?.key).toBe('/languages/eng');
  });

  it('treats an edition with no languages field as compatible with any language preference', () => {
    const editions = [edition({ publish_date: '2020', number_of_pages: 100, covers: [1] })];
    const prefs = { ...defaultPrefs, languages: ['spa'] };
    expect(pickEdition(editions, prefs)).toBe(editions[0]);
  });

  it('prefers an edition with cover and pageCount over one without when preferComplete is true', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2020' }),
      edition({
        languages: [{ key: '/languages/eng' }],
        publish_date: '2019',
        covers: [42],
        number_of_pages: 320,
      }),
    ];
    expect(pickEdition(editions, defaultPrefs)?.number_of_pages).toBe(320);
  });

  it('skips the completeness filter when preferComplete is false', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2021' }),
      edition({
        languages: [{ key: '/languages/eng' }],
        publish_date: '2019',
        covers: [42],
        number_of_pages: 320,
      }),
    ];
    const prefs = { ...defaultPrefs, preferComplete: false };
    // Completeness skipped, so recency (default) wins: the 2021 edition.
    expect(pickEdition(editions, prefs)?.publish_date).toBe('2021');
  });

  it('prefers the most recent edition among otherwise-equal candidates when preferRecent is true', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2001' }),
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2018' }),
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2010' }),
    ];
    const prefs = { ...defaultPrefs, preferComplete: false };
    expect(pickEdition(editions, prefs)?.publish_date).toBe('2018');
  });

  it('prefers the oldest edition when preferRecent is false', () => {
    const editions = [
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2001' }),
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2018' }),
      edition({ languages: [{ key: '/languages/eng' }], publish_date: '2010' }),
    ];
    const prefs = { ...defaultPrefs, preferComplete: false, preferRecent: false };
    expect(pickEdition(editions, prefs)?.publish_date).toBe('2001');
  });

  it('applies preferences in sequence: format, then language, then completeness, then recency', () => {
    const editions = [
      // Wrong format: dropped at step 1.
      edition({
        physical_format: 'Hardcover',
        languages: [{ key: '/languages/eng' }],
        publish_date: '2022',
        covers: [1],
        number_of_pages: 100,
      }),
      // Right format, wrong language: dropped at step 2.
      edition({
        physical_format: 'Audiobook',
        languages: [{ key: '/languages/fre' }],
        publish_date: '2021',
        covers: [2],
        number_of_pages: 100,
      }),
      // Right format and language, but incomplete: dropped at step 3.
      edition({
        physical_format: 'Audiobook',
        languages: [{ key: '/languages/eng' }],
        publish_date: '2020',
      }),
      // Right format, language, complete, older: loses recency at step 4.
      edition({
        physical_format: 'Audiobook',
        languages: [{ key: '/languages/eng' }],
        publish_date: '2015',
        covers: [3],
        number_of_pages: 200,
      }),
      // Right format, language, complete, most recent: the winner.
      edition({
        physical_format: 'Audiobook',
        languages: [{ key: '/languages/eng' }],
        publish_date: '2019',
        covers: [4],
        number_of_pages: 220,
      }),
    ];
    expect(pickEdition(editions, defaultPrefs, 'audiobook')?.covers?.[0]).toBe(4);
  });

  it('degrades gracefully: when no editions match a filter, that filter is skipped', () => {
    // No audio editions at all: the format filter is skipped, language proceeds.
    const editions = [
      edition({ physical_format: 'Hardcover', languages: [{ key: '/languages/fre' }] }),
      edition({ physical_format: 'Paperback', languages: [{ key: '/languages/eng' }] }),
    ];
    expect(pickEdition(editions, defaultPrefs, 'audiobook')?.languages?.[0]?.key).toBe(
      '/languages/eng',
    );
  });

  it('falls back to the first edition when nothing matches any filter', () => {
    const editions = [
      edition({ physical_format: 'Hardcover', languages: [{ key: '/languages/fre' }] }),
      edition({ physical_format: 'Paperback', languages: [{ key: '/languages/deu' }] }),
    ];
    // audiobook format: none; spa language: none; complete: none; recency: no years.
    const prefs = { ...defaultPrefs, languages: ['spa'] };
    expect(pickEdition(editions, prefs, 'audiobook')).toBe(editions[0]);
  });

  it('returns undefined for an empty editions list', () => {
    expect(pickEdition([], defaultPrefs)).toBeUndefined();
  });
});

describe('enrich: mergeEnrichment', () => {
  const base: ReadEntry = {
    title: 'The Overstory',
    author: 'Richard Powers',
    status: 'finished',
    provenance: 'extras',
  };

  it('fills fields the entry does not already have', () => {
    const merged = mergeEnrichment(base, {
      coverUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg',
      pageCount: 502,
      publishYear: 2018,
      subjects: ['Trees', 'Fiction'],
      olid: 'OL1W',
      format: 'physical',
    });
    expect(merged.coverUrl).toBe('https://covers.openlibrary.org/b/id/1-L.jpg');
    expect(merged.pageCount).toBe(502);
    expect(merged.publishYear).toBe(2018);
    expect(merged.subjects).toEqual(['Trees', 'Fiction']);
    expect(merged.olid).toBe('OL1W');
    expect(merged.format).toBe('physical');
  });

  it('does not overwrite an existing format on the entry', () => {
    const entry: ReadEntry = { ...base, format: 'audiobook' };
    const merged = mergeEnrichment(entry, { format: 'physical' });
    expect(merged.format).toBe('audiobook');
  });

  it('does not overwrite an existing olid on the entry', () => {
    const entry: ReadEntry = { ...base, olid: 'OL999W' };
    const merged = mergeEnrichment(entry, { olid: 'OL1W' });
    expect(merged.olid).toBe('OL999W');
  });

  it('never overwrites title or author', () => {
    const merged = mergeEnrichment(base, { pageCount: 10 });
    expect(merged.title).toBe('The Overstory');
    expect(merged.author).toBe('Richard Powers');
  });

  it('returns a new object and does not mutate the input', () => {
    const merged = mergeEnrichment(base, { pageCount: 10 });
    expect(merged).not.toBe(base);
    expect(base.pageCount).toBeUndefined();
  });
});

const today = new Date().toISOString().slice(0, 10);

describe('enrich: cache hit', () => {
  it('returns cached data without calling fetch when a fresh ISBN entry exists', async () => {
    const fetchImpl = vi.fn();
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: today,
        lookupKey: 'isbn:9780374275631',
        data: { pageCount: 502 },
      },
    };
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.entry.pageCount).toBe(502);
  });

  it('returns cached data without calling fetch when a fresh OLID entry exists', async () => {
    const fetchImpl = vi.fn();
    const cache: Cache = {
      'olid:OL1W': { fetchedAt: today, lookupKey: 'olid:OL1W', data: { subjects: ['Trees'] } },
    };
    const result = await enrich(makeEntry({ olid: 'OL1W' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.entry.subjects).toEqual(['Trees']);
  });

  it('returns cached data without calling fetch when a fresh title+author entry exists', async () => {
    const fetchImpl = vi.fn();
    const key = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    const cache: Cache = { [key]: { fetchedAt: today, lookupKey: key, data: { pageCount: 502 } } };
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.entry.pageCount).toBe(502);
  });

  it('refetches when the cache entry is older than maxAgeDays', async () => {
    const stale = new Date();
    stale.setUTCDate(stale.getUTCDate() - 200);
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: stale.toISOString().slice(0, 10),
        lookupKey: 'isbn:9780374275631',
        data: { pageCount: 1 },
      },
    };
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(fn).toHaveBeenCalled();
  });

  it('refetches when the lookup key is in the bust list', async () => {
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: today,
        lookupKey: 'isbn:9780374275631',
        data: { pageCount: 1 },
      },
    };
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      bust: ['isbn:9780374275631'],
    });
    expect(fn).toHaveBeenCalled();
  });

  it('skips the cache read when ignoreCache is true but still writes back', async () => {
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: today,
        lookupKey: 'isbn:9780374275631',
        data: { pageCount: 1 },
      },
    };
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      ignoreCache: true,
    });
    expect(fn).toHaveBeenCalled();
    expect(cache['isbn:9780374275631']?.data.pageCount).toBe(502);
  });
});

describe('enrich: OLID path', () => {
  it('fetches the work endpoint for a work OLID (suffix W)', async () => {
    const { fn, calls } = routerFetch({
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const result = await enrich(makeEntry({ olid: 'OL1W' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls.some((c) => c.url.includes('works/OL1W.json'))).toBe(true);
    expect(result.entry.subjects).toEqual(['Trees']);
    expect(result.entry.pageCount).toBe(502);
  });

  it('fetches the edition endpoint for an edition OLID (suffix M)', async () => {
    const { fn, calls } = routerFetch({
      'books/OL2M.json': {
        body: editionFixture({ number_of_pages: 300, works: [{ key: '/works/OL9W' }] }),
      },
      'works/OL9W.json': { body: { subjects: ['Sci-Fi'] } },
    });
    const result = await enrich(makeEntry({ olid: 'OL2M' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls.some((c) => c.url.includes('books/OL2M.json'))).toBe(true);
    expect(result.entry.pageCount).toBe(300);
  });

  it('fetches both the work and an edition for a work OLID', async () => {
    const { fn, calls } = routerFetch({
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    await enrich(makeEntry({ olid: 'OL1W' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls).toHaveLength(2);
  });

  it('fetches both the edition and the linked work for an edition OLID', async () => {
    const { fn, calls } = routerFetch({
      'books/OL2M.json': { body: editionFixture({ works: [{ key: '/works/OL9W' }] }) },
      'works/OL9W.json': { body: { subjects: ['Sci-Fi'] } },
    });
    const result = await enrich(makeEntry({ olid: 'OL2M' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls).toHaveLength(2);
    expect(result.entry.subjects).toEqual(['Sci-Fi']);
  });

  it('writes the result to cache under the olid key', async () => {
    const { fn } = routerFetch({
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ olid: 'OL1W' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['olid:OL1W']).toBeDefined();
    expect(cache['olid:OL1W']?.data.subjects).toEqual(['Trees']);
  });
});

describe('enrich: ISBN path', () => {
  it('fetches by ISBN, then fetches the linked work for subjects', async () => {
    const { fn, calls } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls).toHaveLength(2);
    expect(result.entry.pageCount).toBe(502);
    expect(result.entry.subjects).toEqual(['Trees']);
  });

  it('writes the result to cache under the isbn key', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']).toBeDefined();
  });

  it('handles an entry with ISBN but no title or author', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const result = await enrich(makeEntry({ title: '', author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.pageCount).toBe(502);
  });

  it('normalizes a hyphenated ISBN before lookup', async () => {
    const { fn, calls } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '978-0-374-27563-1' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls[0]?.url).toContain('/isbn/9780374275631.json');
    expect(cache['isbn:9780374275631']).toBeDefined();
  });
});

describe('enrich: search path (title+author)', () => {
  it('searches by title+author when there is no ISBN or OLID', async () => {
    const { fn, calls } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls[0]?.url).toContain('search.json');
    expect(result.entry.pageCount).toBe(502);
  });

  it('fetches a representative edition for cover and pageCount after the search', async () => {
    const { fn, calls } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture({ number_of_pages: 333 })] } },
    });
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls.some((c) => c.url.includes('editions.json'))).toBe(true);
    expect(result.entry.pageCount).toBe(333);
  });

  it('takes subjects from the search doc without a second work lookup', async () => {
    const { fn, calls } = routerFetch({
      'search.json': {
        body: { docs: [{ key: '/works/OL1W', cover_i: 99, subject: ['Trees', 'Ecology'] }] },
      },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.subjects).toEqual(['Trees', 'Ecology']);
    // The search doc already carried them, so /works/OL1W.json is never fetched.
    expect(calls.some((c) => c.url.endsWith('works/OL1W.json'))).toBe(false);
  });

  it('keeps the search result when the follow-up editions lookup fails', async () => {
    const { fn } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { throws: 'ECONNRESET' },
    });
    const cache: Cache = {};
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    // The secondary lookup is best-effort: the cover and OLID from the search
    // survive, but the failure blocks the positive cache write so the next
    // build retries for the page count.
    expect(result.entry.coverUrl).toBe(coverUrlFromId(99));
    expect(result.entry.olid).toBe('OL1W');
    expect(result.entry.pageCount).toBeUndefined();
    expect(cache).toEqual({});
  });

  it('emits a fuzzy match warning naming the entry', async () => {
    const { fn } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.warnings).toContainEqual(
      "Entry 'The Overstory': matched by fuzzy title+author search; verify the result and consider adding an olid override",
    );
  });

  it('writes the result to cache under the title-author hash', async () => {
    const { fn } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry(), { userAgent: USER_AGENT, cache, fetchImpl: fn, rateLimitMs: 0 });
    const key = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    expect(cache[key]).toBeDefined();
  });
});

describe('enrich: title and author preservation', () => {
  it('preserves the entry title even when Open Library has a different one', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': {
        body: editionFixture({ title: 'WRONG TITLE', works: [{ key: '/works/OL1W' }] }),
      },
      'works/OL1W.json': { body: { title: 'WRONG WORK TITLE', subjects: ['Trees'] } },
    });
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.title).toBe('The Overstory');
  });

  it('preserves the entry author even when Open Library returns a list of authors', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': {
        body: editionFixture({ works: [{ key: '/works/OL1W' }] }),
      },
      'works/OL1W.json': {
        body: { authors: [{ author: { key: '/authors/OL1A' } }], subjects: ['Trees'] },
      },
    });
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.author).toBe('Richard Powers');
  });
});

describe('enrich: rate limiting', () => {
  // Fake timers make these assertions deterministic: the rate limiter sets
  // nextAllowedAt to `Date.now() + rateLimitMs` and sleeps via setTimeout, so a
  // mocked clock gives exact request timestamps and budget values. The previous
  // assertions measured real wall-clock deltas, which quantize on Date.now()'s
  // millisecond resolution (a 40ms sleep can read back as 39) and flaked under
  // parallel-test CPU load.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits rateLimitMs between sequential fetch calls', async () => {
    const { fn, calls } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const promise = enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 40,
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBe(40);
  });

  it('respects a custom rateLimitMs', async () => {
    const { fn, calls } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const promise = enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 80,
    });
    await vi.runAllTimersAsync();
    await promise;
    expect(calls[1].at - calls[0].at).toBe(80);
  });

  it('does not wait before the first fetch', async () => {
    const { fn, calls } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const start = Date.now();
    const promise = enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 200,
    });
    await vi.runAllTimersAsync();
    await promise;
    // The first request fires at the starting instant; only later requests wait.
    expect(calls[0].at).toBe(start);
  });

  it('shares state across two sequential calls when rateLimiterState is provided', async () => {
    const { fn, calls } = routerFetch({ '/isbn/': { body: editionFixture() } });
    const rateLimiterState = { nextAllowedAt: 0 };
    const start = Date.now();

    const first = enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 40,
      rateLimiterState,
    });
    await vi.runAllTimersAsync();
    await first;
    // The first request fires immediately and advances the shared budget once.
    expect(rateLimiterState.nextAllowedAt).toBe(start + 40);

    const second = enrich(makeEntry({ isbn: '9780000000000' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 40,
      rateLimiterState,
    });
    await vi.runAllTimersAsync();
    await second;
    // The second call inherits the budget: it waits one interval before its
    // request, then advances the budget again.
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBe(40);
    expect(rateLimiterState.nextAllowedAt).toBe(start + 80);
  });

  it('does NOT share state across calls when rateLimiterState is omitted', async () => {
    const { fn, calls } = routerFetch({ '/isbn/': { body: editionFixture() } });

    const first = enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 200,
    });
    await vi.runAllTimersAsync();
    await first;

    const second = enrich(makeEntry({ isbn: '9780000000000' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 200,
    });
    await vi.runAllTimersAsync();
    await second;
    // Each call starts a fresh per-call limiter, so neither first request waits;
    // both fire at the same (frozen) instant.
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBe(0);
  });

  it('mutates the rateLimiterState object in place', async () => {
    const { fn } = routerFetch({ '/isbn/': { body: editionFixture() } });
    const rateLimiterState = { nextAllowedAt: 0 };
    const start = Date.now();
    const promise = enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 40,
      rateLimiterState,
    });
    await vi.runAllTimersAsync();
    await promise;
    // The caller sees the advanced budget after enrich returns.
    expect(rateLimiterState.nextAllowedAt).toBe(start + 40);
  });
});

describe('enrich: cover URL construction', () => {
  it('builds a -L.jpg URL from the first cover ID on the edition', async () => {
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ covers: [42], works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.coverUrl).toBe('https://covers.openlibrary.org/b/id/42-L.jpg');
  });

  it("falls back to the work's cover_i when the edition has no cover", async () => {
    const { fn } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture({ covers: undefined })] } },
    });
    const result = await enrich(makeEntry(), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.coverUrl).toBe('https://covers.openlibrary.org/b/id/99-L.jpg');
  });

  it('leaves coverUrl undefined when there is no cover info anywhere', async () => {
    const { fn } = routerFetch({
      '/isbn/': {
        body: editionFixture({ covers: undefined, works: [{ key: '/works/OL1W' }] }),
      },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.coverUrl).toBeUndefined();
  });
});

describe('enrich: error handling', () => {
  it('pushes a warning and returns the entry unchanged on network error', async () => {
    const { fn } = routerFetch({ '/isbn/': { throws: 'ECONNREFUSED' } });
    const entry = makeEntry({ isbn: '9780374275631' });
    const result = await enrich(entry, {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry).toEqual(entry);
    expect(result.warnings.some((w) => w.includes('failed to reach Open Library'))).toBe(true);
  });

  it('returns the entry unchanged and warns when a 404 cannot fall back (no title+author)', async () => {
    const { fn } = routerFetch({ '/isbn/': { status: 404 } });
    const entry = makeEntry({ title: '', author: '', isbn: '9780374275631' });
    const result = await enrich(entry, {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry).toEqual(entry);
    expect(result.warnings.some((w) => w.includes('has no record'))).toBe(true);
  });

  it('warns and leaves the cache untouched when a 200 body is not JSON', async () => {
    // Open Library occasionally answers 200 with an HTML error page. That is a
    // failure, not a sparse record, so nothing may be cached: the next build
    // has to retry rather than inherit an empty positive entry.
    const fn = vi.fn(
      async (): Promise<Response> =>
        new Response('<html>oh no</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const cache: Cache = {};
    const entry = makeEntry({ isbn: '9780374275631' });
    const result = await enrich(entry, {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry).toEqual(entry);
    expect(result.warnings.some((w) => w.includes('unparseable response'))).toBe(true);
    expect(cache).toEqual({});
    // The outcome is genuinely unknown, so no match quality is asserted.
    expect(result.matchQuality).toBeUndefined();
  });

  it('pushes a warning and returns the entry unchanged on HTTP 500', async () => {
    const { fn } = routerFetch({ '/isbn/': { status: 500 } });
    const entry = makeEntry({ isbn: '9780374275631' });
    const result = await enrich(entry, {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry).toEqual(entry);
    expect(result.warnings.some((w) => w.includes('500'))).toBe(true);
  });

  it('does not write to cache on a transport failure (HTTP 500)', async () => {
    const { fn } = routerFetch({ '/isbn/': { status: 500 } });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(Object.keys(cache)).toHaveLength(0);
  });

  it('pushes a warning and does not fetch when there is no enrichment path', async () => {
    const fetchImpl = vi.fn();
    const result = await enrich(makeEntry({ title: 'Lonely', author: '' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.warnings).toContainEqual(
      "Entry 'Lonely': no enrichment path (missing olid, isbn, and title+author)",
    );
  });

  it('returns partial data and skips cache when one of two requests fails', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { status: 500 },
    });
    const cache: Cache = {};
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.pageCount).toBe(502);
    expect(result.entry.subjects).toBeUndefined();
    expect(Object.keys(cache)).toHaveLength(0);
  });
});

describe('enrich: cache miss writes', () => {
  it('writes a new cache entry with fetchedAt set to today', async () => {
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']?.fetchedAt).toBe(today);
  });

  it('writes a new cache entry with the correct lookupKey', async () => {
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']?.lookupKey).toBe('isbn:9780374275631');
  });

  it('mutates the cache object passed in', async () => {
    const { fn } = routerFetch({
      '/isbn/': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(Object.keys(cache)).toContain('isbn:9780374275631');
  });
});

describe('enrich: negative cache (404 handling)', () => {
  it('writes a notFound cache entry when the ISBN lookup returns 404', async () => {
    const { fn } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const cache: Cache = {};
    await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']?.notFound).toBe(true);
    expect(cache['isbn:9780374275631']?.data).toEqual({});
  });

  it('writes a notFound cache entry when the OLID lookup returns 404', async () => {
    const { fn } = routerFetch({ 'works/OL1W.json': { status: 404 } });
    const cache: Cache = {};
    await enrich(makeEntry({ olid: 'OL1W' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['olid:OL1W']?.notFound).toBe(true);
  });

  it('writes a notFound cache entry when the title+author search returns no results', async () => {
    const { fn } = routerFetch({ 'search.json': { body: { docs: [] } } });
    const cache: Cache = {};
    await enrich(makeEntry(), { userAgent: USER_AGENT, cache, fetchImpl: fn, rateLimitMs: 0 });
    const key = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    expect(cache[key]?.notFound).toBe(true);
  });

  it('skips the lookup entirely on a cache hit with notFound: true', async () => {
    const fetchImpl = vi.fn();
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: daysAgo(0),
        lookupKey: 'isbn:9780374275631',
        data: {},
        notFound: true,
      },
    };
    await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('emits no warning on a cache hit with notFound: true', async () => {
    const fetchImpl = vi.fn();
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: daysAgo(0),
        lookupKey: 'isbn:9780374275631',
        data: {},
        notFound: true,
      },
    };
    const result = await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('emits exactly one warning naming the lookup when writing a fresh notFound entry', async () => {
    const { fn } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const result = await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.warnings).toEqual([
      "Entry 'The Overstory': Open Library has no record for isbn:9780374275631",
    ]);
  });

  it('refetches a notFound entry older than maxAgeDays', async () => {
    const { fn, calls } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: daysAgo(200),
        lookupKey: 'isbn:9780374275631',
        data: {},
        notFound: true,
      },
    };
    await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
      maxAgeDays: 180,
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('refetches a notFound entry whose key is in the bust list', async () => {
    const { fn, calls } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const cache: Cache = {
      'isbn:9780374275631': {
        fetchedAt: daysAgo(0),
        lookupKey: 'isbn:9780374275631',
        data: {},
        notFound: true,
      },
    };
    await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
      bust: ['isbn:9780374275631'],
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('does NOT mark the entry notFound when only the secondary work lookup 404s', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { status: 404 },
    });
    const cache: Cache = {};
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.entry.pageCount).toBe(502);
    expect(cache['isbn:9780374275631']?.notFound).toBeUndefined();
    expect(cache['isbn:9780374275631']?.data.pageCount).toBe(502);
  });
});

describe('enrich: ISBN 404 fallback to title+author search', () => {
  const fallbackRoutes = (): Record<string, Route> => ({
    '/isbn/9780374275631.json': { status: 404 },
    'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
    'editions.json': { body: { entries: [editionFixture()] } },
  });

  it('falls back to title+author search when the ISBN returns 404 and title+author are present', async () => {
    const { fn, calls } = routerFetch(fallbackRoutes());
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls.some((c) => c.url.includes('search.json'))).toBe(true);
    expect(result.entry.pageCount).toBe(502);
  });

  it('emits a "fell back" warning naming the entry', async () => {
    const { fn } = routerFetch(fallbackRoutes());
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(result.warnings).toContainEqual(
      "Entry 'The Overstory': ISBN not found in Open Library; fell back to title+author search",
    );
  });

  it('caches the successful fallback result under the title-author hash key', async () => {
    const { fn } = routerFetch(fallbackRoutes());
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    const key = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    expect(cache[key]).toBeDefined();
    expect(cache[key]?.notFound).toBeUndefined();
    expect(cache[key]?.data.pageCount).toBe(502);
  });

  it('also caches a notFound entry under the ISBN key', async () => {
    const { fn } = routerFetch(fallbackRoutes());
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']?.notFound).toBe(true);
  });

  it('skips the ISBN lookup and uses the cached fallback result on a subsequent build', async () => {
    const cache: Cache = {};
    const first = routerFetch(fallbackRoutes());
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: first.fn,
      rateLimitMs: 0,
    });
    // Second build: an empty router throws on any request, proving no fetch happens.
    const second = routerFetch({});
    const result = await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: second.fn,
      rateLimitMs: 0,
    });
    expect(second.calls).toHaveLength(0);
    expect(result.entry.pageCount).toBe(502);
  });

  it('does NOT fall back when the entry has an ISBN but no author', async () => {
    const { fn, calls } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const result = await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls.every((c) => !c.url.includes('search.json'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('fell back'))).toBe(false);
    expect(result.warnings.some((w) => w.includes('has no record'))).toBe(true);
  });

  it('does NOT fall back when the entry has an ISBN but no title', async () => {
    const { fn, calls } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const result = await enrich(makeEntry({ title: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache: {},
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(calls.every((c) => !c.url.includes('search.json'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('fell back'))).toBe(false);
  });

  it('caches notFound under BOTH keys when the ISBN and the fallback search both miss', async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { status: 404 },
      'search.json': { body: { docs: [] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    const taKey = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    expect(cache['isbn:9780374275631']?.notFound).toBe(true);
    expect(cache[taKey]?.notFound).toBe(true);
  });
});

describe('enrich: matchQuality on cache entries', () => {
  it("writes matchQuality 'exact' for a successful ISBN lookup", async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { body: editionFixture({ works: [{ key: '/works/OL1W' }] }) },
      'works/OL1W.json': { body: { subjects: ['Trees'] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']?.matchQuality).toBe('exact');
  });

  it("writes matchQuality 'fuzzy' for a successful title+author search", async () => {
    const { fn } = routerFetch({
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry(), { userAgent: USER_AGENT, cache, fetchImpl: fn, rateLimitMs: 0 });
    const key = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    expect(cache[key]?.matchQuality).toBe('fuzzy');
  });

  it("writes matchQuality 'unmatched' on a notFound cache entry", async () => {
    const { fn } = routerFetch({ '/isbn/9780374275631.json': { status: 404 } });
    const cache: Cache = {};
    await enrich(makeEntry({ author: '', isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    expect(cache['isbn:9780374275631']?.matchQuality).toBe('unmatched');
  });

  it("writes 'fuzzy' under the title-author key and 'unmatched' under the ISBN key on a fallback", async () => {
    const { fn } = routerFetch({
      '/isbn/9780374275631.json': { status: 404 },
      'search.json': { body: { docs: [{ key: '/works/OL1W', cover_i: 99 }] } },
      'editions.json': { body: { entries: [editionFixture()] } },
    });
    const cache: Cache = {};
    await enrich(makeEntry({ isbn: '9780374275631' }), {
      userAgent: USER_AGENT,
      cache,
      fetchImpl: fn,
      rateLimitMs: 0,
    });
    const taKey = `title-author:${hashTitleAuthor('The Overstory', 'Richard Powers')}`;
    expect(cache[taKey]?.matchQuality).toBe('fuzzy');
    expect(cache['isbn:9780374275631']?.matchQuality).toBe('unmatched');
  });
});
