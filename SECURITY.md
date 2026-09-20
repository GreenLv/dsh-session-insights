# Security Policy

## Supported versions

Security fixes target the latest maintained release. Older versions may require an upgrade; see [published releases](https://github.com/GreenLv/dsh-session-insights/releases).

## Reporting a vulnerability

Do not open a public issue for a suspected secret leak, unsafe installer behavior, or report-data exposure. Use GitHub's private vulnerability reporting for this repository when it is enabled. Until then, contact the maintainer through the private contact method on their GitHub profile and include only synthetic reproduction data.

Never attach real DSH sessions, reports, caches, credentials, or semantic work directories. State the affected version, platform, DSH version, privacy mode, and a minimal synthetic reproduction.

## Runtime permissions

The native Bundle runs inside DSH and starts a local Python interpreter with the same user permissions. It is not an OS sandbox. Its `commands`, `tools` and `sessionQuery` injections are declared in `plugin/lib/index.js`; `cordis.patch.yml` inserts only the `session-insights` entry.

- **Files and sessions:** the Bundle reads selected snapshots through `sessionQuery` and passes them to Python over stdin. Reports, semantic evidence, batches and submitted outputs are stored under `$DSH_HOME/insights/runs/<run-id>`; semantic facet caches use `$DSH_HOME/insights/cache`. The default home is `~/.dsh`. Invalid submitted batch/aggregate files are deleted. Run artifacts and caches can retain sensitive evidence and are not automatically erased after every run.
- **Commands:** interpreter probes and the packaged `plugin_bridge` and `semantic` Python modules run as child processes with argument arrays, without shell mode. `DSH_SESSION_INSIGHTS_PYTHON` overrides interpreter selection. The host environment is inherited, and the package source is prepended to any existing `PYTHONPATH`. A substituted interpreter or untrusted import path can execute code with the user's permissions.
- **Credentials:** the plugin requires no separate API key and does not call an OS credential store. It reads environment configuration, and child processes can access inherited secrets. Session text may also contain credentials. Redaction is defense in depth, not a guarantee that arbitrary input is safe to disclose.
- **Network:** deterministic analysis has no upload channel. The default semantic workflow queues the current DSH agent to process bounded, sanitized evidence using its configured model provider. Provider credentials, retention, network access and charges follow that DSH configuration. `--deterministic` skips model analysis. Historical session text must remain untrusted data.

## Dependencies and failures

The Bundle requires Node.js 20+ or the host DSH's stricter requirement, Python 3.11+, and DSH's `commands`, `tools` and `sessionQuery` services. Exact DSH peer versions are declared in `package.json`. The package has no install/build lifecycle scripts and does not download an interpreter or auto-install Python dependencies.

The optional disk-log CLI requires `zstandard>=0.23,<1`. The Python `dev` extra provides `jsonschema>=4.23,<5` for tests; Bundle semantic validation uses the packaged validator without that dependency. Missing services or dependencies, interpreter discovery failure and nonzero Python exits stop the affected operation. Invalid model output cannot enter the final semantic report. Explicit semantic fallback retains the deterministic report and records the degradation; it does not turn an incomplete analysis into a successful semantic run. Failures may leave partial run artifacts for inspection or resumption. Reports, caches and work directories should be reviewed before sharing or deleting them.

## Optional CLI and installer

These capabilities are separate from native Bundle installation:

- The CLI reads on-disk logs under the selected DSH home and writes deterministic caches under its `insights/cache` directory. Default reports use `insights/reports`; explicit output and semantic work-directory options can select other locations. Auto-created semantic work directories may be removed after finalization unless retained explicitly. The CLI can open a report with the system browser when requested.
- `scripts/bootstrap.py install` creates a Python environment and runs pip, which may contact the configured package index. It installs under `$DSH_HOME/tools/dsh-session-insights` and `$DSH_HOME/skills/dsh-session-insights`. Replacement and uninstall require managed markers and reject symbolic-link targets. Uninstall can start a delayed Python cleanup process to remove the managed runtime. These guards do not create an OS sandbox or erase generated reports and caches.

## DSH STORE review

[Issue #965](https://github.com/AI-Scarlett/DSH-Store/issues/965) reports file, command and credential permission signals. File access and Python child processes are necessary capabilities of this implementation. The STORE's [source scanner](https://github.com/AI-Scarlett/DSH-Store/blob/079faa9233570d671e0d83d688edfa2407a0d7c6/src/automation-source-policy.mjs) also treats `process.env` and credential-related keywords as credential signals; a signal alone does not establish credential theft.

At the policy revision reviewed on 2026-09-20, [automatic approval](https://github.com/AI-Scarlett/DSH-Store/blob/079faa9233570d671e0d83d688edfa2407a0d7c6/registry/automation-policy.json) rejects these signals. This disclosure does not remove the capabilities or grant automatic approval. The plugin may remain blocked until the STORE accepts a reviewed installation path or changes its policy. Source checks and CI do not establish STORE approval, installation in a real DSH Profile, or native runtime acceptance.
