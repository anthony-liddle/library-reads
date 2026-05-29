import { describe, expect, it } from 'vitest';
import { parseExtras } from './extras.js';

/** Build a YAML document from lines, keeping indentation explicit and correct. */
const yaml = (...lines: string[]): string => lines.join('\n');

describe('parseExtras: happy path', () => {
  it('parses a clean YAML list of three entries with all fields populated', () => {
    const content = yaml(
      '- status: finished',
      '  isbn: "9780374275631"',
      '  title: The Overstory',
      '  author: Richard Powers',
      '- status: reading',
      '  isbn: "9780525559474"',
      '  title: The Midnight Library',
      '  author: Matt Haig',
      '- status: borrowed',
      '  isbn: "9781250301697"',
      '  title: Mexican Gothic',
      '  author: Silvia Moreno-Garcia',
    );

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.title)).toEqual([
      'The Overstory',
      'The Midnight Library',
      'Mexican Gothic',
    ]);
    expect(result.entries.map((e) => e.status)).toEqual(['finished', 'reading', 'borrowed']);
  });

  it('parses a clean JSON list with the same shape', () => {
    const content = JSON.stringify([
      {
        status: 'finished',
        isbn: '9780374275631',
        title: 'The Overstory',
        author: 'Richard Powers',
      },
      {
        status: 'reading',
        isbn: '9780525559474',
        title: 'The Midnight Library',
        author: 'Matt Haig',
      },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.title).toBe('The Overstory');
  });

  it('preserves all valid fields verbatim', () => {
    const content = yaml(
      '- isbn: "9780374275631"',
      '  olid: OL12345W',
      '  title: The Overstory',
      '  author: Richard Powers',
      '  status: finished',
      '  format: physical',
      '  source: "Powell\'s"',
      '  startedAt: 2026-04-12',
      '  finishedAt: 2026-05-01',
      '  borrowedAt: 2026-04-10',
      '  notes: Loved it',
      '  private: false',
    );

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      isbn: '9780374275631',
      olid: 'OL12345W',
      title: 'The Overstory',
      author: 'Richard Powers',
      status: 'finished',
      format: 'physical',
      source: "Powell's",
      startedAt: '2026-04-12',
      finishedAt: '2026-05-01',
      borrowedAt: '2026-04-10',
      notes: 'Loved it',
      private: false,
    });
  });

  it('accepts an entry with only isbn (no title or author)', () => {
    const content = yaml('- status: borrowed', '  isbn: "9781234567890"');

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.isbn).toBe('9781234567890');
    expect(result.entries[0]?.title).toBeUndefined();
    expect(result.entries[0]?.author).toBeUndefined();
  });

  it('accepts an entry with only title and author (no isbn)', () => {
    const content = yaml('- status: reading', '  title: Some Book', '  author: Some Author');

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.isbn).toBeUndefined();
    expect(result.entries[0]?.title).toBe('Some Book');
  });

  it('accepts an entry with both isbn and title and author with no warning', () => {
    const content = yaml(
      '- status: finished',
      '  isbn: "9781234567890"',
      '  title: Some Book',
      '  author: Some Author',
    );

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });
});

describe('parseExtras: status validation', () => {
  it('accepts each of the four valid status values', () => {
    const content = JSON.stringify([
      { status: 'borrowed', isbn: '1111111111' },
      { status: 'reading', isbn: '2222222222' },
      { status: 'finished', isbn: '3333333333' },
      { status: 'abandoned', isbn: '4444444444' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries.map((e) => e.status)).toEqual([
      'borrowed',
      'reading',
      'finished',
      'abandoned',
    ]);
  });

  it('rejects an entry with an unknown status with a warning naming the entry', () => {
    const content = yaml('- status: borrowing', '  isbn: "9781234567890"');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('9781234567890');
    expect(result.warnings[0]).toContain('status');
  });

  it('rejects an entry with a missing status with a warning naming the entry', () => {
    const content = yaml('- isbn: "9781234567890"', '  title: No Status Book');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('No Status Book');
    expect(result.warnings[0]).toContain('status');
  });
});

describe('parseExtras: identifier requirement', () => {
  it('rejects an entry with neither isbn nor title and author with a warning', () => {
    const content = yaml('- status: finished', '  notes: just a note');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('isbn');
    expect(result.warnings[0]).toContain('title');
    expect(result.warnings[0]).toContain('author');
  });

  it('rejects an entry with only title (no author and no isbn) with a warning', () => {
    const content = yaml('- status: finished', '  title: Lonely Title');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Lonely Title');
  });

  it('rejects an entry with only author (no title and no isbn) with a warning', () => {
    const content = yaml('- status: finished', '  author: Lonely Author');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('parseExtras: format validation', () => {
  it('accepts each of the three valid format values', () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '1111111111', format: 'audiobook' },
      { status: 'finished', isbn: '2222222222', format: 'ebook' },
      { status: 'finished', isbn: '3333333333', format: 'physical' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries.map((e) => e.format)).toEqual(['audiobook', 'ebook', 'physical']);
  });

  it('rejects an entry with an unknown format value with a warning', () => {
    const content = yaml('- status: finished', '  isbn: "9781234567890"', '  format: hardcover');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('format');
  });

  it('accepts an entry with no format field since format is optional', () => {
    const content = yaml('- status: finished', '  isbn: "9781234567890"');

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.format).toBeUndefined();
  });
});

describe('parseExtras: source field', () => {
  it('accepts a free-form source string and preserves it verbatim', () => {
    const content = yaml('- status: finished', '  isbn: "9781234567890"', '  source: Audible');

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.source).toBe('Audible');
  });

  it('accepts an entry with no source field since source is optional', () => {
    const content = yaml('- status: finished', '  isbn: "9781234567890"');

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toBeUndefined();
  });

  it('preserves a source value that contains an apostrophe', () => {
    const content = yaml('- status: finished', '  isbn: "9781234567890"', '  source: "Powell\'s"');

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.source).toBe("Powell's");
  });

  it('preserves a source value that contains spaces', () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '9781234567890', source: 'borrowed from Joel' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.source).toBe('borrowed from Joel');
  });

  it('rejects a non-string source with a warning', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', source: 123 }]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('source');
  });

  it('rejects an empty-string source with a warning', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', source: '' }]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('source');
  });
});

