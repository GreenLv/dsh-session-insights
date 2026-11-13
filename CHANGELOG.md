# Changelog

[简体中文](CHANGELOG.zh-CN.md)

Public releases are listed newest first.

## Release guide

- **0.8.x** counts cancelled tool calls and structured approval non-grants separately. 0.8.1 requires DSH 0.2.2-rc.2 or later (0.8.0 required 0.2.2-rc.1). Existing semantic runs need to be finished with their original version or restarted.
- **0.7.x** adds Russian reports and documentation while retaining 0.6.1 run compatibility.
- **0.6.x** expands coverage of background jobs, delegation and working directories, then strengthens report, privacy and cleanup boundaries.
- **0.5.x** adapts to V4 session logs and later host releases, with safer recovery and bounded analysis.
- **0.4.x and earlier** introduce native reports and cleanup, the dashboard, and the original Python CLI.

## 0.8.1 - 2026-11-13

Reports distinguish an approval that was cancelled or unavailable from a tool execution failure, and preserve separate evidence when the same tool is blocked in different turns. Upgrade DSH to `0.2.2-rc.2` or later before installing this version.

### Changed

- The minimum DSH host rises from rc.1 to `0.2.2-rc.2`. Later versions remain admitted by the declared range; rc.2 is the exact acceptance target. Node.js `>=24.9.0` and Cordis `~4.1.0` are unchanged.
- Approval rejection remains a permission boundary. A cancelled approval window and an unavailable approval channel have separate counters and blocked evidence; neither counts as caller cancellation or execution failure.
- Team-mode changes are recorded as configuration context, rather than user tasks, authorization or completion. Historical V4 data still follows the supported catalog; unknown required events are refused.
- Start a new semantic analysis after upgrading, or finish an existing run with the version that created it. Old deterministic caches are rebuilt when needed; saved runs, reports and source logs remain available.

### Fixed

- Distinct approval non-grants with identical summary text keep separate evidence, including when passed to the semantic analysis stage.
- Dependency-audit summaries retain tree-capture failures and reject captures attributed to the wrong scope.

### Security

