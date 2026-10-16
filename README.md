# 🤖 ReAct Agent

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.10+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)]()

**一个基于 ReAct（Reasoning + Acting）框架的智能 Agent**，采用 OpenAI 协议接入大语言模型，通过 **Function Calling** 实现工具调用，使用 **TypeScript** 开发。

> 🧠 **核心思想**：**Thought → Action → Observation** 循环推理，像人类一样"思考-行动-观察"，逐步解决问题，直到得出最终答案。

[✨ 特性](#-特性)
[🚀 快速开始](#-快速开始)
[📖 CLI 使用](#-cli-使用)
[💻 编程式调用](#-编程式调用)
[🏗️ 架构设计](#️-架构设计)
[🔧 内置工具](#-内置工具)
[🧩 工具扩展](#-工具扩展)
[🎯 Skill 技能包](#-skill-技能包)
[⚙️ 配置管理](#️-配置管理)
[🎧 事件监听器](#-事件监听器)
[💬 多轮对话](#-多轮对话)
[💾 会话持久化](#-会话持久化)
[🧠 记忆管理](#-记忆管理)
[📊 LLM Token 统计](#-llm-token-统计)
[📝 调试日志](#-调试日志)
[📁 项目结构](#-项目结构)
[🛠️ 技术栈](#️-技术栈)
[🚀 SEA 单文件部署](#-sea-单文件部署)
[🔍 故障排查](#-故障排查)

</div>

---

## ✨ 特性

| 特性 | 说明 |
|---|---|
| 🔄 **ReAct 循环** | Thought → Action → Observation 逐步推理，直到得出最终答案 |
| 📡 **流式输出** | LLM 推理过程实时流式输出，支持 `content` 与 `tool_calls` 分片拼接 |
| ⏳ **等待提示** | 模型生成 / 工具执行等耗时阶段显示「思考中…」「执行中：<tool>…」loading 指示器，打印前自动清行不混行；非 TTY（管道/重定向/CI）自动禁用 |
| 📊 **Token 统计** | 每轮输出上下文/输入/输出 token 与缓存命中率，会话结束输出汇总（`showTokenStats` 可关） |
| 🔌 **OpenAI 协议** | 兼容任意 OpenAI 协议服务商（OpenAI、DeepSeek、Moonshot、本地 vLLM 等） |
| 🔀 **多模型接入与切换** | `/model` 登记多个 OpenAI 协议模型到登记簿，`/model use <别名>` 一键热切换（写盘即生效、零重启），支持连通性测试、漂移检测与全局/工作空间分层管理 |
| � **文件上传** | `/upload` 把本地文件复制到会话隔离的上传目录并注入 Agent 上下文：支持拖拽（跨终端格式归一）、无参弹出系统文件选择框（Windows / macOS / Linux），Agent 下一轮即可读取处理 |
| �️ **内置工具** | 命令执行、文件读取（支持行范围、默认带行号）、文件写入、文本编辑（editFile：字面量/正则/行范围）、内容检索（grep）、Skill 激活 |
| 👁️ **视觉理解** | 对接多模态视觉模型（OpenAI 协议 `image_url` 格式）：看图描述 / 定向问答 / 结构化提取 / OCR 四个工具，本地图片自动转 base64，LRU 结果缓存与用量统计，`/vision` 命令管理与连通性测试 |
| 🌐 **MCP 接入** | 支持通过 Model Context Protocol 接入外部工具服务（stdio / SSE / Streamable HTTP） |
| 🧩 **Skill 技能包** | SKILL.md 规范 + 渐进式加载，`activate_skill` 工具按需激活领域指令 |
| 🧠 **三层记忆管理** | L1 Working（token 压缩）/ L2 Episodic（按天日记）/ L3 Curated（常驻注入） |
| 🔧 **分层配置系统** | CLI > 工作空间 > 全局 > .env > 默认值，多层覆盖，来源可追溯 |
| 🧭 **首次启动引导** | 启动时自动检测模型配置与全局/工作空间目录：缺配置进入交互式向导（baseUrl → apiKey 遮蔽输入 → 模型名 → 连通性校验 → 选择写入层级），目录按默认结构补建；`--no-setup` 跳过，REPL 内 `/setup` 重跑、`/doctor` 只读体检 |
| 🎛️ **运行时配置管理** | CLI 内置 `/config`、`/mcp`、`/tools`、`/skill`、`/memory`、`/vision` 命令，支持热修改 |
| ⌨️ **Tab 自动补全** | REPL 输入 `/con` 按 Tab 补全为 `/config`，命令与子命令均可补全，多候选自动列出 |
| 💾 **会话持久化** | 对话历史 AES-256-GCM 加密存储，跨进程自动保存 / 手动恢复 |
| 📝 **调试日志** | 文件日志记录 LLM 请求/响应、工具调用、Agent 迭代，自动轮转 |
| 🎯 **事件监听** | 参考 LangChain callbacks 设计，15 个生命周期钩子便于扩展 |
| 💬 **多轮对话** | 跨 `run()` 调用持久化消息历史，支持上下文续接 |
| ⚡ **同轮多工具** | 支持 LLM 单轮返回多个 `tool_calls`，`Promise.all` 并发执行 |
| 🛡️ **失败隔离** | 单个工具失败不影响其他工具，工具不存在时返回错误 Observation 让 Agent 继续推理 |
| 🔁 **自动重试** | LLM 调用对网络错误与 429 速率限制自动重试（指数退避） |
| 🗣️ **错误友好** | 401/403/404 等错误抛出明确中文提示，便于快速定位问题 |

---

## 🚀 快速开始

### 1. 安装

```bash
# 克隆仓库
git clone <repo-url> loop-agent-command
cd loop-agent-command

# 安装依赖
npm install
```

### 2. 配置

**方式一：初始化向导（推荐，零手工配置）**——跳过本步直接运行 `npm start`。首次启动时若未检测到可用的模型配置（apiKey / 模型名），会自动进入引导：

1. 逐项询问模型服务地址（baseUrl）、API Key（输入回显以 `*` 遮蔽）、模型名称；
2. 自动做一次连通性校验，失败可重试 / 重新输入 / 仍保存（摘要标注 ⚠ 未验证）；
3. 选择写入全局（`~/.loop-agent/config.json`）或当前工作空间（`.loop-agent/.agent-config.json`），目标文件存在但损坏时写盘前自动备份为 `.bak-<时间戳>`；
4. 两级 skills 等目录按默认结构自动补建，完成后直接进入对话界面。

之后可在 REPL 中随时用 `/setup` 重跑向导（`--global` / `--workspace` 指定写入层级）、用 `/doctor` 做只读体检。

**方式二：.env 手工配置**——复制 `.env.example` 为 `.env` 并填入配置：

```bash
cp .env.example .env
```

```env
# OpenAI API Key（必填）
OPENAI_API_KEY=sk-xxx

# OpenAI 协议 Base URL（可选，默认 https://api.openai.com/v1）
# 可切换为 DeepSeek: https://api.deepseek.com/v1
# 可切换为 Moonshot: https://api.moonshot.cn/v1
OPENAI_BASE_URL=https://api.openai.com/v1

# 模型名称（可选，默认 gpt-4o-mini）
MODEL_NAME=gpt-4o-mini

# Agent 最大迭代次数（可选，默认 10）
MAX_ITERATIONS=10

# 调试日志（可选，默认关闭，开启后输出到 ~/.loop-agent/logs）
DEBUG=true
```

### 3. 运行

```bash
# 🎮 CLI 交互模式（首次启动缺配置时自动进入初始化向导）
npm start

# ⏭️ 跳过初始化检测与引导
npm start -- --no-setup

# 📝 编程式调用示例
npx tsx examples/run.ts

# 🧪 测试（集成 7 例 + 记忆/会话/统计等单测，串行执行避免 API 限速）
npm test

# ✅ 类型检查
npm run typecheck

# 📦 构建（输出到 dist/）
npm run build

# 🚀 构建 SEA 单可执行文件（输出到 dist-sea/，详见下方章节）
npm run build:sea
```

---

## 📖 CLI 使用

```bash
npm start
```

启动后进入交互式 REPL 控制台：

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃            ReAct Agent 交互式控制台                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

模型: gpt-4o-mini (workspace)
BaseURL: https://api.openai.com/v1 (env)
最大迭代: 10
内置工具: [commandRun, fileRead, fileWrite, editFile, grep, activate_skill]
MCP 工具: 3 个, Servers: atlasGraphMcp (atlasGraphMcp__toolName)
Skills: 2 个 (example-skill, py-pptx)
⚠ 调试模式已开启，日志输出到: ~/.loop-agent/logs

Agent> 帮我读取 package.json 的版本号
```

> 若配置中开启了 `agent.debug`，启动时会额外提示调试日志输出目录（见 [📝 调试日志](#-调试日志)）。

> 运行期间，在模型生成（尤其工具调用参数）与工具执行等耗时阶段会显示 loading 指示器（如「思考中…（第 N 轮）」「生成参数：fileWrite…（12.3KB / 8s）」「执行中：grep…」），让等待过程有实时反馈；日志/流式 Thought/最终答案打印前会先清除指示器行，二者不会混行。该指示器仅在交互式 TTY 下启用，管道、重定向与 CI 环境下自动关闭、零输出。

### 内置命令

| 命令 | 说明 |
|---|---|
| `输入问题` | Agent 流式输出 Thought / Action / Observation / Final |
| `/help` | 查看全局帮助信息；任意命令后加 `help`（如 `/mcp help`）查看其子命令用法 |
| `/reset` `/clear` | 清空多轮对话历史，开始新会话 |
| `/status` | 查看当前会话状态（消息数 / 工具数 / MCP 工具数 / Skills） |
| `/tools` | 工具管理（list / enable / disable / reload） |
| `/config` | 配置管理（get / set / delete / list / path） |
| `/mcp` | MCP 管理（list / add / remove / reload / test / view） |
| `/session` | 会话管理（list / load / save / new / current / delete / delete-all） |
| `/skill` | Skill 管理（list / reload / show / upload / remove） |
| `/memory` | 记忆管理（status / curated / episodic / search / dream / gate / init） |
| `/vision` | 视觉模型管理（status / test） |
| `/model` | 多模型管理（list / use / add / remove / test） |
| `/upload` | 文件上传（复制到会话隔离上传目录并注入 Agent 上下文；list / clean） |
| `/setup` | 重跑初始化配置向导（--global / --workspace 指定写入层级） |
| `/doctor` | 启动体检：逐项检测模型配置 / 配置文件 / skills 目录（只读） |
| `exit` / `quit` / `退出` | 退出程序（Ctrl+C 同样有效） |

> **Tab 自动补全**：在提示符下按 `Tab` 可逐级补全——
> - **命令**：输入 `/con` 再按 `Tab` 自动补全为 `/config`；
> - **子命令**：输入 `/config ` 再按 `Tab` 列出并补全子命令（`list/get/set/delete/path`）；
> - **动态参数**：`/session load ` 补真实会话 id、`/tools enable ` 补内置工具名、`/skill show / remove ` 补技能名、`/mcp test / view ` 补 server 名、`/model use / remove / test ` 补已登记模型别名、`/upload ` 补 `list / clean` 子命令；
> - **单词命令**：`hel` → `help`、`ex` → `exit`。
>
> 多候选时按 `Tab` 会补全公共前缀并列出全部候选；普通提问（非 `/` 开头、含空格或中文）按 `Tab` 无任何副作用。
>
> **子命令帮助**：任意命令后加 `help`（或简写 `-h` / `--help`）即可查看该命令的子命令用法，如 `/mcp help`、`/skill help`、`/config help`——无需记忆全局 `/help`。

### 输出示例

```
━━━ 迭代 1/10 ━━━

[Thought] 我需要读取 package.json 文件来获取版本号...

[Action] fileRead({"path":"package.json"})
[Observation]
  1: {
  2:   "name": "loop-agent-command",
  3:   "version": "0.1.0",
  4:   ...
  5: }

━━━ Final Answer ━━━
项目名称为 loop-agent-command，版本号为 0.1.0。

━━━ 完成（1 轮，1 步） ━━━
```

### CLI 命令详解

#### `/config` — 配置管理

支持对工作空间（默认）和全局两个层级的配置进行读写：

```
/config list                    # 查看当前生效配置（含每一字段的来源标记）
/config get <key>               # 查看某个配置项（如 model.name）
/config set <key> <value>       # 设置配置项（默认写入工作空间）
/config set <key> <value> --global  # 写入全局配置
/config delete <key>            # 删除某配置项
/config path                    # 查看配置文件路径
```

配置值支持自动识别类型：`true`/`false` 为布尔值，数字自动转为 Number，`{...}` 或 `[...]` 自动解析为 JSON。

#### `/mcp` — MCP 管理

```
/mcp list                       # 列出所有 MCP Server 配置及连接状态
/mcp add <name>                 # 交互式添加新 MCP Server
/mcp remove <name>              # 移除指定 MCP Server
/mcp reload                     # 重新加载全部 MCP 配置
/mcp test <name>                # 测试连接指定 MCP Server
/mcp view <name>                # 查看指定 MCP Server 的服务信息与工具清单
/mcp help                       # 查看 /mcp 的子命令用法
```

> `/mcp view <name>` 展示服务名称、传输配置、连接状态与该服务下的工具清单（工具名 + 描述）：已连接的 Server 直接读取已注册工具（零开销），未连接的会临时连接查询后自动断开（与 `/mcp test` 同款模式），无需先 `/mcp reload`。

#### `/tools` — 工具管理

```
/tools list                     # 列出所有已注册工具（内置 + MCP）
/tools enable <name>            # 启用内置工具
/tools disable <name>           # 禁用内置工具
/tools reload                   # 重新加载所有工具
```

#### `/session` — 会话管理

```
/session list                   # 列出当前工作空间所有会话（ID / 标题 / 消息数 / 时间）
/session current                # 查看当前会话详情
/session load <id>              # 加载指定会话，恢复历史对话
/session save                   # 手动保存当前会话
/session new                    # 新建会话（旧会话自动保存）
/session delete <id>            # 删除指定会话
/session delete-all             # 删除当前工作空间的所有会话（需二次确认）
```

会话列表输出示例：

```
当前工作空间会话 (2 个):
  sess_20260806_143022 [当前] 2026/08/06 14:30:22 [5条] 帮我读取 package.json 的版本号
  sess_20260805_210011        2026/08/05 21:00:11 [3条] 搜索 src 目录中的 config
```

会话数据以 AES-256-GCM 加密存储在 `~/.loop-agent/sessions/` 目录（按工作空间隔离），详见 [💾 会话持久化](#-会话持久化)。

#### `/skill` — Skill 管理

```
/skill list                     # 列出所有可用 Skill（全局 + 工作空间，含来源标记）
/skill reload                   # 重新扫描 Skill 目录
/skill show <name>              # 显示指定 Skill 的 SKILL.md 完整内容
/skill upload <目录...>         # 安装本地 Skill 目录（默认工作空间；--global 装到全局；同名冲突询问覆盖）
/skill upload                   # 无参：弹出系统目录选择框（Windows/macOS/Linux 探测可用工具）
/skill remove <name...>         # 删除已安装 Skill（默认工作空间优先；--global/--workspace 严格限定；逐个 y/N 确认）
```

Skill 从全局 `~/.loop-agent/skills/` 与工作空间 `<cwd>/.loop-agent/skills/` 两个目录自动扫描，同名时工作空间优先。详见 [🎯 Skill 技能包](#-skill-技能包)。

`/skill upload` 支持拖拽目录到终端（引号 / `file://` URI 自动归一）与多目录批量安装；安装前校验目标含合法 `SKILL.md`（name/description），单项失败不阻断其余，安装完成后自动重新扫描立即可用。

`/skill remove` 按 frontmatter `name` 定位并删除整个 Skill 目录：同名两处时默认删工作空间（`--global` / `--workspace` 可严格限定单一作用域），删除前逐个确认（默认 N），内置路径护栏（目标必须是 skills 根的直接子目录，防路径穿越），删除后自动重新扫描，`/skill list` 立即不可见；支持批量删除，单项失败不阻断其余。

#### `/memory` — 记忆管理

```
/memory status                          # 查看记忆系统状态（L1/L2/L3 各层统计）
/memory curated list                    # 列出 L3 核心记忆文件（SOUL / USER / MEMORY）
/memory curated read <soul|user|memory> # 读取指定核心记忆文件内容
/memory curated append <key> <内容>      # 向核心记忆文件追加一条事实
/memory episodic list                   # 列出 L2 情景记忆日志（按天）
/memory episodic read <YYYY-MM-DD>      # 读取指定日期的情景记忆
/memory search <关键词>                  # 搜索 L2 情景记忆（返回相关片段）
/memory dream [天数]                    # 手动触发 Dreaming 巡检（晋升 L2 → L3）
/memory gate                            # 查看 Promotion Gate 待确认/待晋升事实
/memory init                            # 初始化 L3 核心记忆文件
```

详见 [🧠 记忆管理](#-记忆管理)。

#### `/vision` — 视觉模型管理

```
/vision status                  # 查看视觉模型配置（启用状态 / 三元组来源标记 / apiKey 掩码 / 缓存状态 / 会话累计统计）
/vision test                    # 用 1x1 PNG 做连通性测试（校验 baseUrl / apiKey / model 是否可用）
```

视觉三元组（`vision.baseUrl` / `vision.apiKey` / `vision.model`）为空时自动回退主模型 `model.*`，同一服务商多模型零重复配置。启用方式：

```
/config set vision.enabled true    # 立即生效：自动注册视觉工具（设为 false / delete 时自动注销），无需 /tools reload
/config set vision.model gpt-4o    # 不设置则回退主模型 model.name
```

启用后注册四个视觉工具：`describe_image`（整体描述）、`ask_image`（定向问答）、`extract_json`（结构化提取）、`ocr_image`（文字识别），见 [🔧 内置工具](#-内置工具)。

#### `/model` — 多模型接入与切换

把多个 OpenAI 协议模型登记到登记簿（`models.profiles`，以别名为键），用别名一键切换当前生效模型（`model.*` 快照），写盘即生效、无需重启：

```
/model list                  # 列出登记簿与当前生效快照（含 apiKey 掩码与漂移检测提示）
/model use <别名>            # 切换到已登记模型（同步激活指针与生效快照，立即生效）
/model use <别名> --global   # 切换全局层；与工作空间层冲突时可交互确认并自动清理冲突键
/model add <别名>            # 登记新模型（交互选择写入位置，回车默认工作空间）
/model add <别名> --global   # 登记到全局层（flag 显式指定时跳过位置询问）
/model remove <别名>         # 从登记簿移除（不影响当前生效快照）
/model test <别名>           # 对已登记模型做连通性测试（不改变激活状态）
```

设计要点：

- **登记簿 + 激活指针**：`models.profiles` 只做登记，`models.active` 指向当前激活别名；`/model use` 会同时写入激活指针与 `model.*` 生效快照——运行时只读 `model.*` 一处，主模型、视觉回退三元组、记忆系统（Dreaming / 压缩）全部跟随新模型。
- **跨层叠加**：登记簿按「全局 → 工作空间」逐层深合并（同名别名工作空间叶子覆盖全局），`temperature` 未登记的模型切换时不覆盖现有采样温度。
- **漂移检测**：`/model list` 与启动 Banner 会比对激活别名与生效快照（只比 name + baseUrl，apiKey 轮换不算漂移），不一致时提示执行 `/model use <别名>` 重新同步。
- **向导联动**：首次启动向导写入模型时，若登记簿为空会自动登记为 `default` 别名，之后接入第二个模型即可随时 `/model use default` 回切。

配置示例（工作空间 `.loop-agent/.agent-config.json`）：

```json
{
  "models": {
    "active": "deepseek",
    "profiles": {
      "deepseek": {
        "name": "deepseek-chat",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-yyy"
      },
      "glm": {
        "name": "glm-4.7",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": "sk-zzz"
      }
    }
  }
}
```

#### `/upload` — 文件上传（会话隔离上传目录）

把本地文件复制到 Agent 的全局上传目录（`~/.loop-agent/uploads/{会话ID}/`），并把上传路径注入当前会话上下文——Agent 在后续对话中自动"知道"文件，可直接用 `fileRead` / `commandRun` / 视觉工具处理，无需口头转述路径：

```
/upload <路径...>         # 上传一个或多个文件（可拖拽到终端，自动解析带引号路径）
/upload                   # 无参：弹出系统文件选择框（多选；Windows/macOS/Linux 探测可用工具）
/upload list              # 列出当前会话已上传文件
/upload clean             # 清理当前会话的上传目录（y/n 确认）
```

设计要点：

- **会话隔离**：物理目录按会话分隔（`uploads/{sessionId}/`），`/session delete` / `delete-all` 连带清理；跨会话互不可见，且不污染工作空间 git 工作区
- **Agent 感知**：上传成功后注入 `[文件上传]` 上下文消息（路径 + 大小），随 autoSave 持久化、`/session load` 恢复后依然有效；不自动触发回答，上传是准备动作
- **跨平台归一**：终端拖拽格式各异（Windows 引号路径 / Linux GNOME `file://` URI / Konsole 转义空格），统一解析为本地路径；无参弹框按平台探测 `PowerShell + WinForms` / `osascript` / `zenity → kdialog → yad`，全部不可用时优雅降级为拖拽/路径参数
- **防覆盖与上限**：文件名加时间戳前缀防重名；单文件上限 100MB；目录不支持直接上传（提示压缩后上传）
- **零依赖**：仅 `node:fs` / `node:child_process`，无 npm 新增依赖

#### `/setup` — 重跑初始化向导

在 REPL 内重新运行首次启动的配置向导，流程一致：baseUrl → apiKey（遮蔽输入）→ 模型名 → 连通性校验 → 选择写入层级。完成后立即重新加载配置并刷新工具注册，后续对话即时生效，无需重启：

```
/setup                     # 未指定层级时沿用向导默认建议
/setup --global            # 写入全局配置 ~/.loop-agent/config.json
/setup --workspace         # 写入工作空间配置 .loop-agent/.agent-config.json
```

写入前若目标文件存在但内容损坏（非法 JSON），会自动备份为 `.bak-<时间戳>`。

#### `/doctor` — 启动体检

只读检查当前环境是否具备正常对话条件，逐项输出三态报告（✓ 正常 / ✗ 阻断 / ! 警告），不修改任何文件：

```
/doctor
启动体检报告

  ✓ 主模型 apiKey
  ✓ 主模型名称
  ✗ 全局配置文件：<原因>（首次写入配置时自动创建）
  ! 全局 skills 目录：<原因> → ~/.loop-agent/skills
  ……

  ✓ 阻断项 0 个，主模型配置齐备，可正常对话
  本命令只读，不修改任何文件
```

共 6 个检测项：主模型 apiKey、主模型名称、全局配置文件、工作空间配置文件、全局 skills 目录、工作空间 skills 目录；✗ 项附带修复提示（如「运行 /setup 重新配置」）。

---

## 💻 编程式调用

### 基础单轮调用

```typescript
import { agent } from './src/agent/react-agent.js';
import { registerBuiltinTools } from './src/tools/index.js';

// 注册内置工具（每个进程只需调用一次）
registerBuiltinTools();

// 单次调用
const result = await agent.run('帮我读取 package.json 的版本号', {
  verbose: true,       // 输出 Thought/Action/Observation 日志
  resetHistory: true,  // 清空历史，开始新会话
});

console.log(result.answer);
console.log(`迭代: ${result.iterations}, 步骤: ${result.steps.length}`);
```

### 多轮对话

```typescript
// 第一轮：读取 package.json
const r1 = await agent.run('package.json 里项目叫什么名字？', {
  resetHistory: true,
  verbose: false,
});
console.log(r1.answer);

// 第二轮 —— 自动复用历史上下文，无需显式传 messages
const r2 = await agent.run('那它的版本号是多少？');
// Agent 已经知道 package.json 的内容，可以直接回答，无需再次调用工具
console.log(r2.answer);
```

### 会话持久化

```typescript
import { agent } from './src/agent/react-agent.js';
import { SessionStore } from './src/session/index.js';
import { registerBuiltinTools } from './src/tools/index.js';

registerBuiltinTools();

// 初始化会话存储（按当前工作空间路径隔离）
const sessionStore = new SessionStore(process.cwd());
await sessionStore.init();
agent.setSessionStore(sessionStore);

// run() 结束后若配置 session.autoSave=true，会自动创建/更新会话
const result = await agent.run('帮我读取 package.json', {
  resetHistory: true,
  verbose: true,
});
console.log(`会话 ID: ${agent.currentSessionId}`);
```

### 自定义事件监听

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// 自定义监听器
const myListener: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[🔧 工具开始] ${tool}`, args);
  },
  onToolEnd: (tool, result) => {
    console.log(`[✅ 工具完成] ${tool} → ${result.slice(0, 100)}...`);
  },
  onFinal: (answer) => {
    console.log(`[🎯 最终答案] ${answer}`);
  },
};

const result = await agent.run('搜索 src 目录中的 config', {
  verbose: false,
  events: [myListener],
});
```

---

## 🏗️ 架构设计

```
┌──────────────────────────────────────────────────────────────┐
│                         CLI / API                            │
│                     (src/index.ts)                           │
├──────────────────────────────────────────────────────────────┤
│                      ReAct Agent                             │
│                    (react-agent.ts)                          │
│   ┌──────────────┐  ┌───────────────┐  ┌────────────────┐  │
│   │ System Prompt │  │  Event 系统   │  │  ChatHistory   │  │
│   │  (prompt.ts)  │  │  (logger.ts) │  │  (多轮持久化)  │  │
│   └──────────────┘  └───────────────┘  └────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                     LLM Client                               │
│                   (llm/client.ts)                            │
│          chat() / chatStream() + 自动重试（指数退避）       │
├──────────────────────────────────────────────────────────────┤
│                     Tool System                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Registry    │  │   Runner     │  │  MCP Adapter     │  │
│  │  (注册/查询) │  │  (执行/超时) │  │  (外部工具适配)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  Configuration System                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  ConfigLoader│  │  ConfigWriter│  │  MCPManager      │  │
│  │  (分层加载)  │  │  (持久化写入)│  │  (生命周期管理)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                     Skill System                            │
│    scanner (扫描) │ loader (加载) │ activate_skill 工具     │
├──────────────────────────────────────────────────────────────┤
│                     Memory System                           │
│    Working(L1) │ Episodic(L2) │ Curated(L3) │ Callback     │
├──────────────────────────────────────────────────────────────┤
│                   Session System                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ SessionStore │  │   Keychain   │  │  Crypto (AES-GCM)│  │
│  │ (会话读写)   │  │ (密钥管理)   │  │  (加密/解密)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                   Built-in Tools                             │
│ commandRun │ fileRead │ fileWrite │ grep │ activateSkill    │
└──────────────────────────────────────────────────────────────┘
```

### ReAct 循环流程

```
  ┌─────────────────────────────────────────────────────┐
  │  1. 构造 messages（system + user，或复用历史）       │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │  2. 流式调用 LLM（chatStream）                       │
  │     实时通过 events.onLLMStream 输出 Thought         │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │  3. 流结束后得到完整 LLMResponse                     │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  4. 检查 tool_calls        │
          │                            │
          │   ┌─── 无 tool_calls ──┐   │
          │   │ 返回 content 作为  │   │
          │   │   Final Answer     │   │
          │   └────────────────────┘   │
          │                            │
          │   ┌─── 有 tool_calls ──┐   │
          │   │ 并发执行所有工具   │   │
          │   │ 拼接 Observation   │   │
          │   │ 回 messages        │   │
          │   └────────┬───────────┘   │
          └────────────┼───────────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  5. 回到步骤 2，继续迭代   │
          └────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │  6. 达到最大迭代次数    │
          │  → 抛出错误，优雅退出   │
          └─────────────────────────┘
```

> `run()` 结束后，若启用了会话存储（`session.autoSave=true`），当前 messages 与 steps 会自动加密保存到磁盘。

### 配置分层加载

```
加载优先级（高 → 低）：
  CLI 参数 > 工作空间配置 (.loop-agent/.agent-config.json)
           > 全局配置 (~/.loop-agent/config.json)
           > 环境变量 (.env)
           > 默认值 (DEFAULT_CONFIG)
```

---

## 🔧 内置工具

| 工具 | 名称 | 说明 | 参数 |
|---|---|---|---|
| 🖥️ **命令执行** | `commandRun` | 在本地执行 shell 命令，返回 stdout + stderr | `command`（必填）, `cwd`（可选）, `timeout`（可选，默认 30000ms） |
| 📄 **文件读取** | `fileRead` | 读取文件内容，支持按行范围部分读取，默认每行带 `行号: ` 前缀 | `path`（必填）, `startLine`（可选）, `endLine`（可选）, `encoding`（可选）, `lineNumbers`（可选，默认 `true`） |
| ✏️ **文件写入** | `fileWrite` | **整文件写入**：`overwrite` 用 `content` 完整替换文件全部内容（**原内容会永久丢失，不支持区域/局部覆盖**，局部修改请用 `editFile`）；`append` 追加到末尾，自动创建父目录 | `path`（必填）, `content`（必填，overwrite 时为覆盖后的完整文件内容）, `mode`（可选，`overwrite` / `append`） |
| 🔁 **文件编辑** | `editFile` | 三种模式：①字面量替换（要求唯一出现，多处匹配报错以防误改）；②`regex=true` 正则替换（支持 `$1`/`$&` 捕获引用）；③指定 `startLine`/`endLine` 整段行替换 | `path`（必填）, `newText`（必填）, `oldText`（未指定行范围时必填）, `startLine`（可选）, `endLine`（可选）, `replaceAll`（可选，默认 `false`）, `regex`（可选，默认 `false`）, `flags`（可选，如 `i`/`m`/`s`） |
| 🔍 **内容检索** | `grep` | 在文件或目录中检索内容，支持正则、忽略大小写、递归搜索 | `pattern`（必填）, `path`（必填）, `ignoreCase`（可选）, `recursive`（可选）, `maxResults`（可选，默认 50） |
| 🎯 **Skill 激活** | `activate_skill` | 激活指定 Skill（技能包），返回 SKILL.md 完整指令**及技能所在目录（技能目录 / SKILL.md 绝对路径）**，便于定位技能内附带的脚本、参考文档等文件 | `name`（必填） |
| 👁️ **图片描述** | `describe_image` | 对图片做整体描述（主体、场景、可见文字、颜色、数量等）；不确定该问什么时先用它获取全局信息 | `image`（必填，本地路径或 http(s) URL） |
| ❓ **图片问答** | `ask_image` | 针对图片回答一个具体问题（界面文字、错误码、按钮状态、颜色、数量等），比 `describe_image` 更精准、输出更短 | `image`（必填）, `question`（必填） |
| 🧾 **结构化提取** | `extract_json` | 按字段列表从图片提取结构化数据并返回 JSON（表单 / 表格 / 配置界面等场景）；解析失败自动降级返回原始文本 | `image`（必填）, `fields`（必填，字段名数组） |
| 📝 **文字识别** | `ocr_image` | 识别图片中全部文字（OCR），保持原始阅读顺序与换行输出 | `image`（必填） |

### 工具使用示例

```bash
# 命令执行
commandRun({ "command": "dir", "cwd": "." })

# 文件读取（全文，默认带行号）
fileRead({ "path": "package.json" })

# 文件读取（部分行，行号为文件真实行号）
fileRead({ "path": "src/agent/react-agent.ts", "startLine": 1, "endLine": 20 })

# 文件读取（关闭行号，返回原始内容，适合读-改-写）
fileRead({ "path": "src/agent/react-agent.ts", "lineNumbers": false })

# 文件写入（overwrite 为整文件覆盖：content 即覆盖后的完整文件内容，原内容会丢失）
fileWrite({ "path": "output.txt", "content": "Hello World", "mode": "overwrite" })

# 文件写入（append 追加到末尾，保留原内容）
fileWrite({ "path": "output.txt", "content": "\nMore text", "mode": "append" })

# 局部修改已有文件（不要用 fileWrite overwrite，会丢内容）→ 用 editFile
editFile({ "path": "output.txt", "oldText": "Hello World", "newText": "Hello TRAE" })

# 文本替换（字面量匹配；多处匹配时需显式加 replaceAll）
editFile({ "path": "src/config/schema.ts", "oldText": "gpt-4o-mini", "newText": "deepseek-chat" })

# 正则替换（regex=true，支持 flags 与 $1 捕获引用）
editFile({ "path": "src/version.ts", "oldText": "v\\d+\\.\\d+\\.\\d+", "newText": "v2.0.0", "regex": true })

# 行范围整段替换（把第 10-12 行整体替换为 newText；newText 为空串表示删除这些行）
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "newText": "// TODO" })

# 行范围替换 + oldText 校验（可选，用于防止行号偏移改错位置）
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "oldText": "function legacy() {", "newText": "function modern() {" })

# 内容检索
grep({ "pattern": "config", "path": "src", "ignoreCase": true, "maxResults": 20 })

# Skill 激活（渐进式加载，返回 SKILL.md 完整内容 + 技能目录 / SKILL.md 绝对路径）
activate_skill({ "name": "example-skill" })

# 图片描述（本地路径自动转 base64 data URL，需 vision.enabled = true）
describe_image({ "image": "screenshots/login.png" })

# 图片问答（支持本地路径或 http(s) URL）
ask_image({ "image": "https://example.com/chart.png", "question": "这张图里最高的柱子对应哪个月份？" })

# 结构化提取（返回 JSON 字符串，解析失败自动降级返回原始文本）
extract_json({ "image": "invoice.png", "fields": ["标题", "金额", "日期"] })

# 文字识别（OCR，保持原始阅读顺序与换行）
ocr_image({ "image": "receipt.jpg" })
```

---

## 🧩 工具扩展

### 新增自定义工具

```typescript
import type { Tool } from './src/types.js';
import { registry } from './src/tools/registry.js';

const myTool: Tool = {
  name: 'myTool',
  description: '我的自定义工具',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '输入内容' },
    },
    required: ['input'],
  },
  async execute(args) {
    const input = String(args.input);
    return `处理结果: ${input}`;
  },
};

// 注册到全局注册表
registry.register(myTool);
```

### 接入 MCP 外部工具

MCP（Model Context Protocol）是一种标准化的工具接入协议，支持 stdio、SSE（已废弃）与 Streamable HTTP 三种传输方式；远程 MCP Server 推荐使用 Streamable HTTP。

#### 方式一：配置文件（推荐）

创建 `.mcp.json` 或通过 CLI 的 `/mcp add` 命令交互式添加：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "fetch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "remote": {
      "type": "streamableHttp",
      "url": "https://host/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

项目启动时会自动加载配置并注册所有 MCP server 的工具。工具名规则：`{serverName}__{toolName}`（如 `filesystem__read_file`）。

#### 方式二：CLI 交互式添加

启动后输入 `mcp add my-server`，按提示输入传输类型、命令/URL 等，自动测试连接后写入配置。传输类型可选 `stdio` / `sse` / `http`（即 Streamable HTTP）；选择 `http` 时可再填一行可选认证头（如 `Authorization: Bearer xxx`）。

#### 方式三：编程式接入

```typescript
import { registry } from './src/tools/registry.js';

await registry.registerMCPServer('filesystem', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
});

// 注册成功后，可通过 registry.list() 查看所有工具
// MCP 工具名示例：filesystem__read_file, filesystem__write_file
```

#### 方式四：Streamable HTTP 接入（远程服务推荐）

```typescript
await registry.registerMCPServer('my-server', {
  type: 'streamableHttp',
  url: 'https://host/mcp',
  // 可选：自定义请求头（Bearer Token / API Key 等）
  headers: { Authorization: 'Bearer <token>' },
});
```

> - `type` 亦可写生态别名 `http` / `streamable-http`（大小写不敏感），三者等价。
> - Streamable HTTP 自 MCP 规范 2025-03-26 版起取代 HTTP+SSE，2026-07-28 版规范已将 HTTP+SSE 标记为 Deprecated。

#### 方式五：SSE 接入（已废弃，仅兼容存量服务）

```typescript
await registry.registerMCPServer('my-server', {
  type: 'sse',
  url: 'http://localhost:3000/sse',
});
```

> **注意**：单个 MCP server 连接失败不影响其他 server 或内置工具（失败隔离）。

---

## 🎯 Skill 技能包

Skill（技能包）是一组针对特定领域任务的**可复用指令集**，采用 `SKILL.md` 标准格式（YAML frontmatter + Markdown 正文）。Agent 根据用户意图**渐进式加载** Skill 的完整指令，用于处理复杂领域任务。

### Skill 目录结构

```
~/.loop-agent/skills/           # 全局 Skill（所有项目可用）
└── example-skill/
    └── SKILL.md

<workspace>/.loop-agent/skills/   # 工作空间 Skill（仅当前项目可用，优先级更高）
└── my-skill/
    ├── SKILL.md
    ├── scripts/                # 可选：可执行脚本
    ├── references/             # 可选：参考文档
    └── assets/                 # 可选：模板/资源
```

### SKILL.md 格式规范

```markdown
---
name: example-skill
description: 示例技能包，演示 Skill 的创建和使用方式
---

# Example Skill

## When to use this skill
...

## How to ...
1. ...
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | Skill 唯一标识，用于 LLM 匹配与 `activate_skill` 调用 |
| `description` | ✅ | 简短描述，LLM 据此判断何时使用该 Skill |

> **优先级**：同名 Skill 同时存在时，工作空间版本覆盖全局版本。

### 工作流程

1. **启动时**：自动扫描全局 + 工作空间 Skill，元信息（name + description）注入 System Prompt；**若没有任何技能，System Prompt 也会显式声明"当前没有可用的技能"，避免模型误去检索文件系统**
2. **运行时**：LLM 判断用户意图匹配某个 Skill → 调用 `activate_skill` 工具
3. **加载后**：工具返回 SKILL.md 完整内容**及技能所在目录**，Agent 据此继续推理执行；若技能引用了内部脚本/文档，可用该目录拼接路径后再读取
4. **手动管理**：可通过 `/skill` 命令查看、刷新

### 编程式激活

```typescript
import { skillLoader } from './src/skill/index.js';

// 扫描（全局 + 工作空间）
const skills = skillLoader.scan(process.cwd());

// 渐进式加载完整内容
const content = skillLoader.load('example-skill');
console.log(content?.fullContent);
```

---

## ⚙️ 配置管理

支持多层配置系统，优先级从高到低为：**CLI 参数 > 工作空间配置 > 全局配置 > 环境变量 > 默认值**。

### 配置层级

| 层级 | 文件位置 | 说明 |
|---|---|---|
| CLI 参数 | 运行时传入 | 最高优先级，仅内存中生效 |
| 工作空间 (workspace) | `{项目目录}/.loop-agent/.agent-config.json` | 项目级配置（.loop-agent/ 整体不进入版本控制） |
| 全局 (global) | `~/.loop-agent/config.json` | 用户级配置，跨项目共享 |
| 环境变量 (env) | `.env` 或 `process.env` | 向后兼容，支持原有环境变量 |
| 默认值 (default) | `DEFAULT_CONFIG` | 代码内置的默认值 |

### 配置结构

```json
{
  "model": {
    "name": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "temperature": 0,
    "maxIterations": 10
  },
  "models": {
    "active": "",
    "profiles": {
      "deepseek": {
        "name": "deepseek-chat",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-yyy"
      }
    }
  },
  "tools": {
    "enabled": ["commandRun", "fileRead", "fileWrite", "editFile", "grep", "activate_skill"],
    "disabled": [],
    "mcpServers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      }
    }
  },
  "agent": {
    "verbose": true,
    "debug": false,
    "systemPrompt": null,
    "showTokenStats": true
  },
  "session": {
    "autoSave": true,
    "autoRestore": true,
    "encryptionEnabled": true
  },
  "skill": {
    "enabled": true,
    "globalDir": "~/.loop-agent/skills",
    "workspaceDir": "skills",
    "autoLoad": true
  },
  "memory": {
    "enabled": true,
    "working": {
      "maxTokens": 102400,
      "compactionThreshold": 0.8,
      "keepRecentTurns": 3
    },
    "episodic": {
      "dir": "memory",
      "searchTopK": 3,
      "searchTimeoutMs": 500,
      "vectorSearch": {
        "enabled": false,
        "provider": "openai-compatible",
        "model": "",
        "dimension": 1024,
        "endpoint": "",
        "apiKey": "",
        "timeoutMs": 10000,
        "batchSize": 16
      }
    },
    "curated": {
      "files": ["SOUL.md", "USER.md", "MEMORY.md"]
    },
    "dreaming": {
      "enabled": true,
      "daysBack": 3,
      "onExit": true
    }
  },
  "vision": {
    "enabled": false,
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    "temperature": 0,
    "maxTokens": 2048,
    "timeoutMs": 60000,
    "maxImageBytes": 10485760,
    "maxResultChars": 8000,
    "cacheEnabled": true,
    "cacheTtlMs": 600000
  }
}
```

| 配置段 | 字段 | 说明 | 默认值 |
|---|---|---|---|
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` / `maxIterations` | LLM 模型配置（当前生效快照，运行时唯一读取点） | `gpt-4o-mini` 等 |
| `models` | `active` / `profiles` | 多模型登记簿（Task-20261011-002）：`profiles` 以别名为键登记各模型三元组（`name` / `baseUrl` / `apiKey`，可选 `temperature`），`active` 指向当前激活别名（空串 = 未纳入多模型管理）；`/model use <别名>` 会同步更新 `active` 与 `model.*` 快照 | `active: ""`、`profiles: {}` |
| `tools` | `enabled` / `disabled` / `mcpServers` | 内置工具开关与 MCP server 配置 | 全部启用 |
| `agent` | `verbose` | 是否输出 Thought/Action/Observation 控制台日志 | `true` |
| `agent` | `debug` | 是否开启文件调试日志（见 📝 调试日志） | `false` |
| `agent` | `systemPrompt` | 自定义 system prompt 覆盖 | `null` |
| `agent` | `showTokenStats` | 是否输出每轮/会话汇总 token 统计（Task-15） | `true` |
| `agent` | `loading` | 是否显示等待 loading 指示器（非 TTY 环境始终禁用，Task-20260930-001） | `true` |
| `session` | `autoSave` | `run()` 结束后自动保存会话到磁盘 | `true` |
| `session` | `autoRestore` | 启动时自动恢复最近会话 | `true` |
| `session` | `encryptionEnabled` | 会话文件是否加密存储（AES-256-GCM） | `true` |
| `skill` | `enabled` / `globalDir` / `workspaceDir` / `autoLoad` | Skill 技能包开关与扫描目录 | 全部启用 |
| `memory` | `enabled` / `working` / `episodic` / `curated` / `dreaming` / `vectorSearch` | 三层记忆系统配置（含检索增强） | 全部启用 |
| `vision` | `enabled` / `baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens` / `timeoutMs` / `maxImageBytes` / `maxResultChars` / `cacheEnabled` / `cacheTtlMs` | 视觉模型配置（Task-20261010-001）；`baseUrl` / `apiKey` / `model` 为空时回退主模型 `model.*` 三元组 | `enabled: false`，其余见上方配置结构 |

### 环境变量（向后兼容）

| 环境变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | API Key | 无 |
| `OPENAI_BASE_URL` | ❌ | 模型服务地址 | `https://api.openai.com/v1` |
| `MODEL_NAME` | ❌ | 模型名称 | `gpt-4o-mini` |
| `MAX_ITERATIONS` | ❌ | Agent 最大迭代次数 | `10` |
| `VERBOSE` | ❌ | 是否输出 Thought/Action/Observation 日志（`true`/`false`） | `true` |
| `DEBUG` | ❌ | 是否开启文件调试日志（`true`/`false`，输出到 `~/.loop-agent/logs`） | `false` |

### 支持的 Base URL 示例

```env
# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1

# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com/v1

# Moonshot / Kimi
OPENAI_BASE_URL=https://api.moonshot.cn/v1

# 本地部署（vLLM / Ollama 等）
OPENAI_BASE_URL=http://localhost:8000/v1
```

### 运行时配置管理

通过 CLI 内置的 `/config` 命令可直接修改配置（写入 `.loop-agent/.agent-config.json`）：

```bash
# 查看当前完整配置及来源
/config list

# 修改模型名称（写入工作空间配置）
/config set model.name deepseek-chat

# 修改最大迭代次数
/config set model.maxIterations 20

# 开启调试日志
/config set agent.debug true

# 关闭会话自动保存
/config set session.autoSave false

# 写入全局配置（跨项目共享）
/config set model.name gpt-4 --global

# 删除某配置项（恢复为上层默认值）
/config delete model.name

# 查看配置文件路径
/config path
```

> 模型接入与切换建议用 `/model` 命令（详见 [内置命令](#内置命令)）：`/model use <别名>` 会同步激活指针与生效快照，避免直接 `/config set model.name` 造成快照与登记簿漂移。

---

## 🎧 事件监听器

参考 LangChain callbacks 设计，支持 **15 个生命周期钩子**。可叠加任意数量的监听器。

### 钩子列表

| 钩子 | 触发时机 | 参数 |
|---|---|---|
| `onStart` | Agent 开始执行 | `input: string` |
| `onIterationStart` | 每轮迭代开始 | `iteration: number, maxIterations: number` |
| `onLLMStream` | LLM 流式输出文本片段 | `delta: string` |
| `onLLMEnd` | 每轮 LLM 调用结束 | `response: LLMResponse, iteration: number` |
| `onToolStart` | 工具开始执行 | `tool: string, args: Record<string, unknown>` |
| `onToolEnd` | 工具执行结束 | `tool: string, result: string` |
| `onToolProgress` | 工具执行进度心跳（Task-20260930-001，长耗时工具每秒上报已用时） | `tool: string, elapsedMs: number` |
| `onToolCallDelta` | 生成工具参数（tool_calls.arguments）的流式增量（Task-20260930-001，覆盖 Thought 后到 [Action] 的空窗） | `tool: string, accumulatedBytes: number, elapsedMs: number` |
| `onCompaction` | L1 上下文达阈值触发压缩（Task-17） | `info: CompactionInfo` |
| `onFinal` | Agent 给出最终答案 | `answer: string` |
| `onError` | 发生错误 | `error: Error` |
| `onWarning` | 非致命告警（level: warning/error） | `info: { level: 'warning' \| 'error'; message: string; context?: string }` |
| `onEnd` | Agent 执行结束（成功或失败） | `result: AgentResult \| null` |
| `onLLMStats` | 每轮 LLM 调用结束，输出 token 统计（Task-15） | `stats: LLMStats` |
| `onLLMStatsSummary` | 会话全部迭代结束，输出汇总统计（Task-15） | `summary: LLMStatsSummary` |

### 多个监听器叠加

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// 日志记录器
const auditLogger: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[AUDIT] 调用工具: ${tool}`);
  },
  onFinal: (answer) => {
    console.log(`[AUDIT] 最终答案长度: ${answer.length} 字符`);
  },
};

// 性能监控器
const metricsCollector: AgentEvents = {
  onStart: () => { performance.mark('agent-start'); },
  onEnd: () => {
    performance.measure('agent-duration', 'agent-start');
    const duration = performance.getEntriesByName('agent-duration')[0].duration;
    console.log(`[METRICS] 耗时: ${duration.toFixed(0)}ms`);
  },
};

const result = await agent.run('帮我搜索文件', {
  events: [auditLogger, metricsCollector],
});
```

> **注意**：单个监听器抛错会被捕获，不影响其他监听器与主循环。

---

## 💬 多轮对话

Agent 实例内部维护 `_chatHistory`，跨 `run()` 调用自动持久化消息历史。

### 行为规则

| 场景 | 行为 |
|---|---|
| 首次调用 `run(input)` | 自动创建新会话（system + user） |
| 连续调用 `run(input)` | 自动复用上次的 `_chatHistory`，追加新的 user 消息 |
| `run(input, { resetHistory: true })` | 清空历史，开始全新会话 |
| `run(input, { messages: [...] })` | 使用外部传入的消息历史（会补上 system prompt） |
| `agent.resetSession()` | 手动清空持久化的历史 |
| `agent.getSessionMessages()` | 获取当前会话的消息历史（只读拷贝） |

### 多轮对话示例

```typescript
// 第一轮：读取文件
const r1 = await agent.run('读取 package.json', { resetHistory: true });
// 第二轮：基于第一轮的结果继续追问
const r2 = await agent.run('这个项目的版本号是多少？');
// 此时 Agent 已知道 package.json 内容，可直接回答
```

> **进程内**多轮由 `_chatHistory` 保证；**跨进程**恢复请使用 `SessionStore` 持久化（见下节）。

---

## 💾 会话持久化

Agent 内置了基于文件系统的会话持久化能力：对话历史（messages + steps）加密存储到本地磁盘，重启 CLI 后可通过 `/session load <id>` 恢复上下文继续对话。

### 存储结构

```
~/.loop-agent/
├── .keyfile                      # 🔑 主密钥文件（首次自动生成，权限 0600）
├── config.json                   # 全局配置（可选）
├── logs/
│   └── debug-YYYY-MM-DD.log      # 📝 调试日志（见下节）
└── sessions/
    └── {workspaceId}/            # 按工作空间路径隔离（路径 SHA-256 前 16 位）
        ├── meta.json             # 工作空间元信息
        ├── sessions.json         # 会话索引（仅元信息，不含消息内容）
        └── sess_YYYYMMDD_HHMMSS.enc   # 加密的会话数据文件
```

### 加密机制

- **主密钥**：首次使用时自动生成 256-bit 随机密钥，保存于 `~/.loop-agent/.keyfile`（`0600` 权限），无需用户输入密码
- **数据加密**：会话消息通过 **PBKDF2（100,000 次迭代）派生** + **AES-256-GCM** 加密，附带认证标签保证完整性
- **密钥校验**：密钥文件包含校验 token，读取时会验证密钥完整性，损坏则报错
- **索引明文**：`sessions.json` 仅存储会话元信息（ID、标题、消息数、时间），消息内容全部加密

### 自动保存 / 恢复

- **自动保存**：`run()` 结束后，若 `session.autoSave=true` 且已设置 SessionStore，自动创建新会话或更新当前会话
- **自动恢复**：`session.autoRestore=true` 时，CLI 启动会自动加载最近一次会话，无缝续接上次对话
- **手动控制**：可通过 `/session` 子命令随时 list / load / save / new / delete

### 密钥管理（Keychain）

`src/session/keychain.ts` 提供密钥生命周期管理：

| 方法 | 说明 |
|---|---|
| `keychain.ensureUnlocked()` | 确保密钥已加载（首次自动生成密钥文件） |
| `keychain.exportKey()` | 导出主密钥（base64，用于备份） |
| `keychain.importKey(base64)` | 从备份导入主密钥（用于迁移/恢复） |
| `keychain.reset()` | 删除密钥文件（⚠️ 会导致所有加密会话无法解密） |

> ⚠️ **重要**：`.keyfile` 是解密会话的唯一凭证。丢失该文件将导致所有加密会话无法恢复，建议定期 `exportKey()` 备份。

---

## 🧠 记忆管理

基于 OpenClaw 风格的三层记忆架构（Tier Model），核心思想：**文件是真相源，索引只做加速；写读路径分离；晋升有闸门。** 记忆系统与会话持久化（Task-11）互补：会话持久化解决"恢复上次对话"，记忆管理解决"跨会话知识积累"。

### 三层架构

| 层级 | 存储形态 | 生命周期 | 自动进 context | 说明 |
|---|---|---|---|---|
| **L1 Working** | 内存 `_chatHistory` | 单次会话 | ✅ 始终在 | 超阈值自动压缩（默认 8000 token / 80% 阈值，保留最近 3 轮） |
| **L2 Episodic** | `{cwd}/memory/YYYY-MM-DD.md` | 永久存档 | ❌ 按需检索 | 按天分文件，工具调用结果自动记录，支持 `/memory search` 召回 |
| **L3 Curated** | `{cwd}/SOUL.md` / `USER.md` / `MEMORY.md` | 永久常驻 | ✅ 启动注入 | Agent 人格 / 用户画像 / 精炼事实，常驻 System Prompt |

### 目录结构

```
<workspace>/
├── SOUL.md                     # L3：Agent 人格与行为准则（系统生成，人工编辑）
├── USER.md                     # L3：用户画像（稳定偏好、沟通风格、约束）
├── MEMORY.md                   # L3：精炼事实（项目知识、关键决策、已知问题）
└── memory/                     # L2：情景记忆（按天分文件）
    ├── 2026-08-08.md
    ├── 2026-08-09.md
    └── ...
```

### L3 文件模板

```markdown
# SOUL - Agent 人格
## 核心身份 / 行为准则 / 沟通风格

# USER - 用户画像
## 基本信息 / 偏好 / 约束

# MEMORY - 精炼事实
## 项目知识 / 关键决策 / 已知问题
```

首次启动或执行 `/memory curated list` 时自动创建；L3 内容会在每次 LLM 调用时注入 System Prompt，作为"长期记忆"常驻参考。

### CLI 示例

```
/memory status                          # 查看记忆系统状态（各层统计）
/memory curated list                    # 列出 L3 核心记忆文件（行数/字符数）
/memory curated read user               # 读取 USER.md
/memory curated append memory "决策：默认使用 DeepSeek 模型"  # 追加核心记忆
/memory episodic list                   # 列出 L2 情景记忆日志
/memory episodic read 2026-08-09        # 读取指定日期日志
/memory search 华锐                      # 搜索历史记忆
/memory dream 3                         # 手动触发 Dreaming 巡检（最近 3 天）
/memory gate                            # 查看 Promotion Gate 待确认/待晋升事实
```

### 编程式使用

```typescript
import {
  EpisodicMemory, CuratedMemory, WorkingMemory,
  PromotionGate, DreamingPipeline, MemoryIndex, VectorMemory, rrfMerge,
} from './src/memory/index.js';

// L2 情景记忆：按天写入/读取
const episodic = new EpisodicMemory(process.cwd());
await episodic.init();
await episodic.appendToday('- 用户询问了华锐的报价');

// L3 核心记忆：读写 SOUL / USER / MEMORY
const curated = new CuratedMemory(process.cwd());
await curated.init();
await curated.append('user', '用户偏好邮件沟通');

// L1 工作记忆：token 估算与压缩
const working = new WorkingMemory();
const needs = working.needsCompaction(messages);

// Promotion Gate + Dreaming：L2 → L3 晋升（不同来源需不同确认次数）
const gate = new PromotionGate(process.cwd());
await gate.init();
await gate.record('用户偏好邮件沟通', 'owner_direct');

const dream = new DreamingPipeline({ gate, episodic, curated, llm });
const result = await dream.run(3);   // 巡检最近 3 天，达标事实晋升 L3

// 混合检索：BM25 全文 + 向量（可选）通过 RRF 融合排序
const index = new MemoryIndex();
index.add(day, content);
const vector = new VectorMemory();
const merged = rrfMerge(ftsHits, vectorHits);
```

### 设计原则（Phase 1-5 已落地）

- **文件即真相源**：Markdown 明文可读、可 diff、可版本管理（SQLite 索引在后续阶段引入）
- **写读分离**：回复路径只做检索，不抽取记忆；抽取走 Dreaming 流水线（`/memory dream` 或退出时自动触发）
- **晋升有闸门**：不同来源（用户直述 / 工具输出 / 网页搜索）需不同确认次数才能晋升 L3（Promotion Gate 已实现，`/memory gate` 可查看）
- **混合检索**：BM25 全文检索 + 向量检索（可选）通过 RRF 融合排序，配置 `episodic.vectorSearch` 后自动启用，embedding 失败自动降级
- **失败降级**：记忆子系统异常不影响主回复路径

---

## 📊 LLM Token 统计

Agent 内置 LLM Token 统计（Task-15）：每轮 LLM 调用结束后输出上下文/输入/输出 token 与缓存命中率，会话结束后输出会话级汇总（总 token、平均缓存命中率、上下文峰值）。

```
[迭代 2/5] 上下文 3214/8000 (40%) | 输入 2588 | 输出 412 | 缓存 72.3% | 1.2s
[统计汇总] 3 轮 | 总输入 7842 | 总输出 1230 | 总 token 9072 | 平均缓存命中 68.5% | 上下文峰值 4500/8000 (56%)
```

- **开关**：配置 `agent.showTokenStats`（默认 `true`），关闭后不再打印统计行
- **事件**：可监听 `onLLMStats`（每轮）与 `onLLMStatsSummary`（会话结束）获取结构化数据
- **上下文警示**：上下文 token 接近/超过 L1 压缩阈值时，统计行以黄色高亮警示

---

## 📝 调试日志

Agent 内置了文件型调试日志系统（`src/debug.ts`），可将 LLM 请求/响应、工具调用、Agent 迭代过程完整记录到本地文件，便于问题排查。

### 开启方式

```bash
# 方式一：环境变量
DEBUG=true npm start

# 方式二：运行时配置
/config set agent.debug true
```

开启后 CLI 启动会提示：

```
⚠ 调试模式已开启，日志输出到: C:\Users\xxx\.loop-agent\logs
```

### 日志位置与轮转

- **位置**：`~/.loop-agent/logs/debug-YYYY-MM-DD.log`（按日期分文件）
- **轮转**：单文件最大 **10MB**，超出后自动轮转，最多保留 **5** 个历史文件
- **脱敏**：日志中的 API Key 自动脱敏（仅显示首尾各 4 位）

### 日志内容

| 类型 | 触发时机 | 记录内容 |
|---|---|---|
| `llmRequest` | 每次 LLM 请求 | 模型、消息数、工具数、脱敏后的参数 |
| `llmResponse` | LLM 响应返回 | 内容（截断 300 字符）、工具调用、耗时 |
| `llmError` | LLM 调用报错 | 错误信息、耗时 |
| `toolCall` | 每次工具调用 | 工具名、参数、结果（均截断）、耗时 |
| `iteration` | 每轮 Agent 迭代 | Thought / Action / Observation |
| `session` | 每次 `run()` 开始 | 消息数、工具数、会话 ID |

### 编程式读取

```typescript
import { debug } from './src/debug.js';

// 当前日志文件路径
const logPath = debug.getLogPath();

// 读取最近日志内容（默认最多 10000 字符）
const content = debug.readLog(10000);
```

---

## 📁 项目结构

```
loop-agent-command/
├── src/
│   ├── index.ts                      # 🚪 CLI 入口（交互式 REPL + 多命令支持）
│   ├── config.ts                     # ⚙️ 环境变量配置（deprecated，兼容旧代码，请改用 config/index.ts）
│   ├── debug.ts                      # 📝 调试日志（文件输出，LLM/工具/迭代日志）
│   ├── types.ts                      # 📐 核心类型定义（Tool, ChatMessage, AgentEvents 等）
│   ├── agent/
│   │   ├── react-agent.ts            # 🔄 ReAct 主循环（流式版本 + 会话自动保存）
│   │   ├── prompt.ts                 # 📝 System Prompt 构造器（含 Skill 元信息注入）
│   │   ├── logger.ts                 # 🎨 ConsoleLogger（彩色日志输出，实现 AgentEvents）
│   │   └── stats.ts                  # 📊 LLM 统计聚合（buildLLMStatsSummary）
│   ├── llm/
│   │   └── client.ts                 # 🤖 LLM 客户端（chat + chatStream + 自动重试）
│   ├── config/                       # ⚙️ 分层配置系统
│   │   ├── index.ts                  # 统一导出
│   │   ├── schema.ts                 # 配置类型定义 + 默认值（含 skill / memory 段）
│   │   ├── loader.ts                 # 配置加载器（分层合并）
│   │   ├── writer.ts                 # 配置写入器（持久化）
│   │   ├── merge.ts                  # 深度合并工具
│   │   └── mcp-manager.ts            # MCP 生命周期管理器
│   ├── skill/                        # 🎯 Skill 技能包
│   │   ├── index.ts                  # 统一导出
│   │   ├── types.ts                  # Skill 类型定义（SkillMetadata / SkillContent）
│   │   ├── scanner.ts                # 目录扫描 + SKILL.md YAML frontmatter 解析
│   │   └── loader.ts                 # SkillLoader（扫描 / 渐进式加载）
│   ├── memory/                       # 🧠 三层记忆管理（Phase 1-5）
│   │   ├── index.ts                  # 统一导出
│   │   ├── types.ts                  # 记忆类型定义 + 默认配置
│   │   ├── working.ts                # L1 WorkingMemory（token 估算 + 压缩）
│   │   ├── episodic.ts               # L2 EpisodicMemory（按天 Markdown 日记 + 检索）
│   │   ├── curated.ts                # L3 CuratedMemory（SOUL/USER/MEMORY 读写）
│   │   ├── context.ts                # ContextAssembler（L3 注入 + L2 检索组装）
│   │   ├── callback.ts               # ToolMemoryCallback（工具结果自动写入 L2）
│   │   ├── gate.ts                   # PromotionGate（晋升闸门：确认计数/阈值）
│   │   ├── dreaming.ts               # DreamingPipeline（L2 → L3 后台晋升）
│   │   ├── fts.ts                    # MemoryIndex（BM25 全文检索 + 分词）
│   │   ├── embedding.ts              # EmbeddingClient（向量嵌入客户端）
│   │   ├── vector.ts                 # VectorMemory（向量存储 + 余弦相似度）
│   │   └── hybrid.ts                 # 混合检索（FTS + 向量 RRF 融合）
│   ├── session/                      # 💾 会话持久化（加密存储）
│   │   ├── index.ts                  # 统一导出
│   │   ├── store.ts                  # SessionStore（会话读写/索引/工作空间隔离）
│   │   ├── keychain.ts               # Keychain（主密钥自动生成/加载/备份）
│   │   ├── crypto.ts                 # 加密原语（PBKDF2 + AES-256-GCM）
│   │   └── types.ts                  # 会话类型定义 + 默认配置
│   └── tools/
│       ├── index.ts                  # 🛠️ 工具系统聚合入口
│       ├── registry.ts               # 📋 工具注册表（注册/查询/转 OpenAI 格式/MCP 管理）
│       ├── runner.ts                 # ⚡ 工具执行器（超时控制 + 异常捕获）
│       ├── commandRun.ts             # 🖥️ 内置工具：命令执行
│       ├── fileRead.ts               # 📄 内置工具：文件读取
│       ├── fileWrite.ts              # ✏️ 内置工具：文件写入
│       ├── editFile.ts               # 🔁 内置工具：文本编辑（字面量/正则/行范围）
│       ├── grep.ts                   # 🔍 内置工具：内容检索
│       ├── activateSkill.ts          # 🎯 内置工具：Skill 激活（渐进式加载）
│       ├── vision/                   # 👁️ 视觉工具（对接多模态视觉模型）
│       │   ├── tools.ts              # 四个视觉工具（describe_image / ask_image / extract_json / ocr_image）
│       │   ├── image.ts              # 图片解析（本地转 base64 data URL / URL 校验 / 大小限制）
│       │   ├── cache.ts              # LRU 结果缓存（本地文件指纹参与 key，内容变更自动失效）
│       │   └── stats.ts              # 用量统计（成功 / 失败 / 缓存命中 / 耗时 / token）
│       └── mcp/                      # 🌐 MCP 工具接入
│           ├── index.ts              # 入口
│           ├── client.ts             # MCP 客户端（stdio / SSE 传输）
│           └── adapter.ts            # MCP 工具适配器（转 Tool 接口）
├── examples/
│   └── run.ts                        # 📝 编程式调用示例
├── tests/                            # 🧪 测试（串行执行避免 API 限速）
│   ├── integration/                  # 集成测试（7 个用例）
│   │   ├── a-no-tool.test.ts         # 无需工具的场景
│   │   ├── b-single-tool.test.ts     # 单工具调用
│   │   ├── c-multi-tool.test.ts      # 多工具调用
│   │   ├── d-tool-failure.test.ts    # 工具执行失败
│   │   ├── e-unknown-tool.test.ts    # 工具不存在
│   │   ├── f-max-iterations.test.ts  # 达到最大迭代次数
│   │   └── g-parallel-tools.test.ts  # 同轮并行工具
│   ├── memory-working.test.ts        # L1 工作记忆（token 估算 + 压缩）
│   ├── memory-callback.test.ts       # 工具回调自动写入 L2
│   ├── memory-flush.test.ts          # L2 按天日志 flush
│   ├── memory-dreaming.test.ts       # Dreaming 晋升流水线
│   ├── memory-gate.test.ts           # Promotion Gate
│   ├── memory-phase4.test.ts         # Phase 4 混合检索
│   ├── memory-phase5.test.ts         # Phase 5 向量检索
│   ├── session-isolation.test.ts     # 会话工作空间隔离
│   ├── edit-file.test.ts             # editFile 文本编辑工具（字面量/正则/行范围）
│   ├── file-read.test.ts             # fileRead 行号输出
│   ├── activate-skill.test.ts        # activate_skill 输出技能目录 / SKILL.md 路径
│   ├── system-prompt.test.ts         # System Prompt 的 Skill 区块注入
│   ├── llm-stats.test.ts             # LLM 统计聚合
│   ├── vision-cache.test.ts          # 视觉结果缓存（LRU / TTL / 文件指纹失效）
│   ├── vision-image.test.ts          # 图片解析（本地转 base64 / URL / 大小与格式校验）
│   ├── vision-client.test.ts         # chatVision 多模态客户端（jsonMode / 错误语境重写 / 重试）
│   ├── vision-registry.test.ts       # 视觉工具注册（vision.enabled 联动 / Tab 补全名单）
│   ├── vision-tools.test.ts          # 视觉工具管道（解析 / 缓存 / 回退 / 截断）
│   └── vision-command.test.ts        # /vision 命令（status / test）
├── docs/
│   ├── plan.md                       # 📋 开发总计划与里程碑
│   ├── openclaw_memory_management.md # 🧠 记忆管理设计参考（OpenClaw 风格）
│   └── tasks/                        # 📂 逐任务文档（15 个任务，含记忆管理 Phase 1-5 与 LLM 统计）
├── .loop-agent/                      # 📋 工作空间配置与 Skill（.agent-config.json + skills/，整体不进入版本控制）
│   ├── .agent-config.json            # ⚙️ 工作空间配置（可选，运行时生成）
│   └── skills/                       # 🎯 工作空间 Skill（example-skill、py-pptx 等）
├── memory/                           # 🧠 L2 情景记忆（运行时生成，按天分文件）
├── SOUL.md                           # 🧠 L3：Agent 人格
├── USER.md                           # 🧠 L3：用户画像
├── MEMORY.md                         # 🧠 L3：精炼事实
├── .env                              # 🔒 环境变量（需从 .env.example 复制创建）
├── .env.example                      # 📄 环境变量模板
├── .mcp.json                         # 🔌 MCP 配置（可选，从 .mcp.json.example 复制）
├── .mcp.json.example                 # 📄 MCP 配置模板
├── package.json
├── tsconfig.json
├── vitest.config.ts                  # 🧪 测试配置（串行执行）
└── README.md                         # 📖 项目说明文档
```

---

## 🛠️ 技术栈

| 项目 | 选型 | 说明 |
|---|---|---|
| **语言** | TypeScript 5.x | strict 模式，类型安全 |
| **运行时** | Node.js 18+ | 原生 ESM 模块 |
| **LLM SDK** | `openai` v4.x | 兼容任意 OpenAI 协议服务商 |
| **MCP SDK** | `@modelcontextprotocol/sdk` v1.x | 外部工具接入协议 |
| **加密** | Node.js `crypto` | PBKDF2 + AES-256-GCM 会话加密 |
| **测试框架** | vitest | 集成测试，串行执行 |
| **构建工具** | tsup | 输出 ESM 格式 |
| **开发工具** | tsx | 开发时直接运行 TypeScript |
| **环境变量** | 内置 .env 解析器 | 启动时自动读取 `.env` 到 `process.env`（兼容 dotenv 行为） |

---

## 🏗️ 开发

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck

# 运行测试
npm test

# 监听模式测试
npm run test:watch
```

---

## 🚀 SEA 单文件部署

将 Agent 打包为**单个可执行文件**（Node SEA，Single Executable Applications），现场部署**无需安装 Node.js 与任何依赖**，直接运行即可。

### 构建

```bash
# 构建机需 Node.js >= 20.10
npm run build:sea
```

产物输出到 `dist-sea/`：

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `dist-sea/loop-agent.exe` | 已实测验证（Node v24） |
| Linux | `dist-sea/loop-agent` | 需在 Linux 上构建 |
| macOS | `dist-sea/loop-agent` | 需在 macOS 上构建 |

> **不可交叉编译**：Node SEA 要求在**目标操作系统上构建**（Windows 产物只能在 Windows 运行）。现场是哪种系统，就在哪种系统上执行一次 `npm run build:sea`。

### 运行

```bash
# Windows
.\dist-sea\loop-agent.exe

# Linux / macOS（先 chmod +x）
./dist-sea/loop-agent
```

运行体验与 `npm start` 完全一致：进入交互式 REPL，`/status`、`/config`、`/memory`、`/session` 等命令全部可用，记忆系统（L1/L2/L3）正常启用。

### 构建原理

1. **打包**：`tsup` 将 TypeScript 编译为单文件 CJS，第三方依赖全部内联（`noExternal`）
2. **生成 blob**：`node --experimental-sea-config` 根据 `sea-config.json` 生成准备 blob
3. **注入**：复制 Node 运行时作为产物骨架，用 `postject` 注入 `NODE_SEA_BLOB`

对应编排脚本：[scripts/build-sea.mjs](scripts/build-sea.mjs)（`package.json` 的 `build:sea`）。

### 现场注意点

| 事项 | 说明 |
|---|---|
| **MCP 依赖** | 使用 stdio 型 MCP server（如 `npx -y @modelcontextprotocol/...`）时，目标机仍需安装 Node/npx 才能拉起子进程；SSE 型无此要求 |
| **全局配置与密钥迁移** | 首次运行会在 `~/.loop-agent/` 生成全局配置、`.keyfile`（会话加密主密钥）等；迁机时建议一并迁移，否则历史加密会话无法解密（可用 `keychain.exportKey()` 备份） |
| **工作目录语义** | 程序以**当前工作目录**为工作空间根：L2 记忆写入 `<cwd>/memory/`，工作空间配置读取 `<cwd>/.loop-agent/`。在不同目录启动会看到不同的"项目上下文" |
| **无需 Node 运行时** | 单文件产物自带 Node 运行时，目标机只需操作系统本身 |

---

## 🔍 故障排查

### API Key 无效或已过期

```
错误：API Key 无效或已过期，请检查 .env 中的 OPENAI_API_KEY
```

**解决**：检查 `.env` 中 `OPENAI_API_KEY` 是否正确，是否与 `OPENAI_BASE_URL` 对应的服务商匹配。也可通过 `/config set model.apiKey <key>` 运行时修改。

### 模型不存在（404）

```
错误：模型不存在（404），请检查 .env 中的 MODEL_NAME（当前: xxx）
```

**解决**：确认 `MODEL_NAME` 在目标服务商上可用。通过 `/config set model.name <新模型名>` 运行时修改。

### 请求过于频繁（429）

```
错误：请求过于频繁（429），请稍后重试或降低调用频率
```

**解决**：降低调用频率。集成测试默认串行执行（`fileParallelism: false`）避免并发限速。

### 工具执行超时

```
错误：工具执行超时 (30000ms)
```

**解决**：`commandRun` 工具默认 30s 超时，可通过 `timeout` 参数调整。复杂命令建议拆分为多步执行。

### Windows 终端中文乱码

**解决**：CLI 启动时已自动执行 `chcp 65001` 切换到 UTF-8。如仍乱码，手动运行 `chcp 65001` 后再启动。

### 达到最大迭代次数

```
错误：达到最大迭代次数 10，Agent 未能给出最终答案
```

**解决**：增大 `.env` 中 `MAX_ITERATIONS`，或通过 `/config set model.maxIterations 20` 运行时修改。也可以简化问题描述，让 Agent 在更少步骤内完成。

### 工具未注册

```
错误：工具 xxx 未注册
```

**解决**：调用 `registerBuiltinTools()` 注册内置工具，或通过 `registry.register(tool)` 注册自定义工具。也可通过 `/tools reload` 重新加载。

### MCP 连接失败

```
错误：MCP server xxx 连接失败
```

**解决**：检查 MCP 配置是否正确，可执行 `/mcp test <name>` 测试连接。使用 `/mcp remove <name>` 移除后重新 `/mcp add <name>` 添加。

### Skill 未找到

```
错误：Skill "xxx" 未找到。可用的 Skill: ...
```

**解决**：确认 Skill 已放入 `~/.loop-agent/skills/`（全局）或 `<cwd>/.loop-agent/skills/`（工作空间），且 `SKILL.md` 包含合法的 `name` 和 `description` frontmatter。通过 `/skill list` 查看扫描结果，`/skill reload` 重新扫描。

### 记忆系统未启用

```
⚠ 记忆系统未启用，请在配置中设置 memory.enabled=true
```

**解决**：通过 `/config set memory.enabled true` 开启，或直接编辑 `.loop-agent/.agent-config.json`。`/memory status` 可查看当前启用状态与各层统计。

### 会话无法加载 / 解密失败

```
错误：密钥文件损坏，验证失败
错误：密钥未加载，无法读取会话
```

**解决**：
- 检查 `~/.loop-agent/.keyfile` 是否存在且未损坏
- 若误删/损坏，可通过备份的 `exportKey()` 导出的 base64 调用 `keychain.importKey()` 恢复
- 若无法恢复，可删除损坏的会话文件（`/session delete <id>`）后重新开始

### 调试日志未生成

**解决**：确认已通过 `DEBUG=true` 环境变量或 `/config set agent.debug true` 开启调试模式，日志输出到 `~/.loop-agent/logs/debug-YYYY-MM-DD.log`。开启后 CLI 启动 banner 会显示调试日志目录提示。

### 配置来源追踪

当配置未按预期生效时，可通过 `/config list` 查看每个字段的实际来源（cli / workspace / global / env / default），快速定位是哪一层覆盖了配置。

---

## 📄 License

[MIT](LICENSE) © 2026

---

<div align="center">
  <sub>Built with ❤️ using TypeScript</sub>
</div>
