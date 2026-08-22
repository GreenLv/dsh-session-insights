# dsh-session-insights

[English](README.md)

[![CI](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/GreenLv/dsh-session-insights)](https://github.com/GreenLv/dsh-session-insights/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

用 `/session-insights` 把 DeepSeek Harness 的会话历史变成一份只保存在本地的工作流复盘报告。

`dsh-session-insights` 是原生 DSH Bundle，底层复用现有 Python 分析核心。插件模式通过 DSH `sessionQuery` 服务读取已完成回放校验的会话快照，生成一个可直接打开的 HTML Dashboard 和配套 JSON。它主要帮你回答：

- 我最近主要让 DSH 做了哪些类型的工作？
- 哪些项目和工作流投入最多？
- 工具失败、重复尝试和未完成任务集中在哪里？
- 哪些做法已经有效，下一步值得尝试什么？

这是**行为复盘，不是遥测**。它不是实时监控器，不计算账单，也不会替你判断工作质量。

## 报告里有什么

Dashboard 把同一批证据组织成几个容易浏览的视角：

| 视角 | 可以看懂什么 |
|---|---|
| 总览与时段对比 | rollout、任务族、工具使用、token 构成，以及前后两个时段的变化 |
| 工作与流程拆解 | 项目、角色、代表性工作流和完成证据 |
| 亮点与摩擦 | 有证据支持的有效做法，以及失败、重试等值得调查的信号 |
| 建议 | 与测量证据绑定的 DSH 工作方式建议，并附可复制提示词 |

HTML 已内嵌样式和数据，不需要启动服务器；配套 JSON 便于继续处理或审计。

## 安装 Bundle

需要 DeepSeek Harness 和 Python 3.11 或更高版本。先把已发布 Bundle 安装到 DSH profile，再启动该 profile：

```bash
dsh plugin --profile web add dsh-session-insights
dsh web
```

如需从已审查的源码安装：

```bash
git clone https://github.com/GreenLv/dsh-session-insights.git
cd dsh-session-insights
dsh plugin --profile web add .
dsh web
```

随后在 DSH 输入框中运行：

```text
/session-insights --days 30 --locale zh-CN
```

该命令会准备有界语义批次，让当前 DSH agent 串行分析，并把最终 HTML/JSON 写入 `$DSH_HOME/insights/runs/<run-id>`。添加 `--deterministic` 可跳过模型语义阶段。主命令刻意不占用 `/insights`，因此可以与已发布的 `dsh-insights` 共存。

npm 包不含 install/build 生命周期脚本。registry 命令安装已发布 Bundle；`dsh plugin ... add .` 安装当前本地源码。

## 获取渠道

- 从 [npm](https://www.npmjs.com/package/dsh-session-insights) 安装已发布 Bundle。
- 从 [GitHub Releases](https://github.com/GreenLv/dsh-session-insights/releases/latest) 下载版本化发布产物。
- 在 [dsh.pub](https://dsh.pub/en/plugins/dsh-session-insights/) 查看公开目录条目。
- 在 [Awesome DeepSeek Harness](https://github.com/Dominic789654/awesome-deepseek-harness/blob/main/README.zh-CN.md#会话与记忆管理) 查看项目条目。

## 三档隐私模式

确定性报告完全离线运行。原生插件把 `sessionQuery` 返回的完整快照经 stdin 流式交给 Python，不会在运行目录复制原始 transcript。你可以决定报告和可选模型阶段允许保留多少会话内容：

| 模式 | 报告内容 | 语义分析 |
|---|---|---|
| `redacted`（默认） | 匿名化身份和路径、过滤密钥后，保留有界摘录 | 只有显式运行语义流程时，才使用有界且已脱敏的证据 |
| `metrics` | 不保留摘录，只输出聚合测量 | 完全禁用，不生成语义批次 |
| `local` | 过滤密钥后保留有界的本地路径和文本 | 需要显式启用，只应面向可信的本地输出位置和模型提供方 |

本工具本身不会增加上传通道。如果启用可选语义流程，按 `--analysis-privacy` 清洗并限制范围后的证据，会交给 DSH 当前配置的模型提供方分析。

工具拒绝把报告写入 `$DSH_HOME/sessions`，避免生成文件混入原始日志目录。

## 原生命令

```text
/session-insights [--days N] [--project PATH] [--privacy MODE]
  [--analysis-privacy MODE] [--analysis-depth LEVEL]
  [--locale zh-CN|en] [--deterministic] [--resume] [--no-open]
```

项目过滤路径遵循宿主操作系统语法。在 Windows 上请使用
`/session-insights --project C:/path/to/project` 这样的原生路径；如果传入
`/path/to/project` 这类 POSIX 根路径，插件会明确报错，而不是静默匹配不到会话。

语义复盘是默认流程，通过六个有界 DSH tools 完成 prepare、批次读取/提交、汇总读取/提交和 finalize。模型输出无效时，编排提示要求每阶段最多修复一次，仍失败则显式降级并保留确定性报告。当前 insights 会话计入覆盖范围，但会标记为 meta-analysis，不进入建议生成。

## 兼容 CLI 与 Skill 流程

v0.1 的文件日志 CLI 与 Skill 继续保留，适合自动化或未挂载 Bundle 的环境：

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
python3 scripts/bootstrap.py install --dsh-home "$DSH_HOME"
CLI="$DSH_HOME/tools/dsh-session-insights/venv/bin/dsh-session-insights"

# 复盘最近 30 天并打开中文 Dashboard
"$CLI" report --dsh-home "$DSH_HOME" --days 30 --locale zh-CN \
  --format html --output ./dsh-insights.html --open

# 在 macOS 或 Linux 上只看一个项目
dsh-session-insights report --dsh-home "$DSH_HOME" \
  --project /path/to/project --format html --output ./project-insights.html

# 不保留摘录，也不生成语义批次
dsh-session-insights report --dsh-home "$DSH_HOME" --privacy metrics \
  --format json --output ./dsh-metrics.json

# 检查安装状态
dsh-session-insights doctor --dsh-home "$DSH_HOME"
```

Windows PowerShell 应使用受管的 Windows 启动器和 Windows 原生项目路径：

```powershell
$Cli = Join-Path $env:DSH_HOME 'tools\dsh-session-insights\venv\Scripts\dsh-session-insights.exe'
& $Cli report --dsh-home $env:DSH_HOME --project 'C:\path\to\project' --format html --output .\project-insights.html
```

只卸载本项目管理的目录：

```bash
python3 scripts/bootstrap.py uninstall --dsh-home "$DSH_HOME"
```

安装器只管理：

- `$DSH_HOME/skills/dsh-session-insights`
- `$DSH_HOME/tools/dsh-session-insights`

它会拒绝符号链接目标、相互重叠的根目录，以及已有但不带本项目标记的目录，不会覆盖其他 Skill。

## 手动语义复盘

原生命令默认编排语义复盘。CLI 也暴露了每个阶段，便于调试或自动化：

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

- 原生输入来自可信 DSH `sessionQuery` 服务；兼容 CLI 仍读取 `$DSH_HOME/sessions` 下的 `session.jsonl.zstd`。
- 输出遵循 [`dsh-session-insights/1`](docs/schema/report-v1.schema.json)。
- token 以 `(turn, step)` 去重；这是使用量口径，不是账单或配额口径。
- Dashboard 与语义提示契约基于同一报告 schema 支持 `zh-CN` 和 `en`。
- 报告只能根据现有证据推断模式，不能证明意图、质量、任务验收或安全性。

v0.2.0 Bundle 的兼容性证据：

| 环境 | 证据范围 |
|---|---|
| macOS + DSH `0.1.1-rc.1` | 本地源码安装、合成配置回读、Web profile 启动、别名路径重复运行和英文 DOM 渲染检查通过 |
| Windows + DSH `0.1.1-rc.1` | `11d6fe4` 上的 v0.2 本地链接生命周期及真实模型 `en`/`zh-CN` 聚焦流程通过；未原生触发确定性斜杠命令分发或浏览器 DOM 渲染 |
| 远程 CI | `11d6fe4` 上 Ubuntu/macOS/Windows × Python 3.11/3.12/3.13 共 9 个任务通过 |
| 本地回归 | Node 11 项、Python 36 项通过；npm dry-run 含 17 个预期文件 |

当前证据见 [v0.2.0 候选验收记录](docs/acceptance/v0.2.0-candidate.md)；已发布 CLI/Skill 的历史证据见 [v0.1.0 验收记录](docs/acceptance/v0.1.0-candidate.md)。

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