describe('parseExtras: date validation', () => {
  it('accepts an entry with a valid ISO date in each date field', () => {
    const content = yaml(
      '- status: finished',
      '  isbn: "9781234567890"',
      '  startedAt: 2026-04-12',
      '  finishedAt: 2026-05-01',
      '  borrowedAt: 2026-04-10',
    );

    const result = parseExtras(content, 'yaml');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.startedAt).toBe('2026-04-12');
    expect(result.entries[0]?.finishedAt).toBe('2026-05-01');
    expect(result.entries[0]?.borrowedAt).toBe('2026-04-10');
  });

  it("rejects '4/12/2026' as a startedAt with a warning", () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '9780374275631', startedAt: '4/12/2026' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('startedAt');
    expect(result.warnings[0]).toContain('4/12/2026');
  });

  it("rejects a datetime '2026-04-12T00:00:00' as a finishedAt with a warning", () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '9780374275631', finishedAt: '2026-04-12T00:00:00' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('finishedAt');
  });

  it("rejects a rollover date '2026-13-45' as a borrowedAt with a warning", () => {
    const content = JSON.stringify([
      { status: 'borrowed', isbn: '9780374275631', borrowedAt: '2026-13-45' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('borrowedAt');
  });

  it("rejects a non-existent day '2026-02-30' as a borrowedAt with a warning", () => {
    const content = JSON.stringify([
      { status: 'borrowed', isbn: '9780374275631', borrowedAt: '2026-02-30' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('borrowedAt');
  });

  it("rejects a locale format 'April 12, 2026' with a warning", () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '9780374275631', startedAt: 'April 12, 2026' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('startedAt');
  });
});

describe('parseExtras: unknown fields', () => {
  it('emits a warning naming the field and the entry but accepts the entry', () => {
    const content = yaml(
      '- status: finished',
      '  isbn: "9781234567890"',
      '  title: Good Entry',
      '  finshedAt: 2026-05-01',
    );

    const result = parseExtras(content, 'yaml');

    expect(result.entries).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Good Entry');
    expect(result.warnings[0]).toContain('finshedAt');
  });

  it('emits multiple warnings for multiple unknown fields on the same entry', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', foo: 1, bar: 2 }]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('foo'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('bar'))).toBe(true);
  });

  it('does not include the unknown field in the resulting entry', () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '9781234567890', finshedAt: '2026-05-01' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).not.toHaveProperty('finshedAt');
  });
});

describe('parseExtras: private flag', () => {
  it('accepts private: true and preserves it', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', private: true }]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.private).toBe(true);
  });

  it('accepts private: false and preserves it', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', private: false }]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.private).toBe(false);
  });

  it('rejects a non-boolean private value with a warning', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', private: 'yes' }]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('private');
  });
});

describe('parseExtras: olid field', () => {
  it('accepts a string olid and preserves it', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', olid: 'OL123W' }]);

    const result = parseExtras(content, 'json');

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.olid).toBe('OL123W');
  });

  it('rejects a non-string olid such as a number with a warning', () => {
    const content = JSON.stringify([{ status: 'finished', isbn: '9781234567890', olid: 12345 }]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('olid');
  });
});

describe('parseExtras: malformed input', () => {
  it('returns empty entries with a warning when YAML is syntactically invalid', () => {
    const result = parseExtras('foo: "unterminated', 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('YAML');
  });

  it('returns empty entries with a warning when JSON is syntactically invalid', () => {
    const result = parseExtras('{not valid json', 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('JSON');
  });

  it('returns empty entries with a warning when the root is an object instead of an array', () => {
    const result = parseExtras('{"status": "finished", "isbn": "9781234567890"}', 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].toLowerCase()).toContain('list');
  });

  it('returns empty entries with a warning when the root is a string', () => {
    const result = parseExtras('"just a string"', 'json');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].toLowerCase()).toContain('list');
  });

  it('returns empty entries with no warnings when the file is an empty array', () => {
    const result = parseExtras('[]', 'json');

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('handles a completely empty string gracefully', () => {
    const result = parseExtras('', 'yaml');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('parseExtras: mixed valid and invalid', () => {
  it('returns the two good entries plus one warning for a list with one bad entry', () => {
    const content = JSON.stringify([
      { status: 'finished', isbn: '1111111111', title: 'Good One' },
      { status: 'notreal', isbn: '2222222222', title: 'Bad One' },
      { status: 'reading', isbn: '3333333333', title: 'Good Two' },
    ]);

    const result = parseExtras(content, 'json');

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.title)).toEqual(['Good One', 'Good Two']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Bad One');
  });
});
