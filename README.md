# dsh-session-insights

Local-first, evidence-driven retrospectives for DeepSeek Harness sessions. It helps you understand work patterns and friction from your own session files; it is **behavioral review, not telemetry**.

The deterministic report runs offline. The optional semantic workflow prepares bounded evidence cleaned according to `--analysis-privacy`; when you ask the current DSH model to analyze those batches, that content is sent to the model provider configured in DSH. This project does not add another upload path.

> Compatibility target: DeepSeek Harness `0.1.0-rc.8`, Python 3.11+. Native acceptance has been completed separately on macOS and Windows 11; Linux remains CI-only. See [the candidate acceptance record](docs/acceptance/v0.1.0-candidate.md). CI alone is not native-platform evidence.

[简体中文](README.zh-CN.md)

## Safe start

Review the checkout, then install into an isolated DSH home:

```bash
python3 scripts/bootstrap.py install --dsh-home /path/to/isolated-dsh-home
/path/to/isolated-dsh-home/tools/dsh-session-insights/venv/bin/python \
  -m dsh_session_insights doctor --dsh-home /path/to/isolated-dsh-home
```

On Windows, use `py -3.11 scripts\bootstrap.py install ...` and the managed interpreter under `venv\Scripts\python.exe`.

The installer manages exactly these marked directories:

- `$DSH_HOME/skills/dsh-session-insights`
- `$DSH_HOME/tools/dsh-session-insights`

It rejects symbolic-link targets, overlapping managed roots, and existing unmarked targets. It never overwrites another Skill.

## Reports

```bash
dsh-session-insights report --dsh-home "$DSH_HOME" --days 30 --format html
dsh-session-insights report --dsh-home "$DSH_HOME" --project /path/to/project --privacy metrics
```

Defaults are `--privacy redacted`, `--analysis-privacy redacted`, and `--analysis-depth evidence`. `metrics` omits excerpts and skips semantic batching. `local` retains bounded local paths/content after automatic secret filtering and therefore must be selected explicitly.

The HTML dashboard is self-contained and is accompanied by a JSON report. Output is refused inside `$DSH_HOME/sessions`.

## Optional semantic workflow

```bash
dsh-session-insights semantic prepare --dsh-home "$DSH_HOME" --days 30 --workdir /safe/workdir
dsh-session-insights semantic validate-batch --workdir /safe/workdir --batch batch-001
dsh-session-insights semantic prepare-aggregate --workdir /safe/workdir
dsh-session-insights semantic validate-aggregate --workdir /safe/workdir
dsh-session-insights semantic finalize --workdir /safe/workdir --output report.html
```

`prepare` writes bounded, untrusted evidence batches. Have the current DSH model produce only the JSON contract requested by each batch, then run the matching validator. Validation fails closed on unknown evidence IDs, prohibited completion claims, malformed enums, or privacy leakage. `finalize --fallback` produces an explicit deterministic fallback if semantic processing cannot complete.

## Data contract and limits

- Input: file-based DSH `session.jsonl.zstd` logs under `$DSH_HOME/sessions`.
- Output schema: [`dsh-session-insights/1`](docs/schema/report-v1.schema.json). It does not promise compatibility with any unrelated schema.
- Token counts deduplicate usage per `(turn, step)`. They are usage measures, not billing or quota figures.
- v0.1 does not use the DSH `sessionQuery` API and is not a native plugin or Bundle.
- Reports infer workflow patterns; they do not prove intent, quality, task acceptance, or security.

## Development

```bash
python3 -m pip install -e '.[dev]'
python3 -m unittest discover -s tests -v
python3 scripts/build_fixture.py --check
python3 scripts/audit_public_tree.py --root .
```

The fixture is fully synthetic and reproducibly compressed. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