- DSH rc.2 replaces the old vulnerable Zod pins. The plugin's production/full and slim runtime scans are clean; the 0.8.0 Zod exception is retired.
- The full official rc.2 host still has ten known dependency advisories. The maintainer accepted the exact host lock and reviewed findings for 0.8.1 on 2026-11-13. Raw failure results remain distinct from clean scopes; changed inputs or new findings require review. See the [security policy](SECURITY.md#known-upstream-dependency-gap).

## 0.8.0 - 2026-11-07

Reports now count tool calls cancelled by their caller separately from failures, approval rejections and unknown outcomes. This includes `run_code` and its nested calls. A call that has already started may leave side effects. Separate cancellations, including those inherited from another session, retain distinct evidence for semantic reports.

### Changed

- The minimum DSH host is `0.2.2-rc.1`. Upgrade older hosts before installing 0.8.0. The declared range admits later versions, but `0.2.2-rc.1` is the exact host tested for this release.
- Node.js `>=24.9.0` is required and the Cordis peer range is `~4.1.0`. Update separately installed Python CLI and Skill copies through their managed installer.
- The report adds `tool_execution.outer_cancelled` and `tool_execution.inner_cancelled` counters. Cancellation is identified from the host's structured outcome.

### Migration

- Finish semantic runs created by 0.7.0 or earlier with the version that created them, or start a new run. Existing runs, their evidence and saved HTML/JSON/Markdown reports remain available.
- Historical V4 session logs remain valid input. Older deterministic CLI cache entries are ignored and rebuilt from source. To remove them, preview with `dsh-session-insights cache` and add `--delete` to confirm.

### Security

- Three DSH rc.1 packages still pin `zod@4.4.3`, affected by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The upstream dependency remains unfixed in the reviewed cohort. The maintainer accepted the known risk for the reviewed 0.8.0 inputs on 2026-11-06. See the [security policy](SECURITY.md#known-upstream-dependency-gap) for the scope and conditions of that decision.

The [0.8.0 release notes](docs/releases/v0.8.0.md) describe installation and the separate CI and native acceptance results. The [candidate record](docs/acceptance/v0.8.0-candidate.md) retains the implementation and test details.

## 0.7.0 - 2026-11-03

### Added

- Russian (`ru`) is available in the deterministic report, HTML dashboard, semantic prompts, native runtime and Python CLI. A Russian README accompanies the release. Russian localization by @xilec in [#2](https://github.com/GreenLv/dsh-session-insights/pull/2).
- DSH `0.2.1-rc.5` became the primary acceptance host, with `0.2.1-rc.2` retained as the minimum and compatibility host for this release.

### Changed

- Acceptance tools now report failed steps and cleanup failures, avoid silently reusing result directories, and retain the scene when cleanup cannot confirm that work has stopped. CI tests the exact named host runtimes and packages the actual PR head.

### Migration

- Semantic runs created by 0.6.1 remain resumable. Saved reports remain readable. Old deterministic CLI caches are ignored and rebuilt from source; to remove them, preview with `dsh-session-insights cache` and add `--delete` to confirm.

### Security

- DSH rc.5 packages still pinned vulnerable `zod@4.4.3`. The maintainer accepted the known risk for the reviewed 0.7.0 dependency cohort. The [0.7.0 release notes](docs/releases/v0.7.0.md) describe the affected packages, decision and validation limits.

## 0.6.1 - 2026-10-26

This security and correctness update requires DSH `>=0.2.1-rc.2` and tested `0.2.1-rc.3` as its primary host. Start a new analysis run after upgrading. Existing HTML and JSON reports remain readable, while old caches are ignored automatically.

### Security

- Report writes refuse source-log targets, links, hard links and conflicting output paths before writing. The analyzer fully parses only sessions in scope, and its deterministic cache stores a smaller privacy-projected record. The `cache` command previews files and sizes; deletion requires an explicit `--delete`.
- Model inputs and outputs receive additional privacy checks, including URL credentials and free text in object keys. Invalid model output does not replace the previous valid result.
- Model-requested deletion of a native run requires human approval for that call. The typed `/session-insights --cleanup <run>` command previews a single run, and `--confirm` deletes it.
- DSH rc.2 and rc.3 pinned vulnerable `zod@4.4.3`. The maintainer accepted this known risk for the reviewed 0.6.1 dependency cohort. See the [security policy at v0.6.1](https://github.com/GreenLv/dsh-session-insights/blob/v0.6.1/SECURITY.md#known-upstream-dependency-gap-in-061).

### Changed

- Same-named projects receive distinct anonymous identities. Each report uses one captured timezone for its dates and hours. Old reports retain their original projections.
- Semantic summaries must match the current validated batch content. Rebuild an outdated summary or choose an explicit deterministic fallback.
- The Python CLI resolves relative `--project` paths from the invoking directory. The native entry requires an absolute path. Redirected Python output uses UTF-8, including on Windows.
- Corrupt logs that can be identified as outside the selected project are skipped. In-scope corruption remains an error.

Details of the release and its platform-specific limits are in the [release acceptance record](docs/acceptance/v0.6.1-release.md). The [published 0.6.1 changelog](https://github.com/GreenLv/dsh-session-insights/blob/v0.6.1/CHANGELOG.md#061---2026-10-26) retains the full technical change list.

## 0.6.0

This release adapts to DSH `0.2.1-rc.2`, which becomes the minimum host version. Upgrade older hosts and start a new analysis run. Session logs remain in V4 format.

### Added

- Reports track background jobs and distinguish delegation from completion. A dispatched task or an ended parent turn alone does not establish completion.
- Working-directory history shows activity across projects, including inherited segments. Output follows the selected privacy mode.
- Reports recognize `web_search` and `web_fetch` calls, model selection and retries, and show token provenance. Third-party `plugin:` records contribute type and count coverage without exposing their payload.
- Both analyzers accept the new background-job and working-directory events. They continue to reject unknown required events and skip unknown ignorable ones.

### Changed

- Analysis semantics changed, so older runs cannot be resumed under the new identity and old deterministic caches are ignored. The DSH peer floor is `>=0.2.1-rc.2` and the Cordis peer range is `~4.0.5` for this release.

The [0.6.0 release acceptance](docs/acceptance/v0.6.0-release.md) and [development record](docs/acceptance/v0.6.0-rc2.1-candidate.md) describe their respective verification scopes. The [published changelog](https://github.com/GreenLv/dsh-session-insights/blob/v0.6.0/CHANGELOG.md#060) retains the detailed event and report fields.

## 0.5.2 - 2026-09-30

This update requires DSH `>=0.2.0-rc.2`. Start a new analysis run after upgrading from 0.5.1. Existing reports remain on disk. Separately installed Python CLI and Skill copies require their own update.

### Changed

- Resume now checks the run's recorded project, time window, privacy, depth and language. Conflicting selections are refused, and ambiguous matches are listed for the user to choose.
- Each plugin instance limits concurrent native analyses and queues additional work. Cancellation and unload also cancel queued requests.
- Python log reading has size and decompression limits. Files that exceed those limits are reported instead of silently truncated or replaced with an older generation.
- Scheduled prompts and asynchronous question replies are counted as injected context. They do not become human-work or authorization evidence.
- `--no-open` returns the report path without opening a file, starting a server or uploading the report. The dashboard also handles single-card rows and narrow filter controls more cleanly.

The [0.5.2 candidate record](docs/acceptance/v0.5.2-candidate.md) details the checks and limits. The [published changelog](https://github.com/GreenLv/dsh-session-insights/blob/v0.5.2/CHANGELOG.md#052---2026-09-30) retains the complete technical list.

## 0.5.1 - 2026-09-29

Reports separate interrupted tool calls with unknown outcomes from confirmed failures. If a call may have changed external state, verify that state before retrying it.

### Changed

- Session summaries and totals show separately when a call's outcome was lost and when the log contains no record of it starting. Calls with the same ID in different turns keep separate evidence.
- This release requires DSH `0.2.0-rc.1`. Start a new analysis after upgrading. Old report caches are rebuilt when needed, and saved reports remain available.

See the [release acceptance](docs/acceptance/v0.5.1-release.md) for the package, native-host and model results.

## 0.5.0 - 2026-09-26

The plugin and the Python CLI now read only V4 session data. Use DSH `0.1.7-rc.2` for this release, migrate older logs in DSH, and start a new analysis run after upgrading.

### Changed

- The report includes tool calls made inside a programmatic tool call and distinguishes permission denials from execution failures. Injected instructions are excluded from human-work statistics.
- Cancelling an analysis or unloading the plugin stops work that belongs to that run.
- npm and Python package versions now match.

See the [release acceptance](docs/acceptance/v0.5.0-release.md) for the macOS model, Windows deterministic and bilingual report checks.

## 0.4.0 - 2026-09-20

The DSH plugin now generates reports without a Python installation. The standalone Python CLI remains available.

### Changed

- The plugin writes to its own marked run directories, refuses linked paths and validates model output before saving it. A recorded tool failure remains a failure even if its output includes success text.
- Preview or delete one managed run at a time. Each run keeps its validated model output for resumption. Finish older Python runs in the CLI or start a new run in the plugin.

The [release receipt](docs/acceptance/v0.4.0-release-receipt.json) records package publication. Native DSH acceptance was pending at that release readback.

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

The dashboard now shows which skills, plugins and MCP services you use most. Active time is shown in hours.

### Added

- Usage charts rank skills, plugins and MCP services. Filtered totals also count web searches separately.
- Deterministic reports record skill calls per session in `skill_calls`.

### Changed

- The overview puts active time and token use first. The report formats numbers in its selected language and shows the daily hours in a dedicated chart.
- Filters and card actions align across sections. On narrow screens, cards stack in one column.

### Fixed

- The navigation follows the section in view and jumps directly to session details and evidence without hiding the heading under the toolbar.

See the [0.3.0 acceptance summary](docs/acceptance/v0.3.0-summary.md) for the platform checks.

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
