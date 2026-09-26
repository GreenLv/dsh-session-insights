# dsh-session-insights

[English](README.md) | [介绍文章](https://blog.csdn.net/LvGreat/article/details/164067146) | [更新日志](CHANGELOG.zh-CN.md)

[![CI](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/GreenLv/dsh-session-insights/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/GreenLv/dsh-session-insights)](https://github.com/GreenLv/dsh-session-insights/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

运行 `/session-insights`，把 DeepSeek Harness 的会话历史整理成一份本地工作流复盘。Bundle 通过 DSH 的 `sessionQuery` 服务读取会话，写出可直接打开的 HTML Dashboard 和配套 JSON。

它主要回答：

- 我最近主要让 DSH 做了哪些类型的工作？
- 哪些项目和工作流投入最多？
- 工具失败、重复尝试和未完成任务集中在哪里？
- 哪些做法已经有效，下一步值得尝试什么？

这是**行为复盘，不是遥测**。它不是实时监控器，不计算账单，也不会替你判断工作质量。

![许多分散的会话轨迹经过分析透镜，收束为结构化证据卡片和一份清晰报告](https://raw.githubusercontent.com/GreenLv/dsh-session-insights/main/assets/social/hero.jpg)

## 报告里有什么

Dashboard 把同一批证据组织成几个容易浏览的视角：

| 视角 | 可以看懂什么 |
|---|---|
| 总览与时段对比 | 会话数、任务族、token 用量，以及前后两个时段的变化 |
| 工作与流程拆解 | 项目、角色、代表性工作流和完成证据 |
| 使用方式 | 每日活跃时间趋势、会话类型、常用工具、Skill 与插件/MCP 使用、文件类型和本地活跃时段 |
| 亮点与摩擦 | 有证据支持的有效做法，以及失败、重试等值得调查的信号 |
| 建议 | 与测量证据绑定的 DSH 工作方式建议，并附可复制提示词 |

<p align="center"><img src="https://raw.githubusercontent.com/GreenLv/dsh-session-insights/main/assets/screenshots/dashboard-overview-zh.png" alt="确定性复盘 Dashboard 总览（合成数据）" width="640"></p>

HTML 已内嵌样式和数据，不需要启动服务器；配套 JSON 便于继续处理或审计。

## 安装 Bundle

`0.5.0` Bundle 需要 DSH `0.1.7-rc.2` 和 Node.js `^22.19.0 || >=24.0.0`，无需 Python。可选的文件日志 CLI 仍需要 Python 3.11+。

**DSH 兼容性：** 软件包仅要求 `0.1.7-rc.2`。契约与服务测试覆盖合成 V4 输入；具体制品的宿主、模型、平台与页面验收结果分别记录。详见 [DSH 兼容性](#dsh-兼容性)。

把 0.5.0 Bundle 安装到 DSH profile，再启动该 profile：

```bash
dsh plugin --profile web add dsh-session-insights@0.5.0
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
- 其他已核验的社区条目统一记录在[分发状态表](docs/distribution.md)。

## 权限与依赖

Bundle 在 Node.js worker 中分析 `sessionQuery` 快照，不再启动 Python 或 Shell。worker 使用空环境，也不继承 Node 启动参数；`DSH_SESSION_INSIGHTS_PYTHON`、`PYTHONPATH` 和 Python 启动文件不再影响原生分析。可选 Python CLI 仍作为独立流程保留。

| 能力 | 使用范围 |
|---|---|
| 会话与文件 | 在内存中读取选中的快照，将报告、有界证据和通过校验的模型输出写入 `$DSH_HOME/insights/runs` 下带管理标记的目录。不保存原始快照，不创建共享语义缓存。 |
| 路径保护 | 仅接受带标记的直接运行子目录；逐次检查产物路径，拒绝链接和特殊文件。批次 ID 必须属于本次运行清单。新建目录和文件使用仅所有者可访问的 POSIX 权限；Windows 访问权限由父目录 ACL 决定。 |
| 环境与凭据 | 宿主仅用 `DSH_HOME` 或操作系统用户目录定位存储。原生分析不探测解释器、不转发环境变量、不需要独立 API Key，也不调用凭据库。会话内容仍可能含有秘密，脱敏不能保证适合公开。 |
| 网络与模型 | 确定性分析可离线运行。默认语义流程经当前 DSH agent 把清洗并限制范围的证据交给配置的模型提供方，遵循该提供方的数据处理规则和计费方式。添加 `--deterministic` 可跳过此阶段。 |

Bundle 需要 Node.js `^22.19.0 || >=24.0.0`，以及 DSH 的 `commands`、`tools` 和 `sessionQuery` 服务，并使用声明的 rc.2 DSH peer 依赖（含官方消息 helper）。服务缺失、worker 失败、不安全路径或无效语义输出都会使相关操作停止。模型输出先在内存校验再写入；无效的替换请求不会覆盖已有合法结果。显式回退会生成标记为降级的确定性报告。

每次最多分析 2,000 个选中快照，序列化输入上限为 64 MiB；超出时请缩短 `--days` 或按 `--project` 筛选。旧分析运行不能按 V4 契约恢复，升级后请新建运行。新运行保留自身已验证输出供恢复使用，不再跨运行复用语义缓存。确定性摘要措辞已更新，报告 schema 和 Dashboard 仍与 CLI 共用。

### 保留与清理

报告和证据会保留到显式删除。先让 agent 用运行目录 `workdir` 调用 `session_insights_cleanup`，预览文件和字节数；再明确要求删除该运行，使用 `confirm: true` 执行。清理会删除整个带标记的运行目录，包括报告，且不可撤销。未标记的旧目录和带链接的条目会被拒绝；其他运行、原始日志和可选 CLI 的共享缓存会保留。旧 CLI 产物请单独检查后处理。

可选 CLI 仍需要 Python 3.11+；读取压缩日志需要 `zstandard>=0.23,<1`，`jsonschema>=4.23,<5` 仅供开发测试使用。其 bootstrap 安装器会调用 pip，并管理独立的 skill/runtime 目录。具体边界及商城策略限制见[安全策略](SECURITY.md)。

## 三档隐私模式

确定性报告完全离线运行。原生插件在内存中分析 `sessionQuery` 返回的完整快照，不会在运行目录复制原始 transcript。你可以决定报告和可选模型阶段允许保留多少会话内容：

| 模式 | 报告内容 | 语义分析 |
|---|---|---|
| `redacted`（默认） | 匿名化身份和路径、过滤密钥后，保留有界摘录 | 默认语义流程使用有界且已脱敏的证据；`--deterministic` 跳过该阶段 |
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

项目过滤路径遵循宿主操作系统语法。在 Windows 上请使用 `/session-insights --project C:/path/to/project` 这样的原生路径；如果传入 `/path/to/project` 这类 POSIX 根路径，插件会明确报错，而不是静默匹配不到会话。

语义复盘是默认流程。模型输出无效时最多修复一次，仍失败则明确降级并保留确定性报告。当前复盘会话计入覆盖范围，但标记为元分析，不进入建议生成。

## 兼容 CLI 与 Skill 流程

V4 文件日志 CLI 与 Skill 继续保留，适合自动化或未挂载 Bundle 的环境：

```bash
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
python3 scripts/bootstrap.py install --dsh-home "$DSH_HOME"
CLI="$DSH_HOME/tools/dsh-session-insights/venv/bin/dsh-session-insights"

# 复盘最近 30 天并打开中文 Dashboard
"$CLI" report --dsh-home "$DSH_HOME" --days 30 --locale zh-CN \
  --format html --output ./dsh-insights.html --open

# 在 macOS 或 Linux 上只看一个项目
"$CLI" report --dsh-home "$DSH_HOME" \
  --project /path/to/project --format html --output ./project-insights.html

# 不保留摘录，也不生成语义批次
"$CLI" report --dsh-home "$DSH_HOME" --privacy metrics \
  --format json --output ./dsh-metrics.json

# 检查安装状态
"$CLI" doctor --dsh-home "$DSH_HOME"
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

原生命令默认编排语义复盘。CLI 也暴露每个阶段，便于调试或自动化：

```bash
dsh-session-insights semantic prepare --dsh-home "$DSH_HOME" --days 30 --workdir /safe/workdir
dsh-session-insights semantic validate-batch --workdir /safe/workdir --batch batch-001
dsh-session-insights semantic prepare-aggregate --workdir /safe/workdir
dsh-session-insights semantic validate-aggregate --workdir /safe/workdir
dsh-session-insights semantic finalize --workdir /safe/workdir --output report.html
```

模型生成的每个 JSON 都必须先通过验证，才能进入最终报告。未知证据 ID、禁止的完成声明、错误枚举或隐私泄漏都会 fail closed。若语义阶段不能完成，`finalize --fallback` 会记录降级状态并保留确定性报告。

## 当前范围与限制

- 原生输入来自可信 DSH `sessionQuery` 服务；CLI 只读取 `$DSH_HOME/sessions` 下的 `session.v4.jsonl.zstd` 或 `session.v4.jsonl`，旧原始日志需由上游 DSH 迁移。
- 输出遵循 [`dsh-session-insights/1`](docs/schema/report-v1.schema.json)。
- token 以 `(turn, step)` 去重；这是使用量口径，不是账单或配额口径。
- Dashboard 与语义提示契约基于同一报告 schema 支持 `zh-CN` 和 `en`。
- 报告只能根据现有证据推断模式，不能证明意图、质量、任务验收或安全性。

历史 0.2.0 包身份、CI、macOS 原生验收和限定的 Windows 原生验收记录在 [v0.2.0 发布验收记录](docs/acceptance/v0.2.0-candidate.md)中。这些历史结果不代表当前版本。v0.1 CLI/Skill 的历史证据保留在 [v0.1.0 验收记录](docs/acceptance/v0.1.0-candidate.md)。已发布运行时的历史兼容性证据及平台边界记录在 [0.1.5-rc.2 验收记录](docs/acceptance/v0.1.5-rc.2-compatibility.md)中。

## DSH 兼容性

默认只支持明确验证过的最低基线，或经验证的 DSH 最新版本。不再维护历史 DSH 版本，不承诺中间版本连续兼容，也不会在新版发布后自动将其视为已支持。使用旧版宿主时，请升级到已验证的基线。

本版只接受 DSH `0.1.7-rc.2`。原生分析读取宿主恢复后的 V4 快照；可选 Python CLI 只读取 `session.v4.jsonl` 和 `session.v4.jsonl.zstd`。旧原始日志需先由上游 DSH 迁移。当前文件损坏或存在高于 V4 的代数时，不会回退读取旧文件。

升级后请新建分析运行：旧 manifest 和缓存不符合新输入契约，不能继续 resume。已经输出的 HTML、JSON 和 Markdown 报告保留。单独安装的 CLI/Skill 需从同一版本更新；安装 Bundle 不会更新它们。

工具工作量包含日志记录的程序化工具调用（PTC）内层调用。JSON 的 `tool_execution` 分别记录外层运输调用、内层执行、失败和未结束调用；每个失败调用结果计一次。若内层调用和外层程序都失败，则保留两个结果，不据此推断它们是否源于同一个原因。权限拒绝不算验证命令执行失败。developer 工具注册消息和定时注入不计人工请求。

精确制品、CI、macOS 模型流程、Windows 确定性宿主检查及中英文页面人工检查见 [0.5.0 发布验收记录](docs/acceptance/v0.5.0-release.md)。[冻结候选记录](docs/acceptance/v0.5.0-rc2-candidate.md)保留源码审查矩阵。历史验收只适用于各自注明的实现。

## 会话日志代际

同一个逻辑会话可以保留多个不可变日志代际。读取方只选取其中一个，依据规范文件名而非文件修改时间。

| 情况 | 行为 |
| --- | --- |
| 同一会话目录存在多个规范代际 | 选取版本最高者；该会话只统计一次，迁移后的会话不会被重复相加 |
| 仅有第 0–3 代 | 拒绝分析并提示需要迁移；请使用上游 DSH 迁移 |
| 非规范名称（临时文件、大写、前导零、`.v0`、`session.lock`） | 永不选取；写入中的文件不会被误认为已提交代际 |
| 高于本读取方支持的代际 | 记录诊断并跳过，同时给出警告；**不会**静默按旧代际输出报告 |
| 当前代际损坏或无法解压 | 记为不可读文件；**不会**回退到旧代际 |
| 同一目录混用两种压缩编码 | 记为歧义并跳过该会话 |
| 多个工程目录声称同一会话 ID | 各会话目录独立计数 |

工具和用量统计保留历史事件；语义证据则排除已被替换的消息。DSH 根据事件日志维护模型可见的有序对话（surface），替换操作以该对话中的位置为准，不能按事件序号大小推断。

| 事件 | 行为 |
| --- | --- |
| `system/message` | 记为系统内容；绝不算作用户工作，不进入摘录，不泄露到标题或语义证据 |
| `source.kind == "user"` 的 `user/message` | 真人直接输入：计入用户工作，可作为标题来源 |
| 其他 `source.kind` 的 `user/message` | 合成注入上下文（plugin、goal、skill 目录、子代理报告等）：单独计数，排除在用户工作与语义证据之外 |
| `assistant/attempt` | 记为未产出可见回复的模型尝试；不会伪造成 assistant 消息，其 Token 用量如实标记为不可得而非估算 |
| `assistant/message` | 携带该步用量；用量按 `(turn, step)` 去重，stream 字段不会造成重复相加 |
| `surfaceOp: "append"` | 表面正常增长 |
| `surfaceOp: {op: "replace", startSeq, endSeq}` | 被压缩的对话退出语义摘要；历史工具与 Token 事件统计保留 |
| 带 `data.inherited: true` 的 `session/end-seed` | 记录继承切点；未带标记的结束标记不建立切点 |
| 未知事件类型 | 拒绝必需事件；明确标为可忽略的扩展保留覆盖诊断 |

## npm 下载量历史

![dsh-session-insights 的累计 npm 下载量增长](https://raw.githubusercontent.com/GreenLv/dsh-session-insights/stats/npm-downloads.zh-CN.svg)

该累计图每天根据 npm Downloads API 自动生成。npm 下载量统计的是 registry 请求次数，不等于独立用户数或已确认的真实安装人数。如果 GitHub 延迟或停用定时任务，也可以手动触发工作流。

## 开发与项目文档

```bash
python3 -m pip install -e '.[dev]'
npm ci --ignore-scripts
npm ci --prefix tests/rc2-runtime --ignore-scripts
DSH_RUNTIME="$PWD/tests/rc2-runtime" python3 -m unittest discover -s tests -v
python3 scripts/build_native_rules.py --check
npm test
python3 scripts/build_fixture.py --check
python3 scripts/audit_public_tree.py --root .
```

- [更新记录](CHANGELOG.zh-CN.md)
- [安全策略](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)
- [分发说明](docs/distribution.md)

测试 fixture 全部为合成数据，并可确定性重建。

## 许可证

[MIT](LICENSE)
