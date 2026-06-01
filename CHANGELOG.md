# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-MM-DD

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

[Unreleased]: https://github.com/anthony-liddle/library-reads/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anthony-liddle/library-reads/releases/tag/v0.1.0
