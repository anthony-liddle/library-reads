# library-reads

[![npm](https://img.shields.io/npm/v/library-reads.svg)](https://www.npmjs.com/package/library-reads)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](https://www.typescriptlang.org/)

I read mostly through Libby. I also pick up physical books from the library and from Powell's, and now and then I'm reading something a friend lent me. This package turns a Libby export, plus a small hand-edited extras file, into a typed array of my recent reads, enriched with covers and metadata from Open Library. The output is meant to drop straight onto a "Lately" page: what I've been reading, in the order I read it.

It's built around how I actually read, not around a service. If that happens to match how you read, you're welcome to it.

## How It Works

There are three sources. The bulk comes from a Libby timeline export, a CSV of every loan, which for me is mostly audiobooks. The second is a hand-edited `extras.yaml`: the book I'm reading right now, the physical one I checked out at the branch, the paperback from Powell's, the one a friend pressed into my hands. The third is Open Library, which fills in covers, page counts, publish years, and subjects.

Libby and extras are merged by ISBN. When the same book appears in both, the extras entry wins on status and the dates are kept from both sides. So a Libby `borrowed` and an extras `finished` for the same ISBN become a single `finished` entry that still remembers when I borrowed it. Everything else passes through untouched.

Enrichment is cached hard. The package talks to Open Library politely, one request per second with an identifying User-Agent, and writes what it learns to a cache file you commit to git. After the first build, unchanged books cost nothing.

Each entry carries a `matchQuality` field (`'exact'`, `'fuzzy'`, or `'unmatched'`) so you can programmatically flag the entries that need a human eye, rather than grepping the warnings array for them.

The one thing Libby genuinely cannot tell you is what you're reading right now; its export only lists loans you've already returned. That gap is the main reason `extras.yaml` exists.

## Quick Start

```bash
pnpm add library-reads
```

```typescript
import { getReads } from 'library-reads';

const result = await getReads({
  libby: { path: './libbytimeline-all-loans.csv' },
  extras: { path: './extras.yaml' },
  cache: { path: './library-reads-cache.json' },
  userAgent: 'my-site/1.0 (me@example.com)',
});

// result.entries: ReadEntry[], sorted by sortDate descending
// result.warnings: string[]
// result.lastEntryDate: string | undefined
```

`userAgent` is required. Open Library asks callers to identify themselves, and it's easy to forget, so the type makes you pass it.

Each entry comes back shaped roughly like this:

```typescript
{
  title: 'The Overstory',
  author: 'Richard Powers',
  isbn: '9780393635522',
  status: 'finished',
  format: 'physical',
  startedAt: '2026-04-01',
  finishedAt: '2026-04-28',
  sortDate: '2026-04-28',
  coverUrl: 'https://covers.openlibrary.org/b/id/8758252-L.jpg',
  pageCount: 502,
  source: 'library',
  provenance: 'extras',
}
```

A word of warning about the first build: it takes a few minutes. Open Library is rate-limited to one request a second, and most books need two requests, so a few dozen entries adds up. Every build after that is effectively instant, because the cache is committed and the network is only touched for books it hasn't seen. Don't be alarmed the first time; do be glad every time after.

## The `extras.yaml` Shape

This file is hand-edited, and the package validates it strictly. A small example:

```yaml
# The book I'm reading right now, from Powell's last weekend.
- title: 'The MANIAC'
  author: 'Benjamín Labatut'
  isbn: '9780593654477'
  status: reading
  format: physical
  source: "Powell's"
  startedAt: '2026-05-20'

# A Libby audiobook I actually finished. Same ISBN as the Libby row,
# so this promotes that loan from 'borrowed' to 'finished' on merge.
- isbn: '9781501977831'
  status: finished
  finishedAt: '2026-05-22'
  notes: 'Finished on a long walk. Murderbot stays good.'

# A privately-tracked read. It stays out of the output unless I ask
# for it with includePrivate, so I can keep a few things off the page.
- title: 'The Body Keeps the Score'
  author: 'Bessel van der Kolk'
  isbn: '9780143127741'
  status: finished
  finishedAt: '2026-01-15'
  private: true
```

Every entry needs a `status`, and either an `isbn` or both a `title` and an `author` (the package needs at least one way to identify the book). The rest is optional:

- `format`: one of `audiobook`, `ebook`, `physical`.
- `source`: free text for where the book came from. `'library'`, `"Powell's"`, `'borrowed from Joel'`.
- `startedAt`, `finishedAt`, `borrowedAt`: ISO dates (`YYYY-MM-DD`).
- `notes`: a line for yourself.
- `olid`: an Open Library ID, to pin a specific edition when the automatic match is wrong.
- `private`: when `true`, the entry is excluded from output unless you pass `includePrivate`.

`status` is one of `borrowed`, `reading`, `finished`, or `abandoned`. The full field reference is the types file; this is just the part you'll touch by hand.

## What This Doesn't Do

This is the part I'd want to read first, so it's the part I'll be most honest about.

**It doesn't integrate with Goodreads or StoryGraph.** I don't use either, so the package is built around Libby and a hand-edited file, because that's how I actually read. If you log your reading to Goodreads or StoryGraph, you already have good options; there are scrapers and RSS-based packages aimed squarely at you. This isn't one of them, and that's a deliberate choice rather than a missing feature. The case study goes into why.

**Open Library doesn't have every book.** This bites harder than you'd expect. Libby's exports carry the ISBN of the exact edition you borrowed, which for audiobooks is usually a 979-prefix ISBN, and Open Library indexes mostly print editions. In practice, roughly two-thirds of a typical Libby export gets a 404 on exact-ISBN lookup. The package handles this without falling over: it remembers the misses so it stops asking, then falls back to a title-and-author search. Those fallbacks are marked `matchQuality === 'fuzzy'` on the entry, so you can surface them for a quick check instead of trusting every one blindly, because a fuzzy search can land on the wrong edition. When one does, the `olid` field in `extras.yaml` pins the right edition.

**Repeat borrows show up as repeat entries.** If you've borrowed The Great Gatsby three times, you'll see it three times. That's on purpose. This is a timeline of a reading life, including the re-reads and the books I keep meaning to finish, not a deduplicated bibliography. "Lately" is about what's been in my life, and sometimes the same book has been in it more than once.

**Currently-reading lives only in extras.** Libby's "all loans" export contains loans you've already returned; it has no idea what you have out right now. That's a limit of the source, not a bug in the package, and it's why the one thing I always keep current in `extras.yaml` is whatever I'm in the middle of.

**It doesn't handle your library card.** The package reads a CSV; it doesn't talk to Libby's API. Getting the export is a manual download for now (in the Libby app: Timeline, then Actions, then Export Timeline). Automating that would mean storing patron credentials and leaning on unsanctioned OverDrive endpoints, and I'd rather not.

In short:

- No Goodreads or StoryGraph.
- Not every book is in Open Library.
- Re-reads are not deduplicated.
- Currently-reading is manual.
- No login; the CSV is a manual export.

If you hit something outside all of that, open an issue. And before you do, the escape hatches (`olid` to pin an edition, `bust` to refetch specific keys, `cache.ignoreReads` to bypass the cache for a run) cover most of the "this one match is wrong" cases on their own.

## Cache

The cache file is committed to git, not ignored. That's intentional. Builds stay deterministic across clones; a fresh checkout needs no network for books it has already seen; and what Open Library told you becomes part of the project's reproducible state rather than a disposable temp file.

Three options give you surgical control when you need it:

- `cache.maxAgeDays`: refetch any entry older than this many days. Defaults to 180.
- `cache.bust`: an array of cache keys to force-refetch this run, for when you know a specific record changed.
- `cache.ignoreReads`: skip reading the cache this run, but still write it, for when you want fresh data without throwing away the file.

To turn caching off, leave `cache` out of the options entirely. That is the only spelling; there is no `cache: false`.

Open Library 404s are cached too, so the books it doesn't have stop being re-fetched on every build. The cache is for everything I learned, not just the things I learned successfully.

## Why This Exists

I've gone to the library my whole life, most weeks, on the standing rule that you can take home as many books as you can carry. As life got busier the format shifted more toward audiobooks through Libby, but the habit never changed. This package is the engine behind a "Lately" feature on my site, a small, honest record of what I've been reading. Libraries give a lot away for free and ask for almost nothing back; a page that quietly says "here's what that gift looked like this month" felt like the right way to say thank you. The longer story is in the [case study](https://anthonyliddle.dev) (link to be updated once it's published).

## License

MIT, Anthony Liddle, 2026.
