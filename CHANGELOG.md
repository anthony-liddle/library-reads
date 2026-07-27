# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-27

### Fixed

- `parseLibbyCsv` no longer drops the entire CSV when Libby reorders columns.
  The header is now checked by column presence rather than position, because
  rows are keyed by column name and order never mattered to the parser. A
  reorder parses silently; a missing or unexpected column warns once and still
  parses, leaving those fields undefined per row. Only a header with none of
  the expected columns is refused. Found in use: a July 2026 Libby export
  change swapped `details` and `library`, and 0.1.0 returned zero entries from
  a 55-row export.
- `parseLibbyCsv` warns instead of throwing when the CSV body is unparseable.
  Damage that the row-level tolerances cannot absorb, such as an unclosed
  quote, previously escaped as an exception and took the whole build with it.
- `getReads` no longer crashes when caching is off. Passing `cache: false`
  from untyped code reached `fs.rename` with an undefined path and threw
  `ERR_INVALID_ARG_TYPE`; the same undefined path also produced a nonsense
  `Cache file undefined could not be read` warning on the read side. Both call
  sites now resolve the path once and skip cache I/O entirely when there
  isn't one. Caching is disabled by omitting `cache`, which is now stated in
  the `GetReadsOptions.cache` JSDoc and the README.

## [0.1.0] - 2026-06-01

### Added

- `getReads(options)` orchestrator that reads Libby CSV and optional extras
  file, merges entries by ISBN, enriches via Open Library, and returns a
  sorted typed array.
- `parseLibbyCsv(csv)` for reading Libby timeline exports, with strict header
  validation and graceful handling of malformed rows.
- `parseExtras(content, format)` for reading hand-edited YAML or JSON files,
  with strict per-entry validation and clear error messages.
- `enrich(entry, options)` for Open Library metadata enrichment, with
  configurable edition-picker preferences (language, completeness, recency)
  and shared rate-limiter state.
- Git-tracked, distilled cache with positive entries for successful matches
  and negative entries for confirmed misses, so warm builds make no network
  calls and re-runs don't re-fetch books Open Library doesn't have.
- `matchQuality` field on each returned entry (`'exact'` | `'fuzzy'` |
  `'unmatched'`) so consumers can programmatically flag entries that should
  be verified, without grepping the warnings array.
- ISBN-404 fallback to title+author search, so Libby's audiobook-ISBN-heavy
  exports still enrich most entries.

[Unreleased]: https://github.com/anthony-liddle/library-reads/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/anthony-liddle/library-reads/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/anthony-liddle/library-reads/releases/tag/v0.1.0
