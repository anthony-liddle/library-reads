import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cache } from './enrich.js';
import { getReads } from './orchestrator.js';

const USER_AGENT = 'library-reads/0.0.1 (test@example.com)';

const LIBBY_HEADER = 'cover,title,author,publisher,isbn,timestamp,activity,library,details';

interface CsvFields {
  cover?: string;
  title: string;
  author?: string;
  publisher?: string;
  isbn?: string;
  timestamp: string;
  activity?: string;
  library?: string;
  details?: string;
}

/** Quote a CSV field when it contains a comma or quote. */
const quote = (value: string): string =>
  value.includes(',') || value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value;

/** Build one Libby CSV data row from named fields. */
const csvRow = (f: CsvFields): string =>
  [
    f.cover ?? '',
    f.title,
    f.author ?? '',
    f.publisher ?? '',
    f.isbn ?? '',
    f.timestamp,
    f.activity ?? 'Borrowed',
    f.library ?? '',
    f.details ?? '',
  ]
    .map(quote)
    .join(',');

/** Assemble a full Libby CSV from data rows. */
const libbyCsv = (...rows: CsvFields[]): string => [LIBBY_HEADER, ...rows.map(csvRow)].join('\n');

/** A JSON Response with a given status. */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * A permissive mock fetch: returns `{}` (a 200 with no useful fields) for any
 * URL and records each call with a timestamp. Good enough for "enrich ran"
 * assertions where the enrichment payload itself does not matter.
 */
const okFetch = () => {
  const calls: { url: string; at: number }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    calls.push({ url: String(input), at: Date.now() });
    return json({});
  });
  return { fn, calls };
};

