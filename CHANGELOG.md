# Changelog

All notable changes to this project will be documented here.

## [Unreleased]

### Added

- Native DSH Bundle candidate with `/session-insights`, official `sessionQuery` ingestion, and six bounded semantic-workflow tools.
- Versioned stdin JSONL bridge that avoids persisting raw session snapshots in plugin mode while retaining the file-log CLI.
- Chinese and English Dashboard shells and language-specific semantic output contracts from one report schema.

### Changed

- Semantic retrospective is the native command default; `--deterministic` preserves a no-model path and `--resume` continues the latest bounded run.
- Candidate version metadata is now `0.2.0`; publication, tag, Release, and marketplace state remain pending.

### Fixed

- Replace unsafe ordered English substring replacement with exact static localization and explicit dynamic locale rendering, including English Markdown export.
- Cover resume, Python-child cancellation, invalid semantic-output cleanup, and deterministic fallback in the native Bundle regression suite.
- Use the supported DSH `notice` context form and canonicalize each path through its deepest existing ancestor so macOS `/var` and `/private/var` aliases do not reject a not-yet-created run directory.
- Localize framework-owned semantic evidence and horizon text when finalizing an English report.

### Validation

- Ten local Node plugin tests and 35 Python tests pass on macOS with Python 3.12, including repeated runs below an aliased DSH home and English semantic-finalization coverage.
- File-log and `sessionQuery` fixtures produce equivalent core totals; npm dry-run contains only the intended 17 files and no lifecycle scripts or bytecode.
- An isolated DSH `0.1.1-rc.1` Web profile installed, composed, and started the local Bundle on macOS. Windows-native Bundle acceptance and remote CI remain pending.
- A third independent macOS DSH review reproduced two semantic prepares and two deterministic commands below an aliased DSH home, rendered a complete English semantic workflow with zero CJK characters outside scripts, and confirmed all 10 Node tests, 35 Python tests, and the 17-file npm payload. No remaining macOS release blocker was found; Windows-native Bundle acceptance, exact-commit remote CI, and a real-model bilingual semantic round trip remain pending.

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
