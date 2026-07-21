import { describe, expect, it } from 'vitest';
import { parseLibbyCsv } from './libby.js';

const HEADER = 'cover,title,author,publisher,isbn,timestamp,activity,library,details';

describe('parseLibbyCsv: happy path', () => {
  it('parses a clean three-row CSV with all fields populated', () => {
    const csv = [
      HEADER,
      'https://img.example.com/a.jpg,Project Hail Mary,Andy Weir,Ballantine Books,9780593135204,"March 03, 2026 09:15",Borrowed,Example County Library,14 days',
      'https://img.example.com/b.jpg,Piranesi,Susanna Clarke,Bloomsbury,9781635575637,"January 12, 2026 18:02",Borrowed,Example County Library,21 days',
      'https://img.example.com/c.jpg,The Spear Cuts Through Water,Simon Jimenez,Del Rey,9780593156599,"December 25, 2025 07:40",Borrowed,Example County Library,7 days',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toEqual({
      cover: 'https://img.example.com/a.jpg',
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      publisher: 'Ballantine Books',
      isbn: '9780593135204',
      borrowedAt: '2026-03-03',
      activity: 'Borrowed',
      library: 'Example County Library',
      details: '14 days',
    });
    expect(result.entries[1]?.title).toBe('Piranesi');
    expect(result.entries[2]?.borrowedAt).toBe('2025-12-25');
  });

  it('preserves the activity column verbatim without inferring anything', () => {
    const csv = [
      HEADER,
      'https://img.example.com/a.jpg,Some Title,Some Author,Some Publisher,9780000000001,"April 01, 2026 12:00",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.activity).toBe('Borrowed');
  });

  it('parses a row missing its trailing columns, leaving those fields undefined', () => {
    // A row that stops after activity. relax_column_count keeps it, and the
    // absent library and details columns arrive as undefined rather than ''.
    const csv = [
      HEADER,
      'https://img.example.com/a.jpg,Short But Valid,An Author,A Publisher,9780000000014,"May 04, 2026 08:00",Borrowed',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('Short But Valid');
    expect(result.entries[0]?.library).toBeUndefined();
    expect(result.entries[0]?.details).toBeUndefined();
  });

  it('surfaces an empty activity column as an empty string, not undefined', () => {
    // activity is the one required field with a '' fallback: an empty column
    // stays an empty string so the RawLibbyEntry shape does not change.
    const csv = [
      HEADER,
      'https://img.example.com/a.jpg,No Activity Book,An Author,A Publisher,9780000000013,"April 01, 2026 12:00",,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.activity).toBe('');
  });
});

describe('parseLibbyCsv: quoted fields with embedded commas', () => {
  it('keeps commas inside a quoted title without breaking column alignment', () => {
    const csv = [
      HEADER,
      'https://img.example.com/t.jpg,"Teenage Mutant Ninja Turtles Micro-Series (2011), Volume 1",Kevin Eastman,IDW,9781613771809,"February 14, 2025 04:42",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe(
      'Teenage Mutant Ninja Turtles Micro-Series (2011), Volume 1',
    );
    expect(result.entries[0]?.author).toBe('Kevin Eastman');
    expect(result.entries[0]?.isbn).toBe('9781613771809');
  });

  it('keeps commas inside a quoted publisher', () => {
    const csv = [
      HEADER,
      'https://img.example.com/p.jpg,Artificial Condition,Martha Wells,"Recorded Books, Inc.",9781501977831,"May 17, 2026 22:24",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.publisher).toBe('Recorded Books, Inc.');
    expect(result.entries[0]?.isbn).toBe('9781501977831');
    expect(result.entries[0]?.borrowedAt).toBe('2026-05-17');
  });

  it('parses a quoted timestamp and normalizes it to ISO', () => {
    const csv = [
      HEADER,
      'https://img.example.com/q.jpg,Cuckoo,Gretchen Felker-Martin,Tor Publishing Group,9781250794673,"February 21, 2025 00:51",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.borrowedAt).toBe('2025-02-21');
  });
});

describe('parseLibbyCsv: empty fields become undefined', () => {
  it('surfaces an empty-string isbn as undefined', () => {
    const csv = [
      HEADER,
      'https://img.example.com/i.jpg,A Book Without Isbn,An Author,A Publisher,"","June 09, 2026 10:30",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('A Book Without Isbn');
    expect(result.entries[0]?.isbn).toBeUndefined();
    expect(result.entries[0]).not.toHaveProperty('isbn', '');
  });

  it('surfaces an empty-string author as undefined', () => {
    const csv = [
      HEADER,
      'https://img.example.com/au.jpg,A Graphic Novel,"",Some Publisher,9780000000002,"July 20, 2026 15:45",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('A Graphic Novel');
    expect(result.entries[0]?.author).toBeUndefined();
  });

  it('surfaces multiple empty fields in one row as undefined', () => {
    const csv = [
      HEADER,
      'https://img.example.com/m.jpg,"Teenage Mutant Ninja Turtles Micro-Series (2011), Volume 1","","Idea and Design Work, LLC","","February 14, 2025 04:42",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.author).toBeUndefined();
    expect(result.entries[0]?.isbn).toBeUndefined();
    expect(result.entries[0]?.publisher).toBe('Idea and Design Work, LLC');
    expect(result.entries[0]?.title).toBe(
      'Teenage Mutant Ninja Turtles Micro-Series (2011), Volume 1',
    );
  });
});

describe('parseLibbyCsv: details column', () => {
  it('trims a populated details field and surfaces it', () => {
    const csv = [
      HEADER,
      'https://img.example.com/d.jpg,A Loan With Duration,An Author,A Publisher,9780000000003,"August 02, 2026 08:00",Borrowed,Example Library, 21 days ',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.details).toBe('21 days');
  });

  it('surfaces an empty details field as undefined', () => {
    const csv = [
      HEADER,
      'https://img.example.com/e.jpg,A Loan Without Duration,An Author,A Publisher,9780000000004,"September 11, 2026 11:11",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('A Loan Without Duration');
    expect(result.entries[0]?.details).toBeUndefined();
  });
});

describe('parseLibbyCsv: date normalization', () => {
  it('normalizes a quoted date to ISO YYYY-MM-DD', () => {
    const csv = [
      HEADER,
      'https://img.example.com/n.jpg,A Normal Month Date,An Author,A Publisher,9780000000005,"May 17, 2026 22:24",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.borrowedAt).toBe('2026-05-17');
  });

  it('zero-pads a single-digit day to two digits', () => {
    const csv = [
      HEADER,
      'https://img.example.com/s.jpg,A Single Digit Day,An Author,A Publisher,9780000000006,"May 08, 2026 22:17",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.borrowedAt).toBe('2026-05-08');
  });

  it('normalizes a January date and a December date correctly', () => {
    const csv = [
      HEADER,
      'https://img.example.com/jan.jpg,January Book,An Author,A Publisher,9780000000007,"January 01, 2026 00:00",Borrowed,Example Library,',
      'https://img.example.com/dec.jpg,December Book,An Author,A Publisher,9780000000008,"December 31, 2025 23:59",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries[0]?.borrowedAt).toBe('2026-01-01');
    expect(result.entries[1]?.borrowedAt).toBe('2025-12-31');
  });
});

describe('parseLibbyCsv: malformed rows are skipped with warnings', () => {
  it('skips a row with an unparseable date and records a warning', () => {
    const csv = [
      HEADER,
      'https://img.example.com/bad.jpg,A Book With A Bad Date,An Author,A Publisher,9780000000009,"not a date",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('A Book With A Bad Date');
    expect(result.warnings[0]).toContain('not a date');
  });

  it('skips a truncated row whose timestamp column is absent entirely', () => {
    // relax_column_count lets a short row through with its trailing keys unset,
    // so timestamp arrives as undefined rather than as an unparseable string.
    const csv = [
      HEADER,
      'https://img.example.com/short.jpg,A Truncated Row,An Author,A Publisher',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('A Truncated Row');
    expect(result.warnings[0]).toContain('""');
  });

  it('skips a row whose month name is not a real month', () => {
    // Shaped like a Libby timestamp and matched by the regex, but Smarch is not
    // in the month table, so the lookup fails rather than producing a bad date.
    const csv = [
      HEADER,
      'https://img.example.com/x.jpg,A Book With A Fake Month,An Author,A Publisher,9780000000012,"Smarch 05, 2026 11:00",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Smarch');
  });

  it('skips a row with a missing title and records a warning', () => {
    const csv = [
      HEADER,
      'https://img.example.com/notitle.jpg,"",An Author,A Publisher,9780000000010,"October 05, 2026 16:20",Borrowed,Example Library,',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain('title');
  });
});

describe('parseLibbyCsv: whitespace and blank lines', () => {
  it('ignores a trailing blank line at end of file', () => {
    const csv = `${[
      HEADER,
      'https://img.example.com/a.jpg,Only Book,An Author,A Publisher,9780000000011,"November 30, 2026 13:13",Borrowed,Example Library,',
    ].join('\n')}\n`;

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('ignores multiple trailing blank lines', () => {
    const csv = `${[
      HEADER,
      'https://img.example.com/a.jpg,Only Book,An Author,A Publisher,9780000000012,"November 30, 2026 13:13",Borrowed,Example Library,',
    ].join('\n')}\n\n\n`;

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(1);
  });
});

describe('parseLibbyCsv: mixed rows', () => {
  it('returns correct entries and warnings for a mix of good and bad rows', () => {
    const csv = [
      HEADER,
      'https://img.example.com/1.jpg,Fully Populated,Real Author,"Recorded Books, Inc.",9780000000013,"May 17, 2026 22:24",Borrowed,Example Library,14 days',
      'https://img.example.com/2.jpg,"Graphic, Novel","",Some Publisher,"","February 14, 2025 04:42",Borrowed,Example Library,',
      'https://img.example.com/3.jpg,Bad Date Book,An Author,A Publisher,9780000000014,"not a date",Borrowed,Example Library,',
      'https://img.example.com/4.jpg,"",An Author,A Publisher,9780000000015,"March 01, 2026 09:00",Borrowed,Example Library,',
      'https://img.example.com/5.jpg,Last Good Book,Final Author,Final Publisher,9780000000016,"April 04, 2026 04:04",Borrowed,Example Library,7 days',
    ].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.title)).toEqual([
      'Fully Populated',
      'Graphic, Novel',
      'Last Good Book',
    ]);

    expect(result.entries[1]?.author).toBeUndefined();
    expect(result.entries[1]?.isbn).toBeUndefined();
    expect(result.entries[1]?.details).toBeUndefined();

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('Bad Date Book');
    expect(result.warnings[1]?.toLowerCase()).toContain('title');
  });
});

describe('parseLibbyCsv: header validation', () => {
  const GOOD_ROW =
    'https://img.example.com/h.jpg,Header Test Book,An Author,A Publisher,9780000000020,"March 15, 2026 10:00",Borrowed,Example Library,14 days';

  it('parses normally when the header exactly matches the expected columns', () => {
    const csv = [HEADER, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('Header Test Book');
  });

  it('refuses to parse and warns when a column is missing', () => {
    const header = 'cover,title,author,publisher,isbn,timestamp,activity,library';
    const csv = [header, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain('header mismatch');
  });

  it('refuses to parse and warns when an extra column is appended', () => {
    const header = `${HEADER},notes`;
    const csv = [header, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain('header mismatch');
    expect(result.warnings[0]).toContain('notes');
  });

  it('refuses to parse and warns when a column is renamed', () => {
    const header = 'cover,title,author,publisher,isbn13,timestamp,activity,library,details';
    const csv = [header, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain('header mismatch');
    expect(result.warnings[0]).toContain('isbn13');
  });

  it('refuses to parse and warns when columns are reordered', () => {
    const header = 'cover,author,title,publisher,isbn,timestamp,activity,library,details';
    const csv = [header, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain('header mismatch');
  });

  it('tolerates a header with different letter case', () => {
    const header = 'Cover,Title,Author,Publisher,ISBN,Timestamp,Activity,Library,Details';
    const csv = [header, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('Header Test Book');
  });

  it('tolerates leading blank lines before the header', () => {
    const csv = ['', '', HEADER, GOOD_ROW].join('\n');

    const result = parseLibbyCsv(csv);

    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('Header Test Book');
  });

  it('warns about a missing header when the CSV is only whitespace', () => {
    const result = parseLibbyCsv('   \n  \n\t\n');

    expect(result.entries).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.toLowerCase()).toContain('header');
  });
});
