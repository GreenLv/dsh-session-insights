# Security Policy

## Supported versions

Security fixes target the latest maintained release. Older versions may require an upgrade; see [published releases](https://github.com/GreenLv/dsh-session-insights/releases).

## Reporting a vulnerability

Do not open a public issue for a suspected secret leak, unsafe installer behavior, or report-data exposure. Use GitHub's private vulnerability reporting for this repository when it is enabled. Until then, contact the maintainer through the private contact method on their GitHub profile and include only synthetic reproduction data.

Never attach real DSH sessions, reports, caches, credentials, or semantic work directories. State the affected version, platform, DSH version, privacy mode, and a minimal synthetic reproduction.

## Native runtime permissions (0.4.0)

The Bundle uses a Node.js worker for cancellable snapshot analysis. It does not launch Python, a shell or another executable. The worker receives an empty environment and an empty `execArgv`; interpreter discovery, inherited `PYTHONPATH`, Python startup hooks and forwarding of host credentials have been removed from the native path. The host still runs with DSH's OS permissions; a worker is not an OS security sandbox.

- **Files and sessions:** reads selected `sessionQuery` snapshots in memory. Reports, bounded semantic evidence and validated outputs live in marked direct children of `$DSH_HOME/insights/runs`. The configured home may be an alias, but links below it, hard-linked files and special files are rejected on every artifact operation. Batch identifiers must occur in the run manifest. Artifacts use bounded reads and atomic replacement; new POSIX directories/files use `0700`/`0600`. Windows permissions follow the parent ACL, so use a private DSH home. These checks do not defend against an actively hostile process with the same OS account changing ancestors between filesystem calls.
- **Credentials:** native analysis needs no separate API key and does not call an OS credential store. The host reads `DSH_HOME` or uses the OS home directory; the analysis worker receives no host environment. Session text may contain credentials. Redaction is defense in depth, not a guarantee that arbitrary input is safe to disclose.
- **Network:** deterministic analysis has no upload channel. The default semantic workflow queues the current DSH agent to process bounded, sanitized evidence using its configured model provider. Provider credentials, retention, network access and charges follow that DSH configuration. `--deterministic` skips model analysis. Historical text remains untrusted data.
- **Retention:** no shared native semantic cache is written. Each run keeps its reports and evidence for explicit resumption. `session_insights_cleanup(workdir)` previews a marked run; `confirm: true` deletes that run's reports and evidence after the user requests it. Cleanup refuses links, special files and unmarked legacy directories. It does not erase source logs, other runs or CLI caches. Deletion is not secure erasure and does not remove copies in backups or model-provider history.

## Dependencies and failures

The Bundle requires Node.js 20+ or the host DSH's stricter requirement, and DSH's `commands`, `tools` and `sessionQuery` services. Exact DSH peers remain in `package.json`. There are no additional npm runtime dependencies or install/build lifecycle scripts. The optional Python CLI is maintained separately from the native Bundle.

Missing services, worker failure, unsafe filesystem targets and oversized input stop the affected operation. The native selection limit is 2,000 snapshots / 64 MiB serialized input; reduce the time window or filter by project rather than silently dropping sessions. JSON artifact reads and submitted model payloads are capped at 16 MiB. Model outputs are validated in memory before writing, including evidence ownership, enum values, privacy and prohibited completion fields. A rejected replacement preserves the prior validated output. Structured tool failures cannot be overridden by success-looking output text. Explicit fallback keeps a deterministic report marked as degraded. Failures may leave a marked partial run that can be previewed and cleaned up.

Native manifests are distinct from legacy Python manifests. Resume only accepts the new native format; use the CLI to finish a legacy run or start a new native run. Shared CLI caches are neither imported nor removed. The optional disk-log CLI still requires Python 3.11+ and `zstandard>=0.23,<1`; `jsonschema>=4.23,<5` is a development-test dependency. The retained CLI's own Python processes and installer have the separate boundaries below.

## Optional CLI and installer

These capabilities are separate from native Bundle installation:

- The CLI reads on-disk logs under the selected DSH home and writes deterministic caches under its `insights/cache` directory. Default reports use `insights/reports`; explicit output and semantic work-directory options can select other locations. Auto-created semantic work directories may be removed after finalization unless retained explicitly. The CLI can open a report with the system browser when requested.
- `scripts/bootstrap.py install` creates a Python environment and runs pip, which may contact the configured package index. It installs under `$DSH_HOME/tools/dsh-session-insights` and `$DSH_HOME/skills/dsh-session-insights`. Replacement and uninstall require managed markers and reject symbolic-link targets. Uninstall can start a delayed Python cleanup process to remove the managed runtime. These guards do not create an OS sandbox or erase generated reports and caches.

## DSH STORE review

[Issue #965](https://github.com/AI-Scarlett/DSH-Store/issues/965) reports file, command and credential permission signals. File access remains necessary. The 0.4.0 native implementation removes Python child processes and environment forwarding; the optional Python CLI remains in the repository. The STORE's [source scanner](https://github.com/AI-Scarlett/DSH-Store/blob/079faa9233570d671e0d83d688edfa2407a0d7c6/src/automation-source-policy.mjs) also treats `process.env` and credential-related keywords as credential signals; a signal alone does not establish credential theft.

At the policy revision reviewed on 2026-09-20, [automatic approval](https://github.com/AI-Scarlett/DSH-Store/blob/079faa9233570d671e0d83d688edfa2407a0d7c6/registry/automation-policy.json) rejects these signals. Native hardening reduces real runtime capabilities but does not grant automatic approval; repository-wide scanning can still match the retained CLI, development scripts and credential-redaction vocabulary. The plugin may remain blocked until the STORE accepts a reviewed installation path or changes its policy. Source checks and CI do not establish STORE approval, installation in a real DSH Profile, or native runtime acceptance.
