# dsh-session-insights

[简体中文](README.zh-CN.md)

[![CI](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/GreenLv/dsh-session-insights)](https://github.com/GreenLv/dsh-session-insights/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn your DeepSeek Harness session history into a private, local workflow retrospective, directly from `/session-insights`.

`dsh-session-insights` is a native DSH Bundle backed by a mature Python analysis core. In plugin mode it reads replay-validated snapshots through DSH's `sessionQuery` service and produces a self-contained HTML dashboard plus companion JSON. It helps answer questions such as:

- What kinds of work am I doing with DSH?
- Which projects and workflows take the most effort?
- Where do tool failures, retries, or unfinished work appear?
- Which practices are working, and what should I try next?

This is **behavioral review, not telemetry**. It is not a live monitor, a billing calculator, or a claim that it can judge the quality of your work.

## What you get

The dashboard brings several views of the same evidence together:

| View | What it helps you understand |
|---|---|
| Overview and time comparison | Rollouts, task families, tool use, token mix, and changes between two periods |
| Work and workflow breakdown | Projects, roles, representative workflows, and completion evidence |
| Wins and friction | Evidence-backed strengths plus failures, retries, and other signals worth investigating |
| Recommendations | DSH workflow suggestions tied to measured evidence, with prompts you can copy |

The HTML file contains its own styles and data, so you can keep it locally and open it without a server. A machine-readable JSON report is written beside it.

## Install the Bundle

Requirements: DeepSeek Harness and Python 3.11 or newer. Install the published Bundle into a DSH profile, then start that profile:

```bash
dsh plugin --profile web add dsh-session-insights
dsh web
```

To install from a reviewed source checkout instead:

```bash
git clone https://github.com/GreenLv/dsh-session-insights.git
cd dsh-session-insights
dsh plugin --profile web add .
dsh web
```

Then run this in the DSH composer:

```text
/session-insights --days 30 --locale en
```

The command prepares bounded semantic batches, queues the current DSH agent to analyze them serially, and writes the final HTML/JSON under `$DSH_HOME/insights/runs/<run-id>`. Add `--deterministic` to skip the model-assisted stage. The command name intentionally differs from `/insights`, so this Bundle can coexist with `dsh-insights`.

The npm package has no install or build lifecycle script. The registry command installs the published Bundle; `dsh plugin ... add .` installs the current local checkout.

## Availability

- Install the published Bundle from [npm](https://www.npmjs.com/package/dsh-session-insights).
- Download versioned artifacts from [GitHub Releases](https://github.com/GreenLv/dsh-session-insights/releases/latest).
- Find the public directory entry on [dsh.pub](https://dsh.pub/en/plugins/dsh-session-insights/).
- Find the project in [Awesome DeepSeek Harness](https://github.com/Dominic789654/awesome-deepseek-harness#session--memory-management).

## Privacy modes

Deterministic reports run offline. In native plugin mode, complete raw snapshots are streamed from `sessionQuery` to Python over stdin and are not copied into the run directory. Choose how much session content the report and optional model stage may retain:

| Mode | Report content | Semantic analysis |
|---|---|---|
| `redacted` (default) | Keeps bounded excerpts after anonymizing identity and paths and filtering secrets | Uses bounded, redacted evidence only when you explicitly run the semantic workflow |
| `metrics` | Omits excerpts and keeps aggregate measurements | Disabled; no semantic batches are created |
| `local` | Keeps bounded local paths and text after secret filtering | Explicit opt-in for a trusted local destination and configured model provider |

The tool itself does not add an upload channel. If you use the optional semantic workflow, bounded evidence cleaned according to `--analysis-privacy` is analyzed by the model provider currently configured in DSH.

Reports are refused inside `$DSH_HOME/sessions`, so generated files cannot be mixed into the source log tree.

## Native command

```text
/session-insights [--days N] [--project PATH] [--privacy MODE]
  [--analysis-privacy MODE] [--analysis-depth LEVEL]
  [--locale zh-CN|en] [--deterministic] [--resume] [--no-open]
```

Project filters use the host operating system's path syntax. On Windows, pass a
native path such as `/session-insights --project C:/path/to/project`; a
POSIX-rooted path such as `/path/to/project` is rejected instead of silently
matching no sessions.

The semantic workflow is the default. It uses six bounded DSH tools for prepare, batch read/submit, aggregate read/submit, and finalize. Invalid model output gets one repair opportunity at the orchestration level and can then degrade explicitly to the deterministic report. The current session is counted for coverage but excluded from recommendations as meta-analysis.

## Compatible CLI and Skill workflow

The v0.1 file-log CLI and Skill remain available for automation and environments that do not mount the Bundle:

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
python3 scripts/bootstrap.py install --dsh-home "$DSH_HOME"
CLI="$DSH_HOME/tools/dsh-session-insights/venv/bin/dsh-session-insights"

# Review the last 30 days and open an English dashboard
"$CLI" report --dsh-home "$DSH_HOME" --days 30 --locale en \
  --format html --output ./dsh-insights.html --open

# Limit the report to one project on macOS or Linux
dsh-session-insights report --dsh-home "$DSH_HOME" \
  --project /path/to/project --format html --output ./project-insights.html

# Produce aggregate metrics without excerpts or semantic batches
dsh-session-insights report --dsh-home "$DSH_HOME" --privacy metrics \
  --format json --output ./dsh-metrics.json

# Check the installation
dsh-session-insights doctor --dsh-home "$DSH_HOME"
```

The Windows PowerShell equivalent uses the managed Windows launcher and a
Windows-native project path:

```powershell
$Cli = Join-Path $env:DSH_HOME 'tools\dsh-session-insights\venv\Scripts\dsh-session-insights.exe'
& $Cli report --dsh-home $env:DSH_HOME --project 'C:\path\to\project' --format html --output .\project-insights.html
```

To remove only this project's managed directories:

```bash
python3 scripts/bootstrap.py uninstall --dsh-home "$DSH_HOME"
```

The installer manages only:

- `$DSH_HOME/skills/dsh-session-insights`
- `$DSH_HOME/tools/dsh-session-insights`

It refuses symbolic-link targets, overlapping roots, and existing unmarked directories. It does not overwrite another Skill.

## Manual semantic review

The native command orchestrates semantic review by default. The CLI also exposes every phase for debugging or automation:

When using the installed DSH Skill, the current DSH model can orchestrate this workflow. For manual operation:

```bash
dsh-session-insights semantic prepare --dsh-home "$DSH_HOME" --days 30 --workdir /safe/workdir
dsh-session-insights semantic validate-batch --workdir /safe/workdir --batch batch-001
dsh-session-insights semantic prepare-aggregate --workdir /safe/workdir
dsh-session-insights semantic validate-aggregate --workdir /safe/workdir
dsh-session-insights semantic finalize --workdir /safe/workdir --output report.html
```

Each model-produced JSON file is validated before it can enter the final report. Unknown evidence IDs, prohibited completion claims, malformed enums, and privacy leakage fail closed. If the semantic stage cannot finish, `finalize --fallback` records the degradation and preserves the deterministic report.

## Current scope and limitations

- Native input is the trusted DSH `sessionQuery` service; CLI compatibility input remains `session.jsonl.zstd` under `$DSH_HOME/sessions`.
- Output follows [`dsh-session-insights/1`](docs/schema/report-v1.schema.json).
- Token counts are deduplicated per `(turn, step)` and are usage measurements, not billing or quota figures.
- The Dashboard and semantic prompt contract support `zh-CN` and `en` from the same report schema.
- Reports infer patterns from available evidence; they do not prove intent, quality, task acceptance, or security.

Compatibility evidence for the v0.2.0 Bundle:

| Environment | Evidence |
|---|---|
| macOS + DSH `0.1.1-rc.1` | Local checkout install, composed-config readback, Web-profile startup, alias-path repetition, and rendered English DOM checks passed |
| Windows + DSH `0.1.1-rc.1` | Native v0.2 local-link lifecycle and focused real-model `en`/`zh-CN` workflows passed on `11d6fe4`; deterministic slash dispatch and rendered DOM were not invoked natively |
| Remote CI | Nine Ubuntu/macOS/Windows jobs passed across Python 3.11, 3.12, and 3.13 on `11d6fe4` |
| Local regression | 11 Node tests and 36 Python tests pass; the npm dry-run contains 17 intended files |

See the [v0.2.0 candidate acceptance record](docs/acceptance/v0.2.0-candidate.md) for current evidence, and the historical [v0.1.0 acceptance record](docs/acceptance/v0.1.0-candidate.md) for the released CLI/Skill.

## Development and project docs

```bash
python3 -m pip install -e '.[dev]'
python3 -m unittest discover -s tests -v
python3 scripts/build_fixture.py --check
python3 scripts/audit_public_tree.py --root .
```

- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Distribution notes](docs/distribution.md)

The test fixture is fully synthetic and reproducibly compressed.

## License

[MIT](LICENSE)
