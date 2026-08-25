# Changelog

[简体中文](CHANGELOG.zh-CN.md)

Public releases are listed newest first.

## 0.3.0 - 2026-08-25

0.3.0 polishes the dashboard's layout (consistent cards, aligned filter toolbar, scroll-aware chip navigation), adds Skill usage and plugin/MCP usage views, measures active time in hours, and records per-session skill calls in the deterministic analyzers.

### Changed

- Dashboard visual system: every block uses the same card treatment (task-family list, friction signals, representative workflows, evidence and coverage notes included), a consistent 28px vertical rhythm, equal-height card rows with bottom-aligned card actions, and one-column collapse below 850px. The filter toolbar was rebuilt as a six-column form grid with the work-area filter and the Reset / Export buttons on one aligned second row.
- KPI cards reordered by what matters most — active time, dedicated token usage, sessions (was "Rollout 数"), turns, tools — with active time in hours everywhere. The drilldown section is renamed 会话明细 (Session details).
- Navigation: the sticky table-of-contents became a pill-chip card that follows document order (任务族 before 时段对比) with scroll tracking, and now includes entries for 会话明细 and 证据.
- Color accents: status pills use green/red/amber tints, usage-chart cards get distinct series colors, and glance cards cycle accent colors.
- Number formatting follows the report language (1.4B vs 14亿) instead of the browser locale.

### Added

- Interaction metrics now count Skill calls and Plugin/MCP calls per filter scope (plus Web searches separately); the deterministic analyzers record per-session `skill_calls` (parser contract bumped to DSH 0.2.2 / 6.0.4).
- The usage section gains 「Skill 使用」 and 「插件/MCP 使用」 cards that rank the most-used skills and MCP servers/plugins (alongside session types, tools, file types, and active hours).

### Fixed

- Chart: the daily active-time measure shows hours with the unit on the y-axis, every date is labelled (even sampling beyond 12 days), and the chart lives in its own card.
- Recommendation and work-area cards align their action rows (copy prompt + adoption select, drill-down buttons) and pin them to the card bottom-right.
- Task-family rows use the same fluid-title / right-aligned-meta proportions as the session-detail list, with completion evidence spanning the full row.
- Scroll tracking no longer jumps ahead or leaves the session-detail and evidence sections unlit; anchor jumps respect the sticky bar.

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
