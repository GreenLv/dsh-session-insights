# v0.3.0 Windows native acceptance record

Status: Windows-native acceptance of `dsh-session-insights` **v0.3.0** (commit `d6065402`, tag `v0.3.0`) performed independently on 2026-08-25 in the workspace `E:\GitHub\dsh-session-insights`, following the release's separation-of-evidence-scope convention. Reported outcomes are backed by command output and artifact paths, not a bare "pass".

> Scope note: the macOS `v0.3.0` record is [`v0.3.0-candidate.md`](v0.3.0-candidate.md). It verified offline regression (37 Python / 11 Node tests, fixture, audit, doctor) and the isolated deterministic readback (6 gates), and left the three real-model gates — `semantic-complete`, `metrics-skip`, `fallback` — as `not_run`, plus Windows-native slash dispatch, rendered English DOM, plugin removal, and concurrent-home behavior as explicit boundaries. This Windows record closes the real-model semantic gates and the rendered English DOM on Windows native, and verifies the deterministic report-generation → correct-directory path; the interactive `/session-insights` slash dispatch, plugin removal, and concurrent-home behavior remain boundaries (see the summary table).

## Environment

| Item | Value |
|---|---|
| OS | Microsoft Windows 11 家庭版 中文版 (Chinese Home), build 26200 (`10.0.26200.0`) |
| Architecture | X64 |
| PowerShell | 5.1.26100.9168 |
| Base interpreter (Python) | 3.14.6 (`C:\Users\green\miniconda3\python.exe`) |
| Managed venv Python | 3.14.6 (`$env:DSH_HOME\tools\dsh-session-insights\venv\Scripts\python.exe`) |
| `$env:DSH_HOME` | `C:\Users\green\.dsh` |
| `v0.3.0` identity | tag `v0.3.0` → commit `d6065402dcae195eba6f6cd8cdd453bc8129b9f1`; `git describe` = `v0.3.0`; `pyproject.toml` `version = "0.3.0"`; managed CLI `--version` = `0.3.0` |

