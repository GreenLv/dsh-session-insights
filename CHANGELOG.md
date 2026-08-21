# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

## [0.1.0] - 2026-08-21

### Added

- Initial v0.1 candidate: DSH file-log adapter, deterministic reports, offline dashboard and companion JSON.
- Three privacy modes, recoverable semantic batching, validation, caching, and explicit fallback.
- Managed Skill/runtime installer, synthetic fixtures, Schema v1, cross-platform CI definition, and governance documents.

### Fixed

- Build the managed virtual environment at its final path so Windows console launchers do not retain a removed staging path.
- Accept complete `<redacted>` credential placeholders in native-acceptance privacy readback while continuing to reject actual values.

### Validation

- 27 unit tests, deterministic fixture reconstruction, Schema validation, public-tree audit, and exact share-boundary audit passed.
- GitHub Actions passed on Ubuntu, macOS, and Windows with Python 3.11, 3.12, and 3.13.
- Isolated native acceptance passed on macOS and Windows 11 with DSH `0.1.0-rc.8`; Windows console entrypoints, repeat installation, rollback, uninstall isolation, and privacy-verifier behavior were rechecked after the final installer fix.
- Native Linux acceptance, real-session smoke testing, real-model semantic round trips, and Windows DSH GUI Skill rescanning were not performed for v0.1.0.