/** A mock fetch that throws on every request (simulating Open Library down). */
const throwingFetch = () => {
  const calls: { url: string; at: number }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    calls.push({ url: String(input), at: Date.now() });
    throw new Error('ECONNREFUSED');
  });
  return { fn, calls };
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'library-reads-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('getReads: input resolution', () => {
  it('accepts libby as { content }', async () => {
    const result = await getReads({
      libby: { content: libbyCsv({ title: 'Dune', timestamp: 'January 15, 2024 10:30' }) },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts libby as { path }, reading from disk', async () => {
    const path = join(tmp, 'libby.csv');
    writeFileSync(path, libbyCsv({ title: 'Dune', timestamp: 'January 15, 2024 10:30' }));
    const result = await getReads({
      libby: { path },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts libby as { fetch }, calling the user-supplied fetcher', async () => {
    const fetch = vi.fn(async () =>
      libbyCsv({ title: 'Dune', timestamp: 'January 15, 2024 10:30' }),
    );
    const result = await getReads({
      libby: { fetch },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts extras as { content, format: "yaml" }', async () => {
    const result = await getReads({
      extras: {
        content: '- title: Dune\n  author: Frank Herbert\n  status: finished',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts extras as { content, format: "json" }', async () => {
    const result = await getReads({
      extras: {
        content: JSON.stringify([{ title: 'Dune', author: 'Frank Herbert', status: 'finished' }]),
        format: 'json',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts extras as { path } ending in .yaml, inferring format', async () => {
    const path = join(tmp, 'extras.yaml');
    writeFileSync(path, '- title: Dune\n  author: Frank Herbert\n  status: finished');
    const result = await getReads({
      extras: { path },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts extras as { path } ending in .yml, inferring format', async () => {
    const path = join(tmp, 'extras.yml');
    writeFileSync(path, '- title: Dune\n  author: Frank Herbert\n  status: finished');
    const result = await getReads({
      extras: { path },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].title).toBe('Dune');
  });

  it('accepts extras as { path } ending in .json, inferring format', async () => {
    const path = join(tmp, 'extras.json');
    writeFileSync(
      path,
      JSON.stringify([{ title: 'Dune', author: 'Frank Herbert', status: 'finished' }]),
    );
    const result = await getReads({
      extras: { path },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].title).toBe('Dune');
  });

  it('warns and skips extras when { path } extension is unknown', async () => {
    const path = join(tmp, 'extras.txt');
    writeFileSync(path, '- title: Dune\n  author: Frank Herbert\n  status: finished');
    const result = await getReads({
      extras: { path },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('extension'))).toBe(true);
  });

  it('warns when extras is { content } without format', async () => {
    const result = await getReads({
      extras: { content: '- title: Dune\n  author: Frank Herbert\n  status: finished' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes('format'))).toBe(true);
  });

  it('returns empty entries with a warning when neither libby nor extras is provided', async () => {
    const result = await getReads({ userAgent: USER_AGENT, skipEnrichment: true });
    expect(result.entries).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('getReads: parsing pipeline', () => {
  it('propagates Libby parser warnings into the result', async () => {
    const result = await getReads({
      libby: { content: 'wrong,header,row\na,b,c' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.warnings.some((w) => w.includes('Header'))).toBe(true);
  });

  it('propagates extras parser warnings into the result', async () => {
    const result = await getReads({
      extras: { content: '- title: Dune', format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.warnings.some((w) => w.includes('status'))).toBe(true);
  });

  it('continues when one source has zero valid entries', async () => {
    const result = await getReads({
      libby: { content: libbyCsv({ title: 'Dune', timestamp: 'January 15, 2024 10:30' }) },
      extras: { content: 'not: a list', format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Dune');
  });
});

describe('getReads: normalization', () => {
  it("gives Libby entries provenance 'libby', status 'borrowed', source 'library'", async () => {
    const result = await getReads({
      libby: { content: libbyCsv({ title: 'Dune', timestamp: 'January 15, 2024 10:30' }) },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    const entry = result.entries[0];
    expect(entry.provenance).toBe('libby');
    expect(entry.status).toBe('borrowed');
    expect(entry.source).toBe('library');
  });

  it("gives extras entries provenance 'extras' and preserves user fields", async () => {
    const result = await getReads({
      extras: {
        content:
          '- title: Dune\n  author: Frank Herbert\n  status: reading\n  source: Powells\n  notes: a reread',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    const entry = result.entries[0];
    expect(entry.provenance).toBe('extras');
    expect(entry.status).toBe('reading');
    expect(entry.source).toBe('Powells');
    expect(entry.notes).toBe('a reread');
  });

  it("sets Libby entries' borrowedAt to the parser's normalized date", async () => {
    const result = await getReads({
      libby: { content: libbyCsv({ title: 'Dune', timestamp: 'January 15, 2024 10:30' }) },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].borrowedAt).toBe('2024-01-15');
  });
});

describe('getReads: merge semantics (same ISBN)', () => {
  const libbyBorrowed = libbyCsv({
    title: 'Dune',
    author: 'Frank Herbert',
    publisher: 'Ace',
    isbn: '978-0-441-17271-9',
    timestamp: 'January 15, 2024 10:30',
    library: 'County Library',
  });
  const extrasFinished = (extra = '') =>
    `- isbn: "9780441172719"\n  title: Dune\n  author: Frank Herbert\n  status: finished\n  finishedAt: "2024-02-01"${extra}`;

  it('merges Libby borrowed + extras finished into one entry with extras status', async () => {
    const result = await getReads({
      libby: { content: libbyBorrowed },
      extras: { content: extrasFinished(), format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('finished');
  });

  it('merges date fields additively', async () => {
    const result = await getReads({
      libby: { content: libbyBorrowed },
      extras: { content: extrasFinished(), format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    const entry = result.entries[0];
    expect(entry.borrowedAt).toBe('2024-01-15');
    expect(entry.finishedAt).toBe('2024-02-01');
  });

  it("uses extras format over Libby's", async () => {
    const result = await getReads({
      libby: { content: libbyBorrowed },
      extras: { content: extrasFinished('\n  format: audiobook'), format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].format).toBe('audiobook');
  });

  it("uses extras source over Libby's 'library' default", async () => {
    const result = await getReads({
      libby: { content: libbyBorrowed },
      extras: { content: extrasFinished('\n  source: Audible'), format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].source).toBe('Audible');
  });

  it("preserves Libby's library and publisher on the merged entry", async () => {
    const result = await getReads({
      libby: { content: libbyBorrowed },
      extras: { content: extrasFinished(), format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    const entry = result.entries[0];
    expect(entry.library).toBe('County Library');
    expect(entry.publisher).toBe('Ace');
  });

  it('matches ISBNs ignoring hyphens and case', async () => {
    const libby = libbyCsv({
      title: 'Some Book',
      author: 'An Author',
      isbn: '0-9752-2980-X',
      timestamp: 'January 15, 2024 10:30',
    });
    const extras =
      '- isbn: "097522980x"\n  title: Some Book\n  author: An Author\n  status: finished\n  finishedAt: "2024-02-01"';
    const result = await getReads({
      libby: { content: libby },
      extras: { content: extras, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe('finished');
  });

  it('never auto-merges entries without ISBNs', async () => {
    const result = await getReads({
      libby: {
        content: libbyCsv({
          title: 'Dune',
          author: 'Frank Herbert',
          timestamp: 'January 15, 2024 10:30',
        }),
      },
      extras: {
        content:
          '- title: Dune\n  author: Frank Herbert\n  status: finished\n  finishedAt: "2024-02-01"',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(2);
  });

  it("gives a merged entry provenance 'extras'", async () => {
    const result = await getReads({
      libby: { content: libbyBorrowed },
      extras: { content: extrasFinished(), format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].provenance).toBe('extras');
  });
});

describe('getReads: enrichment', () => {
  it('calls enrich for each entry', async () => {
    const { fn, calls } = okFetch();
    await getReads({
      libby: {
        content: libbyCsv(
          { title: 'A', author: 'X', isbn: '9780000000001', timestamp: 'January 1, 2024 10:30' },
          { title: 'B', author: 'Y', isbn: '9780000000002', timestamp: 'January 2, 2024 10:30' },
        ),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    // Each isbn entry triggers at least one /isbn request.
    expect(calls.some((c) => c.url.includes('9780000000001'))).toBe(true);
    expect(calls.some((c) => c.url.includes('9780000000002'))).toBe(true);
  });

  it('shares rate-limiter state across enrich calls', async () => {
    const { fn, calls } = okFetch();
    await getReads({
      libby: {
        content: libbyCsv(
          { title: 'A', author: 'X', isbn: '9780000000001', timestamp: 'January 1, 2024 10:30' },
          { title: 'B', author: 'Y', isbn: '9780000000002', timestamp: 'January 2, 2024 10:30' },
        ),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 40,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The second entry's first request must wait for the first entry's budget.
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(40);
  });

  it('skips enrichment entirely when skipEnrichment is true', async () => {
    const { fn, calls } = okFetch();
    await getReads({
      libby: {
        content: libbyCsv({
          title: 'A',
          isbn: '9780000000001',
          timestamp: 'January 1, 2024 10:30',
        }),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      skipEnrichment: true,
    });
    expect(calls).toHaveLength(0);
  });

  it('propagates enrichment warnings into the result', async () => {
    const { fn } = throwingFetch();
    const result = await getReads({
      libby: {
        content: libbyCsv({
          title: 'A',
          isbn: '9780000000001',
          timestamp: 'January 1, 2024 10:30',
        }),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings.some((w) => w.includes('failed to reach Open Library'))).toBe(true);
  });

  it('passes the cache read from disk to enrich', async () => {
    const cachePath = join(tmp, 'cache.json');
    const cache: Cache = {
      'isbn:9780000000001': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        lookupKey: 'isbn:9780000000001',
        data: { pageCount: 999 },
      },
    };
    writeFileSync(cachePath, JSON.stringify(cache));
    const { fn, calls } = throwingFetch();
    const result = await getReads({
      libby: {
        content: libbyCsv({
          title: 'A',
          isbn: '9780000000001',
          timestamp: 'January 1, 2024 10:30',
        }),
      },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    // Cache hit means no network call and the cached pageCount lands on the entry.
    expect(calls).toHaveLength(0);
    expect(result.entries[0].pageCount).toBe(999);
  });
});

describe('getReads: sortDate computation', () => {
  const sortDateFor = async (yaml: string): Promise<string> => {
    const result = await getReads({
      extras: { content: yaml, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
      includePrivate: true,
    });
    return result.entries[0].sortDate;
  };

  it('uses finishedAt for a finished entry', async () => {
    expect(
      await sortDateFor(
        '- title: A\n  author: X\n  status: finished\n  finishedAt: "2024-02-01"\n  startedAt: "2024-01-01"',
      ),
    ).toBe('2024-02-01');
  });

  it('falls back to startedAt for a finished entry with no finishedAt', async () => {
    expect(
      await sortDateFor('- title: A\n  author: X\n  status: finished\n  startedAt: "2024-01-01"'),
    ).toBe('2024-01-01');
  });

  it('uses finishedAt then startedAt for an abandoned entry', async () => {
    expect(
      await sortDateFor(
        '- title: A\n  author: X\n  status: abandoned\n  startedAt: "2024-01-01"\n  finishedAt: "2024-01-20"',
      ),
    ).toBe('2024-01-20');
    expect(
      await sortDateFor('- title: A\n  author: X\n  status: abandoned\n  startedAt: "2024-01-01"'),
    ).toBe('2024-01-01');
  });

  it('uses startedAt for a reading entry', async () => {
    expect(
      await sortDateFor('- title: A\n  author: X\n  status: reading\n  startedAt: "2024-03-01"'),
    ).toBe('2024-03-01');
  });

  it('uses borrowedAt for a borrowed entry', async () => {
    expect(
      await sortDateFor('- title: A\n  author: X\n  status: borrowed\n  borrowedAt: "2024-04-01"'),
    ).toBe('2024-04-01');
  });

  it("gives '' to an entry with no relevant date", async () => {
    expect(await sortDateFor('- title: A\n  author: X\n  status: finished')).toBe('');
  });
});

describe('getReads: private filter', () => {
  it('excludes private: true entries by default', async () => {
    const result = await getReads({
      extras: {
        content:
          '- title: A\n  author: X\n  status: finished\n  finishedAt: "2024-01-01"\n  private: true',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(0);
  });

  it('includes private: true entries when includePrivate is true', async () => {
    const result = await getReads({
      extras: {
        content:
          '- title: A\n  author: X\n  status: finished\n  finishedAt: "2024-01-01"\n  private: true',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
      includePrivate: true,
    });
    expect(result.entries).toHaveLength(1);
  });

  it('applies the private filter after merge', async () => {
    const libby = libbyCsv({
      title: 'Dune',
      author: 'Frank Herbert',
      isbn: '9780441172719',
      timestamp: 'January 15, 2024 10:30',
    });
    const extras =
      '- isbn: "9780441172719"\n  title: Dune\n  author: Frank Herbert\n  status: finished\n  finishedAt: "2024-02-01"\n  private: true';
    const result = await getReads({
      libby: { content: libby },
      extras: { content: extras, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(0);
  });
});

describe('getReads: sort and limit', () => {
  const threeExtras =
    '- title: Old\n  author: X\n  status: finished\n  finishedAt: "2024-01-01"\n' +
    '- title: New\n  author: X\n  status: finished\n  finishedAt: "2024-03-01"\n' +
    '- title: Mid\n  author: X\n  status: finished\n  finishedAt: "2024-02-01"';

  it('sorts entries descending by sortDate', async () => {
    const result = await getReads({
      extras: { content: threeExtras, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries.map((e) => e.title)).toEqual(['New', 'Mid', 'Old']);
  });

  it('applies limit after sort', async () => {
    const result = await getReads({
      extras: { content: threeExtras, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
      limit: 2,
    });
    expect(result.entries.map((e) => e.title)).toEqual(['New', 'Mid']);
  });

  it('returns no entries when limit is 0', async () => {
    const result = await getReads({
      extras: { content: threeExtras, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
      limit: 0,
    });
    expect(result.entries).toHaveLength(0);
  });

  it('returns empty entries with no limit when there is no input', async () => {
    const result = await getReads({ userAgent: USER_AGENT, skipEnrichment: true });
    expect(result.entries).toHaveLength(0);
  });
});

describe('getReads: cache I/O', () => {
  const oneIsbn = libbyCsv({
    title: 'A',
    isbn: '9780000000001',
    timestamp: 'January 1, 2024 10:30',
  });

  it('reads from cache.path when given', async () => {
    const cachePath = join(tmp, 'cache.json');
    const cache: Cache = {
      'isbn:9780000000001': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        lookupKey: 'isbn:9780000000001',
        data: { pageCount: 123 },
      },
    };
    writeFileSync(cachePath, JSON.stringify(cache));
    const { fn } = throwingFetch();
    const result = await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.entries[0].pageCount).toBe(123);
  });

  it('persists a notFound entry across builds and reuses it without refetching', async () => {
    const cachePath = join(tmp, 'cache.json');
    const ghost = libbyCsv({
      title: 'Ghost',
      isbn: '9780000000009',
      timestamp: 'January 1, 2024 10:30',
    });
    // First build: Open Library 404s, so a notFound entry is written.
    const fn1 = vi.fn(async (): Promise<Response> => json({}, 404));
    await getReads({
      libby: { content: ghost },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn1 as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    const written: Record<string, { notFound?: boolean }> = JSON.parse(
      readFileSync(cachePath, 'utf-8'),
    );
    expect(written['isbn:9780000000009']?.notFound).toBe(true);

    // Second build: Open Library is down, but the cached notFound skips the fetch.
    const { fn: fn2, calls } = throwingFetch();
    const result = await getReads({
      libby: { content: ghost },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn2 as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(calls).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
  });

  it('creates an empty cache when the file does not exist (no warning)', async () => {
    const cachePath = join(tmp, 'missing.json');
    const result = await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.warnings.some((w) => w.toLowerCase().includes('cache'))).toBe(false);
  });

  it('warns and starts fresh when the cache file is malformed JSON', async () => {
    const cachePath = join(tmp, 'cache.json');
    writeFileSync(cachePath, '{ not valid json');
    const result = await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.warnings.some((w) => w.toLowerCase().includes('cache'))).toBe(true);
  });

  it('writes the cache back to disk after enrichment', async () => {
    const cachePath = join(tmp, 'cache.json');
    const { fn } = okFetch();
    await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(existsSync(cachePath)).toBe(true);
    const written = JSON.parse(readFileSync(cachePath, 'utf-8')) as Cache;
    expect(written['isbn:9780000000001']).toBeDefined();
  });

  it('leaves no tmp file behind after a successful write', async () => {
    const cachePath = join(tmp, 'cache.json');
    const { fn } = okFetch();
    await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(existsSync(`${cachePath}.tmp`)).toBe(false);
  });

  it('writes pretty-printed JSON (2-space indent)', async () => {
    const cachePath = join(tmp, 'cache.json');
    const { fn } = okFetch();
    await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    const raw = readFileSync(cachePath, 'utf-8');
    expect(raw).toContain('\n  "isbn:9780000000001"');
  });

  it('skips the read but still writes back when ignoreReads is set', async () => {
    const cachePath = join(tmp, 'cache.json');
    const cache: Cache = {
      'isbn:9780000000001': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        lookupKey: 'isbn:9780000000001',
        data: { pageCount: 123 },
      },
    };
    writeFileSync(cachePath, JSON.stringify(cache));
    const { fn, calls } = okFetch();
    await getReads({
      libby: { content: oneIsbn },
      cache: { path: cachePath, ignoreReads: true },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    // ignoreReads forces a refetch (the read is skipped) ...
    expect(calls.length).toBeGreaterThan(0);
    // ... and the cache is still written back.
    expect(existsSync(cachePath)).toBe(true);
  });
});

describe('getReads: Open Library unavailable rollup', () => {
  const twoIsbn = libbyCsv(
    { title: 'A', isbn: '9780000000001', timestamp: 'January 1, 2024 10:30' },
    { title: 'B', isbn: '9780000000002', timestamp: 'January 2, 2024 10:30' },
  );

  it('prepends the rollup warning when more than half of attempts fail with transport errors', async () => {
    const { fn } = throwingFetch();
    const result = await getReads({
      libby: { content: twoIsbn },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings[0]).toContain('Open Library appears to be unavailable');
    expect(result.warnings[0]).toContain('2 of 2');
  });

  it('does NOT prepend the rollup when failures are fuzzy-match warnings', async () => {
    // No ISBN -> search path. A doc match produces a fuzzy warning but a 200.
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('search.json')) {
        return json({ docs: [{ key: '/works/OL1W' }] });
      }
      return json({});
    });
    const result = await getReads({
      libby: {
        content: libbyCsv(
          { title: 'A', author: 'X', timestamp: 'January 1, 2024 10:30' },
          { title: 'B', author: 'Y', timestamp: 'January 2, 2024 10:30' },
        ),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings.some((w) => w.includes('fuzzy'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('appears to be unavailable'))).toBe(false);
  });

  it('does NOT prepend the rollup for no-enrichment-path warnings', async () => {
    const { fn, calls } = okFetch();
    const result = await getReads({
      // title only, no author, no isbn -> no enrichment path, no fetch.
      libby: { content: libbyCsv({ title: 'A', timestamp: 'January 1, 2024 10:30' }) },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(calls).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('no enrichment path'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('appears to be unavailable'))).toBe(false);
  });

  it('counts only actual enrichment attempts (cache hits are not attempts)', async () => {
    const cachePath = join(tmp, 'cache.json');
    const cache: Cache = {
      'isbn:9780000000001': {
        fetchedAt: new Date().toISOString().slice(0, 10),
        lookupKey: 'isbn:9780000000001',
        data: { pageCount: 1 },
      },
    };
    writeFileSync(cachePath, JSON.stringify(cache));
    const { fn } = throwingFetch();
    const result = await getReads({
      libby: { content: twoIsbn },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    // Entry A is a cache hit (not an attempt); entry B fetches and fails.
    // So 1 of 1 attempts failed -> rollup fires.
    expect(result.warnings[0]).toContain('1 of 1');
  });

  it('puts the rollup warning first in the array', async () => {
    const { fn } = throwingFetch();
    const result = await getReads({
      libby: { content: twoIsbn },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings[0]).toContain('Open Library appears to be unavailable');
  });

  it('does NOT fire when every enrichment attempt returned 404', async () => {
    const fn = vi.fn(async (): Promise<Response> => json({}, 404));
    const result = await getReads({
      libby: { content: twoIsbn },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings.some((w) => w.includes('appears to be unavailable'))).toBe(false);
    expect(result.warnings.some((w) => w.includes('has no record'))).toBe(true);
  });

  it('still fires when most enrichment attempts returned HTTP 500', async () => {
    const fn = vi.fn(async (): Promise<Response> => json({}, 500));
    const result = await getReads({
      libby: { content: twoIsbn },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.warnings[0]).toContain('Open Library appears to be unavailable');
    expect(result.warnings[0]).toContain('2 of 2');
  });

  it('does NOT fire for a mix of 404s and a single transport error', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('/isbn/9780000000001')) {
        throw new Error('ECONNREFUSED');
      }
      return json({}, 404);
    });
    const result = await getReads({
      libby: {
        content: libbyCsv(
          { title: 'A', isbn: '9780000000001', timestamp: 'January 1, 2024 10:30' },
          { title: 'B', isbn: '9780000000002', timestamp: 'January 2, 2024 10:30' },
          { title: 'C', isbn: '9780000000003', timestamp: 'January 3, 2024 10:30' },
        ),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    // 1 transport failure of 3 attempts is below the half threshold.
    expect(result.warnings.some((w) => w.includes('appears to be unavailable'))).toBe(false);
    expect(result.warnings.some((w) => w.includes('failed to reach'))).toBe(true);
  });
});

describe('getReads: ISBN 404 title+author fallback', () => {
  it('reuses a cached fallback result across builds through the cache file (no refetch)', async () => {
    const cachePath = join(tmp, 'cache.json');
    const libby = libbyCsv({
      title: 'Fallback Book',
      author: 'Some Author',
      isbn: '9780000000001',
      timestamp: 'January 1, 2024 10:30',
    });
    // First build: ISBN 404s, fallback search resolves and is enriched.
    const fn1 = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/isbn/')) {
        return json({}, 404);
      }
      if (url.includes('search.json')) {
        return json({ docs: [{ key: '/works/OL1W', cover_i: 5 }] });
      }
      if (url.includes('editions.json')) {
        return json({ entries: [{ number_of_pages: 350, covers: [5] }] });
      }
      return json({});
    });
    await getReads({
      libby: { content: libby },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn1 as unknown as typeof fetch,
      rateLimitMs: 0,
    });

    // Second build: Open Library is down. The notFound-ISBN must resolve to the
    // cached title-author fallback, so no fetch happens and the entry stays enriched.
    const { fn: fn2, calls } = throwingFetch();
    const result = await getReads({
      libby: { content: libby },
      cache: { path: cachePath },
      userAgent: USER_AGENT,
      fetchImpl: fn2 as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(calls).toHaveLength(0);
    expect(result.entries.find((e) => e.title === 'Fallback Book')?.pageCount).toBe(350);
  });

  it('enriches via fallback search and does not fire the unavailable rollup', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/isbn/')) {
        return json({}, 404);
      }
      if (url.includes('search.json')) {
        return json({ docs: [{ key: '/works/OL1W', cover_i: 5 }] });
      }
      if (url.includes('editions.json')) {
        return json({
          entries: [{ number_of_pages: 350, covers: [5], physical_format: 'Hardcover' }],
        });
      }
      return json({});
    });
    const result = await getReads({
      libby: {
        content: libbyCsv({
          title: 'Fallback Book',
          author: 'Some Author',
          isbn: '9780000000001',
          timestamp: 'January 1, 2024 10:30',
        }),
      },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    const entry = result.entries.find((e) => e.title === 'Fallback Book');
    expect(entry?.pageCount).toBe(350);
    expect(result.warnings.some((w) => w.includes('fell back'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('appears to be unavailable'))).toBe(false);
  });
});

describe('getReads: lastEntryDate', () => {
  it('equals the max sortDate of the returned entries', async () => {
    const result = await getReads({
      extras: {
        content:
          '- title: Old\n  author: X\n  status: finished\n  finishedAt: "2024-01-01"\n' +
          '- title: New\n  author: X\n  status: finished\n  finishedAt: "2024-03-01"',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.lastEntryDate).toBe('2024-03-01');
  });

  it('is undefined when entries is empty', async () => {
    const result = await getReads({ userAgent: USER_AGENT, skipEnrichment: true });
    expect(result.lastEntryDate).toBeUndefined();
  });
});

describe('getReads: full pipeline integration', () => {
  it('merges, enriches, sorts, and filters a realistic mix of sources', async () => {
    const libby = libbyCsv(
      {
        title: 'Dune',
        author: 'Frank Herbert',
        publisher: 'Ace',
        isbn: '9780441172719',
        timestamp: 'January 15, 2024 10:30',
        library: 'County Library',
      },
      {
        title: 'Neuromancer',
        author: 'William Gibson',
        isbn: '9780441569595',
        timestamp: 'February 1, 2024 09:00',
      },
      {
        title: 'Snow Crash',
        author: 'Neal Stephenson',
        isbn: '9780553380958',
        timestamp: 'March 1, 2024 09:00',
      },
    );
    const extras =
      '- isbn: "9780441172719"\n  title: Dune\n  author: Frank Herbert\n  status: finished\n  finishedAt: "2024-04-01"\n' +
      '- title: The Dispossessed\n  author: Ursula K. Le Guin\n  status: reading\n  startedAt: "2024-03-15"';

    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/isbn/9780441172719')) {
        return json({ number_of_pages: 412, covers: [1], works: [{ key: '/works/OLDUNEW' }] });
      }
      if (url.includes('works/OLDUNEW.json')) {
        return json({ subjects: ['Science Fiction'] });
      }
      return json({});
    });

    const result = await getReads({
      libby: { content: libby },
      extras: { content: extras, format: 'yaml' },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });

    // 3 libby + 2 extras, one merged by ISBN (Dune) -> 4 entries.
    expect(result.entries).toHaveLength(4);

    // Dune merged: extras status + finishedAt wins, libby library preserved, enriched pageCount.
    const dune = result.entries.find((e) => e.title === 'Dune');
    expect(dune?.status).toBe('finished');
    expect(dune?.finishedAt).toBe('2024-04-01');
    expect(dune?.library).toBe('County Library');
    expect(dune?.pageCount).toBe(412);
    expect(dune?.subjects).toEqual(['Science Fiction']);
    expect(dune?.provenance).toBe('extras');

    // Sorted descending: Dune (2024-04-01) first.
    expect(result.entries[0].title).toBe('Dune');
    expect(result.lastEntryDate).toBe('2024-04-01');
  });
});

describe('getReads: Libby cover fallback', () => {
  const LIBBY_COVER = 'https://ol.example/libby-cover.jpg';
  const OL_COVER = 'https://covers.openlibrary.org/b/id/1-L.jpg';

  const libbyWithCover = (isbn = '9780000000001'): string =>
    libbyCsv({
      cover: LIBBY_COVER,
      title: 'A',
      author: 'X',
      isbn,
      timestamp: 'January 1, 2024 10:30',
    });

  it('uses the Open Library cover when enrichment succeeds (Libby cover ignored)', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/isbn/')) {
        return json({ covers: [1], works: [{ key: '/works/OL1W' }] });
      }
      return json({});
    });
    const result = await getReads({
      libby: { content: libbyWithCover() },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.entries[0].coverUrl).toBe(OL_COVER);
  });

  it('uses the Libby cover when Open Library has no cover', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/isbn/')) {
        return json({ number_of_pages: 100, works: [{ key: '/works/OL1W' }] });
      }
      return json({});
    });
    const result = await getReads({
      libby: { content: libbyWithCover() },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.entries[0].coverUrl).toBe(LIBBY_COVER);
  });

  it('uses the Libby cover when enrichment fails entirely (404)', async () => {
    const fn = vi.fn(async (): Promise<Response> => json({}, 404));
    const result = await getReads({
      libby: { content: libbyWithCover() },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.entries[0].coverUrl).toBe(LIBBY_COVER);
  });

  it('uses the Libby cover when skipEnrichment is true', async () => {
    const result = await getReads({
      libby: { content: libbyWithCover() },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].coverUrl).toBe(LIBBY_COVER);
  });

  it('preserves the Libby cover on a merged entry when no other cover is available', async () => {
    const extras =
      '- isbn: "9780000000001"\n  title: A\n  author: X\n  status: finished\n  finishedAt: "2024-02-01"';
    const result = await getReads({
      libby: { content: libbyWithCover() },
      extras: { content: extras, format: 'yaml' },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provenance).toBe('extras');
    expect(result.entries[0].coverUrl).toBe(LIBBY_COVER);
  });

  it('keeps the Libby fallback on a merged entry through real enrichment that finds no cover', async () => {
    const extras =
      '- isbn: "9780000000001"\n  title: A\n  author: X\n  status: finished\n  finishedAt: "2024-02-01"';
    // Enrichment runs (no skip) and succeeds, but the edition carries no cover,
    // so the merged entry must fall back to the forwarded Libby cover.
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/isbn/')) {
        return json({ number_of_pages: 100, works: [{ key: '/works/OL1W' }] });
      }
      return json({});
    });
    const result = await getReads({
      libby: { content: libbyWithCover() },
      extras: { content: extras, format: 'yaml' },
      userAgent: USER_AGENT,
      fetchImpl: fn as unknown as typeof fetch,
      rateLimitMs: 0,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].provenance).toBe('extras');
    expect(result.entries[0].pageCount).toBe(100);
    expect(result.entries[0].coverUrl).toBe(LIBBY_COVER);
  });

  it('leaves coverUrl undefined when Libby had no cover and enrichment found none', async () => {
    const result = await getReads({
      libby: {
        content: libbyCsv({
          title: 'A',
          author: 'X',
          isbn: '9780000000001',
          timestamp: 'January 1, 2024 10:30',
        }),
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].coverUrl).toBeUndefined();
  });

  it('gives an extras-only entry no Libby fallback', async () => {
    const result = await getReads({
      extras: {
        content: '- title: A\n  author: X\n  status: finished\n  finishedAt: "2024-02-01"',
        format: 'yaml',
      },
      userAgent: USER_AGENT,
      skipEnrichment: true,
    });
    expect(result.entries[0].coverUrl).toBeUndefined();
  });
});
