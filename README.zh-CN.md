# dsh-session-insights

面向 DeepSeek Harness 会话的本地优先、证据驱动复盘工具。它从你自己的会话文件中总结工作模式与摩擦；这是**行为复盘，不是 telemetry（遥测）**。

确定性报告可完全离线运行。可选语义流程会按 `--analysis-privacy` 清洗并限制证据范围；当你让当前 DSH 模型分析批次时，这些内容会交给 DSH 中配置的模型提供方。本项目不会另建上传通道。

> 兼容目标：DeepSeek Harness `0.1.0-rc.8`、Python 3.11+。macOS 与 Windows 11 已分别完成原生验收，Linux 仍只有 CI 证据。详见[候选版本验收记录](docs/acceptance/v0.1.0-candidate.md)；CI 本身不能替代原生平台验收。

[English](README.md)

## 最短安全安装路径

先审阅 checkout，再安装到隔离的 DSH home：

```bash
python3 scripts/bootstrap.py install --dsh-home /path/to/isolated-dsh-home
/path/to/isolated-dsh-home/tools/dsh-session-insights/venv/bin/python \
  -m dsh_session_insights doctor --dsh-home /path/to/isolated-dsh-home
```

Windows 使用 `py -3.11 scripts\bootstrap.py install ...`，之后调用 `venv\Scripts\python.exe`。

安装器只管理带本项目标记的两个目录：

- `$DSH_HOME/skills/dsh-session-insights`
- `$DSH_HOME/tools/dsh-session-insights`

它拒绝符号链接、相互重叠的目标和已有但未标记的目录，不覆盖其他 Skill。

## 生成报告

```bash
dsh-session-insights report --dsh-home "$DSH_HOME" --days 30 --format html
dsh-session-insights report --dsh-home "$DSH_HOME" --project /path/to/project --privacy metrics
```

默认值是 `--privacy redacted`、`--analysis-privacy redacted` 和 `--analysis-depth evidence`。`metrics` 不保留摘录，也不生成语义批次。`local` 会在自动去除密钥后保留有界的本地路径与内容，必须显式选择。

HTML Dashboard 为自包含文件，并配套输出 JSON。工具拒绝把报告写入 `$DSH_HOME/sessions`。

## 可选语义流程

```bash
dsh-session-insights semantic prepare --dsh-home "$DSH_HOME" --days 30 --workdir /safe/workdir
dsh-session-insights semantic validate-batch --workdir /safe/workdir --batch batch-001
dsh-session-insights semantic prepare-aggregate --workdir /safe/workdir
dsh-session-insights semantic validate-aggregate --workdir /safe/workdir
dsh-session-insights semantic finalize --workdir /safe/workdir --output report.html
```

`prepare` 生成有界且视为不可信数据的证据批次。让当前 DSH 模型只按批次中的 JSON 契约生成结果，再运行对应 validator。未知证据 ID、禁止的完成声明、枚举错误或隐私泄漏都会 fail closed。若语义流程不能完成，`finalize --fallback` 会生成明确标注的确定性降级报告。

## 数据契约与限制

- 输入：`$DSH_HOME/sessions` 下基于文件的 DSH `session.jsonl.zstd`。
- 输出 Schema：[`dsh-session-insights/1`](docs/schema/report-v1.schema.json)，不承诺与无关 Schema 兼容。
- token 以 `(turn, step)` 去重；这是用量口径，不是账单或配额口径。
- v0.1 不使用 DSH `sessionQuery` API，也不是原生 plugin 或 Bundle。
- 报告只推断工作模式，不能证明意图、质量、任务验收或安全性。

## 开发验证

```bash
python3 -m pip install -e '.[dev]'
python3 -m unittest discover -s tests -v
python3 scripts/build_fixture.py --check
python3 scripts/audit_public_tree.py --root .
```

fixture 完全由合成数据组成，并可确定性重建。另见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) 和 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
