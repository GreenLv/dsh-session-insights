# Changelog

[简体中文](CHANGELOG.zh-CN.md)

Public releases are listed newest first.

## 0.6.0 - 2026-09-30

Requires DSH `>=0.2.0-rc.2`; DSH `0.2.0-rc.1` is below the supported floor. Input remains V4. Desktop support, resume scoping and native acceptance are recorded separately per artifact.

### Changed

- Raise the DSH floor to `>=0.2.0-rc.2` across npm engines, Bundle compatibility and DSH peers. Future host versions are admitted by the declared range (the official RC.2 market consumer evaluates with `includePrerelease`), not by static version tables; only format or analyzer-semantics changes invalidate runs. Fixture runtimes and contract tooling pin the exact RC.2.
- Bind resume to an explicit run and its recorded selection scope. Every run now records a normalized scope (project key, window length, privacy pair, analysis depth, locale) with a scope fingerprint; implicit resume requires an exact match, an explicit `--workdir` refuses contradictory fields, multi-run ambiguity is reported with the candidate paths, and manifests without a recorded scope are refused. Host-version growth alone no longer invalidates a semantically identical run.
- Cap concurrent native analysis per plugin instance (two runs; cancellable FIFO queue of eight). Slash-command and tool calls can no longer multiply 256 MiB analysis Workers without bound; queued work is cancelled on abort or unload.
- Bound Python session-log reads: streaming JSONL with hard budgets for decoded bytes, line count and single-line size, frame-by-frame zstd decoding that detects truncated final frames, refusal of oversized header frames and high compression ratios, and explicit `resource_limited_files` coverage instead of silent truncation or older-generation fallback. Corrupt UTF-8 is reported as unreadable instead of crashing the run.
- Classify RC.2 asynchronous question replies (`source.kind=user-question-reply`) and scheduled prompts (`schedule`) as injected context in the native reader: counted separately, excluded from body evidence, corrections, acceptance signals and completion inference, and never treated as authorization.
- Give `--no-open` a verifiable meaning: the command output stays a bare path line with no view hint, no opened files, no resident server and no upload; the default output appends one view hint naming the report file. Documented viewing steps for the Web runtime and the official Desktop keep the offline HTML as the only report surface.

- Independent review fixes project-filtered preparation, keeps each scheduler slot until Worker termination, validates recorded selection fingerprints, and checks compressed-log budgets during block decoding. Completed `--no-open` results contain only the report path.
- A section with one narrative card now uses the full row. Filter actions wrap on narrow screens, avoiding horizontal overflow.

## 0.5.1 - 2026-09-29

Target DSH `0.2.0-rc.1` exclusively. Start a new analysis run after upgrading; existing reports are retained.

### Changed

- Count interrupted tool results separately from confirmed failures in both production readers. JSON totals and session summaries add `tool_recovery: {outcome_unknown, not_started}` for the host's exact recovery codes; these records do not increase failure, failed-verification, permission or retry counts. Call identity includes its turn and step, preserving separate uncertainty evidence when an ID is reused.
- Pin DSH peers and Bundle compatibility to `0.2.0-rc.1`. New input identity `v4-dsh020rc1.2` invalidates earlier analysis manifests and deterministic caches.
- Generate recovery fixtures through the exact host's official recoverer. Release tooling now retains one commit-bound tarball and validates installation bytes, populated reports, cancellation and cleanup in a portable gate. Source, package, native-host and model acceptance are recorded separately in the [release acceptance](docs/acceptance/v0.5.1-release.md).
- Anonymize machine-local paths in a historical acceptance document and broaden the public-tree path scan. Historical results and limitations are unchanged.

## 0.5.0 - 2026-09-26

Target DSH `0.1.7-rc.2` exclusively and start new V4 analysis runs after upgrading.

### Changed

- Read V4 only in both native snapshots and the optional Python CLI. Migrate older raw logs upstream; old analysis manifests and caches cannot resume.
- Use producer-owned notice messages and cancellable query observations; release observations before analysis and wait for owned work during unload.
- Track developer surface replacements, PTC inner calls and permission-blocked results without treating injected context as human work or approval text as execution evidence.
- Align npm and Python versions at 0.5.0. Source/CI checks, macOS model workflow, Windows deterministic host acceptance and human bilingual browser checks are separately recorded in the [release acceptance](docs/acceptance/v0.5.0-release.md).

## 0.4.0 - 2026-09-20

The native Bundle now generates reports without Python and adds explicit run cleanup.

### Changed

- Move native Bundle analysis and semantic validation to Node.js; remove Python interpreter discovery, subprocess execution and inherited Python environment/import paths. The optional Python CLI remains available.
- Restrict native artifacts to marked run directories, reject linked paths and validate model output before writing. Explicit structured failures now take precedence over success-looking output text.
- Add preview-first cleanup for a single run. Native runs keep validated outputs for resume but no longer write a shared semantic cache; old Python runs must be finished through the CLI or restarted.
- Keep the report schema and dashboard, with refreshed deterministic summaries. Add legacy/V3 Python–JavaScript metric comparisons, full semantic-flow tests and adversarial storage checks. Native DSH acceptance remains pending.

## 0.3.2 - 2026-09-11

Align the published package metadata with the verified DSH support baseline.

### Changed

- Declare DSH `0.1.5-rc.2` consistently in top-level `engines.dsh`, Bundle metadata, and all DSH peer dependencies, so plugin markets and installers no longer advertise the retired `0.1.0-rc.8` threshold.
- Add a regression check that keeps market-facing metadata and both README support statements on the same exact verified range.

This metadata-only release does not change runtime behavior. The source, CI, and macOS native workflow evidence from `0.3.1` remains the applicable behavior evidence; package, installation, publication, and market readback use the new `0.3.2` artifact identity.

## 0.3.1 - 2026-09-11

Fix session-log compatibility with DSH 0.1.5-rc.2: upgraded sessions now appear in reports, and injected context no longer inflates human-work counts.

### Fixed

- Read compressed or plaintext generations 0–3 and select the latest generation per session, without omitting new sessions or counting migration copies twice. Unreadable, encoding-ambiguous, and newer-than-supported generations are diagnosed rather than silently replaced with old logs.
- Separate human prompts from injected context, count system messages and attempts with no delivered reply, and retain historical tool and token accounting.
- Apply consecutive message replacements in current conversation order, so shadowed semantic evidence is removed even when endpoint sequence numbers run backwards. Query snapshots use their header's format version.
- Use the caller's time window for both semantic and deterministic reports; a corrupt zstd file no longer aborts the entire analysis.
- Make synthetic logs conform to DSH framing and migration contracts, with an upstream contract verifier and V3 regression coverage.

The declared minimum DSH version remains `0.1.0-rc.8`. This change targets `0.1.5-rc.2`; see the [acceptance record](docs/acceptance/v0.1.5-rc.2-compatibility.md) for native and CI verification scope.

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