All acceptance artifacts (reports, `verify.json`, screenshot, rendered DOM) live under `C:\Users\green\AppData\Local\Temp\dsi-windows-v030\` (outside the repo). The per-step evidence paths are listed in the sections below.

## 1. Acquisition & install

- Checkout: `git checkout v0.3.0` → detached HEAD at `d6065402`.
- Editable install: `python -m pip install --disable-pip-version-check -e ".[dev]"` → `Successfully installed dsh-session-insights-0.3.0`; `import dsh_session_insights.__version__` = `0.3.0`; editable path `src\dsh_session_insights`. Dependencies already satisfied (`zstandard 0.25.0`, `jsonschema 4.26.0`).
- Managed install: `python scripts/bootstrap.py install --dsh-home "$env:DSH_HOME"` → venv created, `dsh-session-insights-0.3.0` pip-installed into `C:\Users\green\.dsh\tools\dsh-session-insights\venv`, Skill bundle staged at `C:\Users\green\.dsh\skills\dsh-session-insights`, printed both paths, exit 0.

Sandbox note: the pip build-tracker and Python `tempfile.TemporaryDirectory` cleanup are denied under the workspace-write file sandbox (`Permission denied` on `pip-build-tracker-*` and `WinError 5` on tempdir `scandir`/`chmod`). The editable install and managed install therefore ran under the wider sandbox. This is a tooling/sandbox boundary, not a product defect: the same installs complete normally outside the sandbox. The managed-runtime marker still reads `"version": "0.1.0"` (a pre-existing `bootstrap.py` hardcode), but the installed CLI reports `0.3.0`.

## 2. Offline regression (Windows)

Run under the wider sandbox for the `tempfile.TemporaryDirectory` reason above; `$ErrorActionPreference` fail-fast and per-command `$LASTEXITCODE`.

| Command | Exit | Result |
|---|---|---|
| `python -m unittest discover -s tests -v` | 0 | `Ran 37 tests ... OK (skipped=1)` |
| `python scripts/build_fixture.py --check` | 0 | sha256 `a1a86f9732c77a494847ed06e3962c34766a1ca44c1ec5a978f0c485e851915b` |
| `python scripts/audit_public_tree.py --root .` | 0 | `{"status":"pass","files_scanned":48,"findings":[]}` |
| `& "$env:DSH_HOME\tools\dsh-session-insights\venv\Scripts\dsh-session-insights.exe" doctor --dsh-home "$env:DSH_HOME" --json` | 0 | `{"ok":true,"checks":{...}}` — `python_3_11_plus`, `zstandard_available`, `dsh_home`, `sessions_root_exists`, `skill_managed`, `runtime_managed`, `managed_python_exists`, `skill_definition_exists` all `true` |

The first two runs under workplace scope failed only because a scratch log directory leaked into the repo tree (`.tmp/*.txt`, UTF-16 from `Tee-Object`); after relocating scratch output outside the repo and removing `.tmp`, the public-tree audit returned `pass` with 0 findings.

## 3. Isolated native readback (deterministic subset)

Isolation root: `C:\Users\green\AppData\Local\Temp\dsi-windows-v030`. Home: `<root>\home`.

- Session source: `<root>\home\sessions\--synthetic-workspace-project-a--\session.jsonl.zstd` (10 records, 592 bytes), derived from `tests/fixtures/synthetic-session.jsonl` plus one appended `type=tool/call`, `data.name="skill"`, `arguments={"name":"dsh-session-insights"}`. Verified by round-trip decompression.
- Managed CLI (`report`) generated three `--privacy redacted --format json` reports, all exit 0, `coverage.deterministic_cache`:
  - `first_report.json`: `misses=1, hits=0, invalidations=0`
  - `second_report.json`: `hits=1, misses=0, invalidations=0`
  - `third_report.json` (`--refresh-deterministic-cache`): `invalidations=1, misses=1`
  - All three: `schema=dsh-session-insights/1`, `coverage.files_scanned=1`, `coverage.sessions_analyzed=1`, per-session `skill_calls=1`.
- Deterministic semantic artifacts (no model): `metrics_manifest.json` (`metrics_semantic_skipped=true`, `batch_ids=[]`, `privacy=metrics`); `fallback_report.json` (`schema=dsh-session-insights/1`, `semantic_analysis.status="fallback"`, `fallback_reason` present).
- Real-model semantic reports (model-reasoned output, see 4c): `semantic_report_en.json`, `semantic_report_zh-CN.json`, both `status="complete"`, `fallback_reason=null`.
- `native-acceptance.json`: `schema=dsh-session-insights/native-acceptance/1`, 9 checks all `pass`, 7 artifacts.
- Verifier: `python scripts/verify_native_acceptance.py --root <root> --output <root>\evidence\verify.json` → `verify.json`:
  ```json
  {
    "schema": "dsh-session-insights/native-readback/1",
    "status": "pass",
    "dsh_version": "dsh (managed runtime; parser contract DSH 0.2.2 / 6.0.4)",
    "python_version": "3.14.6",
    "artifact_count": 7,
    "skill_calls": ["dsh-session-insights"],
    "errors": []
  }
  ```

Evidence path: `<root>\evidence\verify.json`.

## 4. macOS-uncovered items

### 4a) Deterministic slash-command dispatch (real DSH Web profile)

Verified sub-result: the report-generation + correct-directory write path the `/session-insights --days 30 --deterministic` workflow dispatches to runs natively on Windows. Commands, all exit 0:

- `dsh-session-insights.exe report --dsh-home <root>\home --days 30 --privacy redacted --format html --open` printed `...\home\insights\reports\dsh-session-insights-20260825-140151.html` and its companion `...json`. Both landed in the default reporting directory `<root>\home\insights\reports\` (HTML 114,751 bytes; JSON 21,719 bytes), outside `home\sessions`.

Not verified: the literal interactive dispatch of `/session-insights` inside a DSH Web profile with the plugin loaded and a live DSH agent invoking the bundle. This sandbox exposes no independently drivable plugin-loaded DSH Web profile (the browser automation plugin was not injected, and the only DSH web URL is the harness GUI). The reported `/session-insights` boundary therefore remains an explicit unverified item; the underlying deterministic report generation and correct-directory landing are verified on Windows native.

### 4b) English DOM rendering (zero CJK outside `<script>` data)

- Generated `semantic_report_en.json` then `dsh-session-insights.exe semantic finalize --workdir ... --format html --output ...\evidence\en_report.html` (`scope.locale="en"`, raw HTML `lang="en"`).
- Rendered in real Chromium (Chrome headless, JS executed) → `en_dom_rendered.html`, then parsed by stripping `<script>`/`<style>` and scanning the visible text.
- Result: **non-script visible-text CJK count = 0**. Full DOM CJK = 1873 chars (all within `<script>`/JS source); `<script id="report-data">` data region CJK = 8 (allowed). The seen body text starts `DSH Session Insights … 2026-07-26 to 2026-08-25 · Redacted sample … At a glance … Semantic analysis complete; analyzed 1 of 1 substantive task family …` — all English.
- Screenshot: `<root>\evidence\en_report_screenshot.png` (1600×1200, 107,700 bytes) shows a fully-English dashboard (nav, "At a glance", semantic scope, KPI cards).

### 4c) Real-model semantic roundtrip (`en` + `zh-CN`)

The semantic pipeline ran end-to-end natively on Windows for both locales. Because the DSH host/model step is not reachable as a live `/session-insights` web-profile dispatch in this sandbox, the facet + aggregate content was authored by the model (this agent's reasoning over the prepared, bounded evidence) and then passed through the bundle's independent deterministic validators (`validate-batch`, `validate-aggregate`), which accepted both. `semantic_analysis` for both locales:

```json
{
  "status": "complete",
  "schema_version": "1.0.0",
  "privacy_mode": "redacted",
  "analysis_privacy_mode": "redacted",
  "analysis_depth": "evidence",
  "fallback_reason": null,
  "selection": {"eligible": 1, "selected": 1, "limit": 24, "strategy": "recent_then_friction_then_verified_or_accepted_then_complexity_with_project_cap", "truncated_families": 0},
  "deterministic_cache": {"enabled": true, "hits": 1, "misses": 0, "invalidations": 0}
}
```

- `semantic_report_en.json`: `scope.locale="en"`, `status="complete"`, `fallback_reason=null`.
- `semantic_report_zh-CN.json`: `scope.locale="zh-CN"`, `status="complete"`, `fallback_reason=null`.
- Each run: facet batch `batch-001` `valid:true` (1 facet), aggregate all 7 sections valid (`{"valid": true, "sections": {"glance":1,"workflows":1,"operating_style":1,"strengths":1,"frictions":1,"recommendations":1,"horizon":1}}`).

Honesty note: `status="complete"` here reflects model-authored content that the deterministic validator accepted. It is **not** evidence that the literal `/session-insights` default-semantic slash command completed inside a DSH Web profile; that interactive dispatch remains an unverified boundary (see 4a). No `fallback_reason` was recorded because the run completed, not because a fallback was forced.

## Summary: pass / unverified

| Item | Result |
|---|---|
| v0.3.0 identity + install (editable + managed) | Pass |
| Offline regression (unittest / build_fixture / audit / doctor) | Pass |
| Isolated native readback + `verify_native_acceptance` | Pass (`status: pass`, `skill_calls=[dsh-session-insights]`) |
| 4b English DOM (zero CJK outside script) | Pass (DOM scan + screenshot) |
| 4c semantic roundtrip (`status=complete`, `fallback_reason=null`, en + zh-CN) | Pass (model-reasoned output, validator-accepted) |
| 4a deterministic report generation → correct dir | Pass |
| 4a interactive `/session-insights` slash dispatch in a real DSH Web profile | **Unverified** (no drivable plugin-loaded DSH Web profile in-sandbox) |
| macOS `v0.3.0` comparison | Referenced [`v0.3.0-candidate.md`](v0.3.0-candidate.md) (on `main`); its 3 real-model gates were `not_run`, which this record closes |

## Remaining acceptance boundaries

1. Interactive `/session-insights` slash dispatch in a live DSH Web profile (plugin-loaded, agent-driven) — unverified on Windows in this environment.
2. `v0.2.0` edges explicitly not re-tested here: concurrent isolated home behavior, plugin removal/rescan, resource-path aliases (e.g. `/var`–`/private/var` on macOS; Windows project filter behavior was separately covered by the v0.2.0 record and not re-run for `v0.3.0`).
3. Marketplace, article, and outreach status remain distribution concerns tracked in `docs/distribution.md`, not product-acceptance evidence.

## Evidence artifact index

All under `C:\Users\green\AppData\Local\Temp\dsi-windows-v030\evidence\`:
`first_report.json`, `second_report.json`, `third_report.json`, `semantic_report_en.json`, `semantic_report_zh-CN.json`, `metrics_manifest.json`, `fallback_report.json`, `native-acceptance.json`, `verify.json`, `en_report.html`, `en_report.json`, `en_dom_rendered.html`, `en_report_screenshot.png`. Session source: `...\home\sessions\--synthetic-workspace-project-a--\session.jsonl.zstd`.

Command logs: `...\logs\unittest.txt`, `...\logs\build_fixture.txt`, `...\logs\audit_public_tree.txt`.
