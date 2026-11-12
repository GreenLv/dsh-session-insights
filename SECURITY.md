# Security Policy

## Supported versions

Security fixes target the latest maintained release. Older versions may require an upgrade; see [published releases](https://github.com/GreenLv/dsh-session-insights/releases).

## Reporting a vulnerability

Do not open a public issue for a suspected secret leak, unsafe installer behavior, or report-data exposure. Use GitHub's private vulnerability reporting for this repository when it is enabled. Until then, contact the maintainer through the private contact method on their GitHub profile and include only synthetic reproduction data.

Never attach real DSH sessions, reports, caches, credentials, or semantic work directories. State the affected version, platform, DSH version, privacy mode, and a minimal synthetic reproduction.

## Native runtime permissions (0.8.1)

Version 0.8.1 requires DSH `>=0.2.2-rc.2` and accepts only V4 input. rc.1 and older hosts are refused without a legacy-API fallback; later releases stay admitted by the declared range. Raw logs remain read-only; unsupported generations require upstream migration.

Query leases are released before Worker analysis. Each plugin instance analyzes at most two runs concurrently and queues at most eight more. Plugin disposal cancels and awaits owned work, including queued analysis. The 64 MiB detached-snapshot bound does not limit peak memory used by the host query service while opening a large log. The per-Worker `maxOldGenerationSizeMb` limit caps one Worker's V8 old space, not host RSS.

Host recovery results `TOOL_OUTCOME_UNKNOWN` and `TOOL_NOT_STARTED` are recorded as uncertain, with side-effect caveats. Caller-cancelled calls identified by structured codes `ABORTED` and `ABORTED_BEFORE_DISPATCH` are counted separately as `tool_execution.outer_cancelled` and `inner_cancelled`. These counts do not denote successes, execution failures or approval rejections. Cancellation does not establish whether side effects occurred.

rc.2 approval non-grants are structured codes under `ApprovalError`. `APPROVAL_REJECTED` is a human rejection and joins the permission-boundary cause. `APPROVAL_CANCELLED` (the approval window was cancelled without a caller cancellation) and `APPROVAL_UNAVAILABLE` (no approval service, Agent or channel could answer) are counted as their own blocked outcomes (`tool_execution.approval_cancelled`, `approval_unavailable`): not caller cancellations, not human rejections, not execution failures, and never inferred from success text or message wording.

Scheduled prompts, asynchronous question replies, subagent settlement notices and Team relay messages are counted as injected context, not user work or authorization. Background-job settlements and delegation dispatches are registry or producer records, not proof of user-task completion or resource release. In redacted and metrics modes, working-directory changes appear as project labels without raw paths.

Resume binds an explicit run to its recorded selection scope. It cannot select another project or a wider privacy range, and ambiguous multi-run requests are refused with the candidate paths. Semantic runs recorded under the previous analyzer identity cannot resume under 0.8.1. Finish them with the version that created them or start a new run.

The Bundle uses a Node.js worker for cancellable snapshot analysis. It does not launch Python, a shell or another executable. The worker receives an empty environment and an empty `execArgv`; interpreter discovery, inherited `PYTHONPATH`, Python startup hooks and forwarding of host credentials have been removed from the native path. The host still runs with DSH's OS permissions; a worker is not an OS security sandbox.

- **Files and sessions:** reads selected `sessionQuery` snapshots in memory. Reports, bounded semantic evidence and validated outputs live in marked direct children of `$DSH_HOME/insights/runs`. The configured home may be an alias, but links below it, hard-linked files and special files are rejected on every artifact operation. Batch identifiers must occur in the run manifest. Artifacts use bounded reads and atomic replacement; new POSIX directories/files use `0700`/`0600`. Windows permissions follow the parent ACL, so use a private DSH home. These checks do not defend against an actively hostile process with the same OS account changing ancestors between filesystem calls.
- **Credentials:** native analysis needs no separate API key and does not call an OS credential store. The host reads `DSH_HOME` or uses the OS home directory; the analysis worker receives no host environment. Session text may contain credentials. Redaction is defense in depth, not a guarantee that arbitrary input is safe to disclose.
- **Network:** deterministic analysis has no upload channel. The default semantic workflow queues the current DSH agent to process bounded, sanitized evidence using its configured model provider. Provider credentials, retention, network access and charges follow that DSH configuration. `--deterministic` skips model analysis. Historical text remains untrusted data.
- **Retention:** no shared native semantic cache is written. Each run keeps its reports and evidence for explicit resumption. `session_insights_cleanup(workdir)` previews a marked run; deletion additionally requires a one-shot human approval through the host approval service (`allowed-once` for exactly that call) — a model-supplied `confirm: true` alone never deletes anything, and hosts without an approval service fail closed. Typing the DSH command `/session-insights --cleanup <run> --confirm` is the direct human entry. Cleanup refuses links, special files and unmarked legacy directories. It does not erase source logs, other runs or CLI caches. Deletion is not secure erasure and does not remove copies in backups or model-provider history.

## Known upstream dependency gap

**Current rc.2 candidate (2026-11-13; accepted known host risk).** The rc.2 `dsh-agent`, `dsh-commands` and `dsh-llm` packages replace their exact `zod@4.4.3` pins with patched `4.6.6`. The candidate's root production/full and slim runtime scans no longer report [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). This does not certify the full DSH host tree as clean.

The full rc.2 host lock retains these upstream dependencies:

| Dependency | Declaring package | Known findings |
| --- | --- | --- |
| `undici@8.11.2` | Exact pins in `dsh-http-proxy`, `dsh-web-fetch-http` and `dsh-experimental-liveshare` | Eight advisories, including four high severity; patched in 8.12.2 |
| `@modelcontextprotocol/client@2.2.0` | Exact pin in `dsh-mcp-client` | One moderate advisory; patched in 2.3.0 |
| Nested `fflate@0.8.2` | Exact pin in `libreoffice-kit` | One moderate advisory; patched in 0.8.3. The separately resolved top-level copy is already 0.8.3 |

The independent 2026-11-13 scan reports ten direct advisories and 78 affected package entries. The development scan reported the same advisory set across 75 entries; propagation through three more dependent packages accounts for the change. Affected package entries are not a count of separate vulnerabilities. Four undici advisories are rated high, while npm's aggregate package summary has one high-severity package entry.

The undici findings include [TLS-option handling](https://github.com/advisories/GHSA-2m5v-pch6-74hx), [redirect/cache interaction](https://github.com/advisories/GHSA-4w7w-5xrc-9h26), [content-encoding errors](https://github.com/advisories/GHSA-xjj6-f33q-929c), [TLS renegotiation](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm), [EventSource buffering](https://github.com/advisories/GHSA-4qv8-2p9j-2685), [integrity-token handling](https://github.com/advisories/GHSA-f72v-6w45-q472), [WebSocket PONG buffering](https://github.com/advisories/GHSA-9fm3-97px-rjf6), and [decompression errors](https://github.com/advisories/GHSA-55wc-3pg8-jfw6). The other findings concern [MCP HTTP/OAuth cross-origin redirects](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) and [malformed ZIP64 decompression](https://github.com/advisories/GHSA-px8p-9vwx-vf98).

These are dependencies of the official host, outside the plugin's slim peer closure. Updating the plugin's pins cannot remove exact pins owned by the host. Overriding them would change the host under test and would not prove the unmodified rc.2 release clean. Presence in the dependency tree does not establish an exploitable DSH path; exploit reachability and everyday trigger probability have not been established. Some advisories depend on particular transport or TLS/cache configurations.

On 2026-11-13 the maintainer accepted these ten findings for 0.8.1 only, bound to the exact rc.2 host manifest/lock and the two reviewed report variants. The decision is recorded in `config/host-dependency-risk.json`; it does not extend the old Zod exception or cover root/runtime/Python findings. The raw host scan still exits 1 and is classified separately as `accepted_known_risk`, never clean. Product/host identity changes, changed host manifests or locks, new advisories, unreviewed reports, scanner failures and missing steps invalidate acceptance. See the [candidate acceptance record](docs/acceptance/v0.8.1-candidate.md) for the current verification boundary.

**Historical Zod decisions.** The vulnerable rc.1 dependency trees and earlier hosts remain historical evidence, not supported 0.8.1 targets. The Zod advisory described excessive allocation during validation of large invalid arrays. A reachable DSH exploit path was not established; functional tests and Worker limits did not prove the host protected.

- On 2026-10-26 the maintainer accepted that specific risk for 0.6.1 and its reviewed rc.2/rc.3 inputs. The [0.6.1 exception](https://github.com/GreenLv/dsh-session-insights/blob/v0.6.1/config/dependency-audit-exceptions.json) did not carry forward.
- On 2026-11-03 the maintainer accepted it for 0.7.0 only, bound to reviewed rc.2/rc.5 inputs and two vulnerability graph variants containing 23–24 affected entries.
- On 2026-11-06 the maintainer accepted it for 0.8.0 only, bound to reviewed rc.1 manifests, locks, host queue and two graph variants containing 18 affected entries. Local production/full scans exited 1 and were assessed as `accepted_known_risk`, rather than clean. The [0.8.0 policy](https://github.com/GreenLv/dsh-session-insights/blob/v0.8.0/config/dependency-audit-exceptions.json) and [release record](docs/distribution.md#published-080-2026-11-07) retain that decision.

Those event-bound decisions expired when their product/dependency inputs changed. The file retained under `config/dependency-audit-exceptions.json` is historical; the 0.8.1 scanner does not consult it. None of those grants authorizes the ten current host advisories. The [upstream Zod report](https://github.com/deepseek-ai/deepseek-harness/discussions/10847) remains a record of the earlier pin issue.

## Dependencies and failures

The Bundle requires Node.js `>=24.9.0` and DSH's `commands`, `tools` and `sessionQuery` services. Exact DSH peers remain in `package.json`. There are no additional npm runtime dependencies or install/build lifecycle scripts. The optional Python CLI is maintained separately from the native Bundle.

Missing services, worker failure, unsafe filesystem targets and oversized input stop the affected operation. The native selection limit is 2,000 snapshots / 64 MiB serialized input, with at most two analyses running concurrently per instance; reduce the time window or filter by project rather than silently dropping sessions. JSON artifact reads and submitted model payloads are capped at 16 MiB. Model outputs are validated in memory before writing, including evidence ownership, enum values, privacy and prohibited completion fields. A rejected replacement preserves the prior validated output. Structured tool failures cannot be overridden by success-looking output text. Explicit fallback keeps a deterministic report marked as degraded. Failures may leave a marked partial run that can be previewed and cleaned up.

The optional Python CLI bounds each session log read by decoded bytes, line count and single-line size; a log exceeding a budget is refused with an explicit `resource_limited_files` coverage count and is never silently truncated or replaced by an older generation. Zstandard blocks are decoded incrementally (at most 128 KiB of new output per call), and decoder windows are limited to 64 MiB. Truncated zstd frames, corrupt UTF-8 and oversized header frames are detected instead of silently dropping the tail.

Native manifests are distinct from legacy Python manifests. Resume only accepts native manifests that record a selection scope matching the request; use the CLI to finish a legacy run or start a new native run. Shared CLI caches are neither imported nor removed. The optional disk-log CLI still requires Python 3.11+ and `zstandard>=0.23,<1`; `jsonschema>=4.23,<5`, `tzdata>=2024.1` (portable IANA calendar test data), and `semver>=7.7,<8` are development-test dependencies. The retained CLI's own Python processes and installer have the separate boundaries below.

## Optional CLI and installer

These capabilities are separate from native Bundle installation:

- The CLI reads on-disk logs under the selected DSH home and writes deterministic caches under its `insights/cache` directory (new POSIX directories/files use `0700`/`0600`; Windows uses ACLs (parent inheritance or private ACLs created by the Python runtime) and needs a private DSH home; a bounded header read gates scope, so out-of-scope logs are never parsed or cached; cache entries hold only a whitelisted, pre-projected session projection). Legacy cache versions from earlier releases are ignored, not imported; `dsh-session-insights cache` previews them and `--delete` removes only confirmed cache roots. Default reports use `insights/reports`; explicit output and semantic work-directory options can select other locations. Auto-created semantic work directories may be removed after finalization unless retained explicitly. The CLI can open a report with the system browser when requested.
- `scripts/bootstrap.py install` creates a Python environment and runs pip, which may contact the configured package index. It installs under `$DSH_HOME/tools/dsh-session-insights` and `$DSH_HOME/skills/dsh-session-insights`. Replacement and uninstall require managed markers and reject symbolic-link targets. Uninstall can start a delayed Python cleanup process to remove the managed runtime. These guards do not create an OS sandbox or erase generated reports and caches.

## DSH STORE review

[Issue #965](https://github.com/AI-Scarlett/DSH-Store/issues/965) reports file, command and credential permission signals. File access remains necessary. The 0.4.0 native implementation removes Python child processes and environment forwarding; the optional Python CLI remains in the repository. The STORE's [source scanner](https://github.com/AI-Scarlett/DSH-Store/blob/079faa9233570d671e0d83d688edfa2407a0d7c6/src/automation-source-policy.mjs) also treats `process.env` and credential-related keywords as credential signals; a signal alone does not establish credential theft.

At the policy revision reviewed on 2026-09-20, [automatic approval](https://github.com/AI-Scarlett/DSH-Store/blob/079faa9233570d671e0d83d688edfa2407a0d7c6/registry/automation-policy.json) rejects these signals. Native hardening reduces real runtime capabilities but does not grant automatic approval; repository-wide scanning can still match the retained CLI, development scripts and credential-redaction vocabulary. The plugin may remain blocked until the STORE accepts a reviewed installation path or changes its policy. Source checks and CI do not establish STORE approval, installation in a real DSH Profile, or native runtime acceptance.
