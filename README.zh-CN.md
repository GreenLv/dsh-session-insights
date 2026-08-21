# dsh-session-insights

[![CI](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/GreenLv/dsh-session-insights)](https://github.com/GreenLv/dsh-session-insights/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把 DeepSeek Harness 的会话历史变成一份只保存在本地的工作流复盘报告。

`dsh-session-insights` 读取电脑上已有的 DSH 会话日志，生成一个可直接打开的 HTML Dashboard 和配套 JSON。它主要帮你回答：

- 我最近主要让 DSH 做了哪些类型的工作？
- 哪些项目和工作流投入最多？
- 工具失败、重复尝试和未完成任务集中在哪里？
- 哪些做法已经有效，下一步值得尝试什么？

这是**行为复盘，不是遥测**。它不是实时监控器，不计算账单，也不会替你判断工作质量。

[English](README.md)

## 报告里有什么

Dashboard 把同一批证据组织成几个容易浏览的视角：

| 视角 | 可以看懂什么 |
|---|---|
| 总览与时段对比 | rollout、任务族、工具使用、token 构成，以及前后两个时段的变化 |
| 工作与流程拆解 | 项目、角色、代表性工作流和完成证据 |
| 亮点与摩擦 | 有证据支持的有效做法，以及失败、重试等值得调查的信号 |
| 建议 | 与测量证据绑定的 DSH 工作方式建议，并附可复制提示词 |

HTML 已内嵌样式和数据，不需要启动服务器；配套 JSON 便于继续处理或审计。

## 三步开始

需要 DeepSeek Harness `0.1.0-rc.8` 和 Python 3.11 或更高版本。

### macOS 或 Linux shell

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

最后一条命令会在当前目录生成 `dsh-insights.html` 和 `dsh-insights.json`。工具只读取 DSH 日志，不会修改原始会话。

安装过程还会把 `dsh-session-insights` Skill 放入 `$DSH_HOME/skills`，DSH 可直接发现它。你可以在 DSH 中说“复盘我最近的会话并打开本地 HTML 报告”，也可以直接使用上面的 CLI。

## 三档隐私模式

确定性报告完全离线运行。你可以决定报告中允许保留多少会话内容：

| 模式 | 报告内容 | 语义分析 |
|---|---|---|
| `redacted`（默认） | 匿名化身份和路径、过滤密钥后，保留有界摘录 | 只有显式运行语义流程时，才使用有界且已脱敏的证据 |
| `metrics` | 不保留摘录，只输出聚合测量 | 完全禁用，不生成语义批次 |
| `local` | 过滤密钥后保留有界的本地路径和文本 | 需要显式启用，只应面向可信的本地输出位置和模型提供方 |

本工具本身不会增加上传通道。如果启用可选语义流程，按 `--analysis-privacy` 清洗并限制范围后的证据，会交给 DSH 当前配置的模型提供方分析。

工具拒绝把报告写入 `$DSH_HOME/sessions`，避免生成文件混入原始日志目录。

## 常用命令

下列示例中的 `dsh-session-insights` 代表“三步开始”中得到的已安装可执行文件。

```bash
# 复盘最近 30 天并打开 Dashboard
dsh-session-insights report --dsh-home "$DSH_HOME" --days 30 \
  --format html --output ./dsh-insights.html --open

# 只看一个项目
dsh-session-insights report --dsh-home "$DSH_HOME" \
  --project /path/to/project --format html --output ./project-insights.html

# 不保留摘录，也不生成语义批次
dsh-session-insights report --dsh-home "$DSH_HOME" --privacy metrics \
  --format json --output ./dsh-metrics.json

# 检查安装状态
dsh-session-insights doctor --dsh-home "$DSH_HOME"
```

只卸载本项目管理的目录：

```bash
python3 scripts/bootstrap.py uninstall --dsh-home "$DSH_HOME"
```

安装器只管理：

- `$DSH_HOME/skills/dsh-session-insights`
- `$DSH_HOME/tools/dsh-session-insights`

它会拒绝符号链接目标、相互重叠的根目录，以及已有但不带本项目标记的目录，不会覆盖其他 Skill。

## 可选语义复盘

不调用模型也能生成完整的确定性 Dashboard。语义复盘是第二阶段，用于把有界证据归纳成工作流描述和建议。

通过已安装的 DSH Skill 使用时，当前 DSH 模型可以编排这套流程。若需手动执行：

```bash
dsh-session-insights semantic prepare --dsh-home "$DSH_HOME" --days 30 --workdir /safe/workdir
dsh-session-insights semantic validate-batch --workdir /safe/workdir --batch batch-001
dsh-session-insights semantic prepare-aggregate --workdir /safe/workdir
dsh-session-insights semantic validate-aggregate --workdir /safe/workdir
dsh-session-insights semantic finalize --workdir /safe/workdir --output report.html
```

模型生成的每个 JSON 都必须先通过验证，才能进入最终报告。未知证据 ID、禁止的完成声明、错误枚举或隐私泄漏都会 fail closed。若语义阶段不能完成，`finalize --fallback` 会记录降级状态并保留确定性报告。

## 当前范围与限制

- 输入是 `$DSH_HOME/sessions` 下基于文件的 DSH `session.jsonl.zstd`。
- 输出遵循 [`dsh-session-insights/1`](docs/schema/report-v1.schema.json)。
- token 以 `(turn, step)` 去重；这是使用量口径，不是账单或配额口径。
- v0.1 不使用 DSH `sessionQuery` API，也不是原生 plugin 或 Bundle。
- 报告只能根据现有证据推断模式，不能证明意图、质量、任务验收或安全性。

v0.1.0 的兼容性证据：

| 环境 | 证据范围 |
|---|---|
| macOS + DSH `0.1.0-rc.8` | 已完成原生生命周期验收 |
| Windows 11 + DSH `0.1.0-rc.8` | 已独立完成原生生命周期验收 |
| Ubuntu | 只有 CI；尚未完成原生 DSH 验收 |
| Python 3.11–3.13 | Ubuntu、macOS、Windows CI 矩阵 |

精确的验证范围和已知限制见 [v0.1.0 验收记录](docs/acceptance/v0.1.0-candidate.md)。

## 开发与项目文档

```bash
python3 -m pip install -e '.[dev]'
python3 -m unittest discover -s tests -v
python3 scripts/build_fixture.py --check
python3 scripts/audit_public_tree.py --root .
```

- [更新记录](CHANGELOG.md)
- [安全策略](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)
- [分发说明](docs/distribution.md)

测试 fixture 全部为合成数据，并可确定性重建。

## 许可证

[MIT](LICENSE)
