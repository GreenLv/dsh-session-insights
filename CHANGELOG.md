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
- Disclose the aggregate validator's `confidence` and `measurement` enums to the model so the default semantic workflow does not fall back for an undiscoverable contract.
- Reject POSIX-rooted project filters on Windows with a native-path error instead of silently selecting no sessions.

### Validation

- Eleven local Node plugin tests and 36 Python tests pass on macOS with Python 3.12, including aggregate-contract parity and Windows project-path coverage.
- File-log and `sessionQuery` fixtures produce equivalent core totals; npm dry-run contains only the intended 17 files and no lifecycle scripts or bytecode.
- An isolated DSH `0.1.1-rc.1` Web profile installed, composed, and started the local Bundle on macOS. The nine-job remote CI matrix passed on remediation source commit `1fe5bc4` across Ubuntu, macOS, and Windows with Python 3.11/3.12/3.13.
- A third independent macOS DSH review reproduced two semantic prepares and two deterministic commands below an aliased DSH home, rendered a complete English semantic workflow with zero CJK characters outside scripts, and confirmed the then-current 10 Node tests, 35 Python tests, and 17-file npm payload. No remaining macOS release blocker was found.
- Independent Windows acceptance on `11d6fe4` passed Bundle installation, composed-config readback, Web startup, the six-tool lifecycle, resume, cancellation, repeated runs, alias-plus-space paths, native project filtering, and real-model `en`/`zh-CN` semantic completion without fallback. Deterministic slash dispatch and rendered English DOM were not invoked natively on Windows.

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
