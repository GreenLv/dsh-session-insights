# dsh-session-insights

[![CI](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/GreenLv/dsh-session-insights)](https://github.com/GreenLv/dsh-session-insights/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn your DeepSeek Harness session history into a private, local workflow retrospective.

`dsh-session-insights` reads the session logs already on your machine and produces a self-contained HTML dashboard plus companion JSON. It helps answer questions such as:

- What kinds of work am I doing with DSH?
- Which projects and workflows take the most effort?
- Where do tool failures, retries, or unfinished work appear?
- Which practices are working, and what should I try next?

This is **behavioral review, not telemetry**. It is not a live monitor, a billing calculator, or a claim that it can judge the quality of your work.

[简体中文](README.zh-CN.md)

## What you get

The dashboard brings several views of the same evidence together:

| View | What it helps you understand |
|---|---|
| Overview and time comparison | Rollouts, task families, tool use, token mix, and changes between two periods |
| Work and workflow breakdown | Projects, roles, representative workflows, and completion evidence |
| Wins and friction | Evidence-backed strengths plus failures, retries, and other signals worth investigating |
| Recommendations | DSH workflow suggestions tied to measured evidence, with prompts you can copy |

The HTML file contains its own styles and data, so you can keep it locally and open it without a server. A machine-readable JSON report is written beside it.

## Quick start

Requirements: DeepSeek Harness `0.1.0-rc.8` and Python 3.11 or newer.

### macOS or Linux shell

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/GreenLv/dsh-session-insights.git
cd dsh-session-insights

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
python3 scripts/bootstrap.py install --dsh-home "$DSH_HOME"

CLI="$DSH_HOME/tools/dsh-session-insights/venv/bin/dsh-session-insights"
"$CLI" doctor --dsh-home "$DSH_HOME"
"$CLI" report --dsh-home "$DSH_HOME" --days 30 \
  --format html --output ./dsh-insights.html --open
```

### Windows PowerShell

```powershell
git clone --branch v0.1.0 --depth 1 https://github.com/GreenLv/dsh-session-insights.git
Set-Location dsh-session-insights

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
py -3 scripts\bootstrap.py install --dsh-home $dshHome

$cli = Join-Path $dshHome "tools\dsh-session-insights\venv\Scripts\dsh-session-insights.exe"
& $cli doctor --dsh-home $dshHome
& $cli report --dsh-home $dshHome --days 30 `
  --format html --output .\dsh-insights.html --open
```

The last command creates `dsh-insights.html` and `dsh-insights.json` in the current directory. It reads DSH logs but does not modify them.

Installation also places the `dsh-session-insights` Skill under `$DSH_HOME/skills`, where DSH can discover it. You can ask DSH to “review my recent session history and open a local HTML dashboard,” or run the CLI directly as shown above.

## Privacy modes

Deterministic reports run offline. Choose how much session content the report may retain:

| Mode | Report content | Semantic analysis |
|---|---|---|
| `redacted` (default) | Keeps bounded excerpts after anonymizing identity and paths and filtering secrets | Uses bounded, redacted evidence only when you explicitly run the semantic workflow |
| `metrics` | Omits excerpts and keeps aggregate measurements | Disabled; no semantic batches are created |
| `local` | Keeps bounded local paths and text after secret filtering | Explicit opt-in for a trusted local destination and configured model provider |

The tool itself does not add an upload channel. If you use the optional semantic workflow, bounded evidence cleaned according to `--analysis-privacy` is analyzed by the model provider currently configured in DSH.

Reports are refused inside `$DSH_HOME/sessions`, so generated files cannot be mixed into the source log tree.

## Common commands

Use the installed executable shown in the quick start as `dsh-session-insights` below.

```bash
# Review the last 30 days and open the dashboard
dsh-session-insights report --dsh-home "$DSH_HOME" --days 30 \
  --format html --output ./dsh-insights.html --open

# Limit the report to one project
dsh-session-insights report --dsh-home "$DSH_HOME" \
  --project /path/to/project --format html --output ./project-insights.html

# Produce aggregate metrics without excerpts or semantic batches
dsh-session-insights report --dsh-home "$DSH_HOME" --privacy metrics \
  --format json --output ./dsh-metrics.json

# Check the installation
dsh-session-insights doctor --dsh-home "$DSH_HOME"
```

To remove only this project's managed directories:

```bash
python3 scripts/bootstrap.py uninstall --dsh-home "$DSH_HOME"
```

The installer manages only:

- `$DSH_HOME/skills/dsh-session-insights`
- `$DSH_HOME/tools/dsh-session-insights`

It refuses symbolic-link targets, overlapping roots, and existing unmarked directories. It does not overwrite another Skill.

## Optional semantic review

The deterministic dashboard already works without a model call. Semantic review is an optional second stage for synthesizing bounded evidence into workflow narratives and recommendations.

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

- Input is file-based DSH `session.jsonl.zstd` under `$DSH_HOME/sessions`.
- Output follows [`dsh-session-insights/1`](docs/schema/report-v1.schema.json).
- Token counts are deduplicated per `(turn, step)` and are usage measurements, not billing or quota figures.
- v0.1 does not use the DSH `sessionQuery` API and is not a native plugin or Bundle.
- Reports infer patterns from available evidence; they do not prove intent, quality, task acceptance, or security.

Compatibility evidence for v0.1.0:

| Environment | Evidence |
|---|---|
| macOS + DSH `0.1.0-rc.8` | Native lifecycle acceptance |
| Windows 11 + DSH `0.1.0-rc.8` | Independent native lifecycle acceptance |
| Ubuntu | CI only; native DSH acceptance has not been completed |
| Python 3.11–3.13 | Ubuntu, macOS, and Windows CI matrix |

See the [v0.1.0 acceptance record](docs/acceptance/v0.1.0-candidate.md) for the exact validation scope and known limits.

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
