# Changelog

[简体中文](CHANGELOG.zh-CN.md)

Public releases are listed newest first.

## 0.2.0 - 2026-08-22

Version 0.2.0 turns session review into a native DeepSeek Harness workflow: run `/session-insights`, let the current DSH agent analyze bounded batches, and open the generated local HTML report and companion JSON. The earlier file-log CLI remains available.

### Added

- The DSH Bundle reads session history through DSH's `sessionQuery` service and coordinates the review through six bounded workflow tools.
- Raw session snapshots are streamed to the Python analyzer and are not copied into the run directory in plugin mode.
- Chinese and English dashboards use the same report data while keeping their own interface and generated narrative language.

### Changed

- Model-assisted retrospective is now the normal Bundle path. Use `--deterministic` for a no-model report or `--resume` to continue the latest incomplete bounded run.
- The published Bundle can be installed through the DSH npm plugin channel.

### Fixed

- English reports no longer inherit Chinese framework text from ordered substring replacement; static and generated text now follow the requested locale explicitly.
- Resume, cancellation, invalid model output, and deterministic fallback clean up their run state consistently.
- macOS aliases such as `/var` and `/private/var`, paths containing spaces, and Windows project filters are handled with native path rules instead of silently rejecting or selecting the wrong sessions.
- The semantic prompt now exposes every allowed aggregate value, preventing a valid model answer from falling back because the contract was impossible to discover.

Release identity, package checksums, CI, native-platform evidence, and the remaining Windows limits are recorded in [the v0.2.0 acceptance record](docs/acceptance/v0.2.0-candidate.md).

## 0.1.0 - 2026-08-21

The first release reads DSH file logs and produces an offline workflow-review dashboard plus companion JSON. It can run deterministically or add a recoverable model-assisted analysis stage.

### Added

- File-log adapter, Python CLI, managed DSH Skill installation, synthetic fixtures, and three privacy modes.
- Recoverable semantic batches with validation, caching, and explicit fallback when generated output is invalid or unavailable.

### Fixed

- Windows console launchers are created at their final environment path, so they do not keep references to a removed staging directory.
- Complete `<redacted>` placeholders pass privacy verification while real credential values remain rejected.

### Platform scope

- Repository checks and cross-platform CI passed, and isolated native acceptance passed on macOS and Windows 11. Linux native acceptance, real-session smoke testing, real-model semantic round trips, and Windows DSH GUI Skill rescanning were not completed for this release.
