# 🤖 ReAct Agent

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.10+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)]()

**一个基于 ReAct（Reasoning + Acting）框架的智能 Agent**，采用 OpenAI 协议接入大语言模型，通过 **Function Calling** 实现工具调用，使用 **TypeScript** 开发。

> 🧠 **核心思想**：**Thought → Action → Observation** 循环推理，像人类一样"思考-行动-观察"，逐步解决问题，直到得出最终答案。

[English](README.en.md) | [✨ 特性](#-特性) | [🚀 快速开始](#-快速开始) | [📚 详细文档](#-详细文档)

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
| 📈 **模型性能测速** | 连通性 ≠ 性能：后端实测 + SSE 实时读数，出 TTFT（首个**非空内容** chunk）、TPOT / ITL p90、纯解码 TPS（主指标）、端到端 TPS 与成功率；固定提示词 / `max_tokens` / `temperature:0` 保跨模型可比，默认破坏前缀缓存并记录 `prompt_cache_hit_tokens`，token 数以 `usage` 为权威，样本 < 3 轮不出 p90，网关攒包标注「疑似缓冲」，最多 4 模型串行对比，历史落 `~/.loop-agent/model-bench/history.json`（不存 apiKey）；**CLI 侧同样可用**：`/model bench [别名…]` 与 WebUI 共用同一引擎、同一份历史，TTY 下原地刷新实时读数，Ctrl+C 只停测速并保留已采样本，`--json` 供 CI 消费 |
| 📤 **文件上传** | `/upload` 把本地文件复制到会话隔离的上传目录并注入 Agent 上下文：支持拖拽（跨终端格式归一）、无参弹出系统文件选择框（Windows / macOS / Linux），Agent 下一轮即可读取处理 |
| 🛠️ **内置工具** | 命令执行（前台 / `background:true` 后台运行）、后台任务管理（commandStatus 查状态、commandLogs 增量读日志、commandStop 终止进程树）、文件读取（支持行范围、默认带行号）、文件写入、文本编辑（editFile：字面量/正则/行范围）、内容检索（grep）、Skill 激活 |
| 👁️ **视觉理解** | 对接多模态视觉模型（OpenAI 协议 `image_url` 格式）：看图描述 / 定向问答 / 结构化提取 / OCR 四个工具，本地图片自动转 base64，LRU 结果缓存与用量统计，`/vision` 命令管理与连通性测试 |
| 🌐 **MCP 接入** | 支持通过 Model Context Protocol 接入外部工具服务（stdio / SSE / Streamable HTTP） |
| 🧩 **Skill 技能包** | SKILL.md 规范 + 渐进式加载，`activate_skill` 工具按需激活领域指令 |
| 🧠 **三层记忆管理** | L1 Working（token 超阈值压缩：flush 提取笔记写 L2，再以 `kind=summary` 摘要占位替代旧窗口；截尾按「工具组整体」取舍，不切开 `tool_calls`/`tool` 配对，当前轮 user 锚点无条件保留，摘要长度由提示词约束 500 字）/ L2 Episodic（按天日记）/ L3 Curated（常驻注入）；会话上下文三视图统一：磁盘全量历史为唯一真源，内存压缩与磁盘恢复共用同一 `buildCompactedView` 生成器，恢复即得最近 N 轮 + 摘要 |
| 🔧 **分层配置系统** | CLI > 工作空间 > 全局 > .env > 默认值，多层覆盖，来源可追溯 |
| 🧭 **首次启动引导** | 启动时自动检测模型配置与全局/工作空间目录：缺配置进入交互式向导（baseUrl → apiKey 遮蔽输入 → 模型名 → 连通性校验 → 选择写入层级），目录按默认结构补建；`--no-setup` 跳过，REPL 内 `/setup` 重跑、`/doctor` 只读体检 |
| 🎛️ **运行时配置管理** | CLI 内置 `/config`、`/mcp`、`/tools`、`/skill`、`/memory`、`/vision` 命令，支持热修改 |
| 🖥️ **Web UI** | 浏览器打开即用：多会话聊天（SSE 流式 / 停止生成 / 对话内上传）+ 配置/模型/工具/MCP/技能/记忆/诊断管理台，与 `--serve` 同端口托管，全部复用 REST 端点；工具调用以卡片呈现（线性图标 + 中文名 + 参数摘要，完成/失败/执行中/已中断四态，失败原因直写副标题，连续同类调用合并为 `×N`，原始 JSON 收进 `{ }` 浮层）；对话输入坞为一体卡片（无边框自增高 44→200px、纯内联图标工具行、附件 pill、快捷键常驻提示），支持**会话级模型选择**（在输入坞内切换本次对话所用模型，写入会话元数据、重进会话自动还原，不改全局激活、不影响其它会话） |
| 🧵 **跨工作空间并行** | HTTP 服务模式下每个工作空间持有独立的会话存储、配置、技能、记忆与 Agent 池，多个空间可同时运行互不阻塞；进程级工作目录切换（`process.chdir`）已移除 |
| ⌨️ **Tab 自动补全** | REPL 输入 `/con` 按 Tab 补全为 `/config`，命令与子命令均可补全，多候选自动列出 |
| ⏹️ **Ctrl+C 两态中断** | 回答中按 Ctrl+C 只中断本次回答（流式请求真正取消、工具子进程树被清理、已生成内容保留到会话可继续追问），进程不退出；空闲时 3 秒内连按两次才退出（防误触）；y/N 确认中视为取消、Dreaming 晋升中立即强退 |
| 💾 **会话持久化** | 对话历史 AES-256-GCM 加密存储，跨进程自动保存 / 手动恢复；transcript 全量归档 + 节流快照 + 临时文件 rename 原子写，压缩前强制快照，进程异常退出也不丢工具调用与窗口消息 |
| 📝 **调试日志** | 文件日志记录 LLM 请求/响应、工具调用、Agent 迭代，自动轮转 |
| 🎯 **事件监听** | 参考 LangChain callbacks 设计，16 个生命周期钩子便于扩展 |
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
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bat
:: Windows CMD
copy .env.example .env
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

# Agent 最大迭代次数（可选，默认 100）
MAX_ITERATIONS=100

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

# 🖥️ 构建 Web UI 前端（输出 webui/dist/；该产物不入库，克隆后需先构建一次）
npm run build:webui
```

---

## 📚 详细文档

各章节细节已拆分至 [docs/readme/zh/](docs/readme/zh/)（英文版见 [docs/readme/en/](docs/readme/en/)）：

| 文档 | 说明 |
|---|---|
| [📖 CLI 使用](docs/readme/zh/cli-usage.md) | REPL 交互与 `/config` `/mcp` `/tools` `/session` `/skill` `/memory` `/vision` `/model` `/upload` `/setup` `/doctor` 内置命令详解 |
| [💻 编程式调用](docs/readme/zh/programmatic-usage.md) | `agent.run()` 单轮/多轮对话、会话持久化与自定义事件监听示例 |
| [🌐 HTTP API 服务（--serve）](docs/readme/zh/http-api.md) | HTTP 服务启动方式、鉴权配置、REST 端点与 SSE 事件流 |
| [🖥️ Web UI](docs/readme/zh/web-ui.md) | 浏览器图形界面：启动方式、token 鉴权、八视图功能总览与前端开发 |
| [🏗️ 架构设计](docs/readme/zh/architecture.md) | 分层架构图、ReAct 循环流程与配置分层加载机制 |
| [🔧 内置工具](docs/readme/zh/built-in-tools.md) | 10 个内置工具的参数说明与调用示例 |
| [🧩 工具扩展](docs/readme/zh/tool-extension.md) | 自定义工具编写与 MCP 外部工具接入（五种方式） |
| [🎯 Skill 技能包](docs/readme/zh/skills.md) | SKILL.md 规范、目录结构与渐进式加载工作流 |
| [⚙️ 配置管理](docs/readme/zh/configuration.md) | 配置层级、完整配置结构、环境变量与运行时 `/config` 命令 |
| [🎧 事件监听器](docs/readme/zh/event-listeners.md) | 16 个生命周期钩子与多监听器叠加示例 |
| [💬 多轮对话](docs/readme/zh/multi-turn-conversation.md) | 跨 `run()` 消息历史持久化规则与示例 |
| [💾 会话持久化](docs/readme/zh/session-persistence.md) | 加密存储结构、自动保存/恢复与密钥管理 |
| [🧠 记忆管理](docs/readme/zh/memory-management.md) | L1/L2/L3 三层记忆架构、Promotion Gate 与 Dreaming |
| [📊 LLM Token 统计](docs/readme/zh/llm-token-stats.md) | 每轮与会话级 token 统计输出 |
| [📝 调试日志](docs/readme/zh/debug-logging.md) | 开启方式、日志位置轮转与记录内容 |
| [📁 项目结构](docs/readme/zh/project-structure.md) | 源码目录树与各模块职责 |
| [🛠️ 技术栈](docs/readme/zh/tech-stack.md) | 语言/运行时/SDK/工具链选型清单 |
| [🏗️ 开发](docs/readme/zh/development.md) | 开发、构建、类型检查与测试命令 |
| [🚀 SEA 单文件部署](docs/readme/zh/sea-deployment.md) | 单可执行文件构建、运行与现场注意点 |
| [🔍 故障排查](docs/readme/zh/troubleshooting.md) | 常见错误信息与解决方法 |

---

## 📄 License

[MIT](LICENSE) © 2026

---

<div align="center">
  <sub>Built with ❤️ using TypeScript</sub>
</div>
