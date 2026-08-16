# 🤖 ReAct Agent

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
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
[🔍 故障排查](#-故障排查)

</div>

---

## ✨ 特性

| 特性 | 说明 |
|---|---|
| 🔄 **ReAct 循环** | Thought → Action → Observation 逐步推理，直到得出最终答案 |
| 📡 **流式输出** | LLM 推理过程实时流式输出，支持 `content` 与 `tool_calls` 分片拼接 |
| 📊 **Token 统计** | 每轮输出上下文/输入/输出 token 与缓存命中率，会话结束输出汇总（`showTokenStats` 可关） |
| 🔌 **OpenAI 协议** | 兼容任意 OpenAI 协议服务商（OpenAI、DeepSeek、Moonshot、本地 vLLM 等） |
| 🛠️ **内置工具** | 命令执行、文件读取（支持行范围）、文件写入、内容检索（grep）、Skill 激活 |
| 🌐 **MCP 接入** | 支持通过 Model Context Protocol 接入外部工具服务（stdio / SSE） |
| 🧩 **Skill 技能包** | SKILL.md 规范 + 渐进式加载，`activate_skill` 工具按需激活领域指令 |
| 🧠 **三层记忆管理** | L1 Working（token 压缩）/ L2 Episodic（按天日记）/ L3 Curated（常驻注入） |
| 🔧 **分层配置系统** | CLI > 工作空间 > 全局 > .env > 默认值，多层覆盖，来源可追溯 |
| 🎛️ **运行时配置管理** | CLI 内置 `/config`、`/mcp`、`/tools`、`/skill`、`/memory` 命令，支持热修改 |
| 💾 **会话持久化** | 对话历史 AES-256-GCM 加密存储，跨进程自动保存 / 手动恢复 |
| 📝 **调试日志** | 文件日志记录 LLM 请求/响应、工具调用、Agent 迭代，自动轮转 |
| 🎯 **事件监听** | 参考 LangChain callbacks 设计，11 个生命周期钩子便于扩展 |
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

复制 `.env.example` 为 `.env` 并填入配置：

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
# 🎮 CLI 交互模式
npm start

# 📝 编程式调用示例
npx tsx examples/run.ts

# 🧪 测试（集成 7 例 + 记忆/会话/统计等单测，串行执行避免 API 限速）
npm test

# ✅ 类型检查
npm run typecheck

# 📦 构建（输出到 dist/）
npm run build
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
内置工具: [commandRun, fileRead, fileWrite, grep, activate_skill]
MCP 工具: 3 个, Servers: atlasGraphMcp (atlasGraphMcp__toolName)
Skills: 2 个 (example-skill, py-pptx)
⚠ 调试模式已开启，日志输出到: ~/.loop-agent/logs

Agent> 帮我读取 package.json 的版本号
```

> 若配置中开启了 `agent.debug`，启动时会额外提示调试日志输出目录（见 [📝 调试日志](#-调试日志)）。

### 内置命令

| 命令 | 说明 |
|---|---|
| `输入问题` | Agent 流式输出 Thought / Action / Observation / Final |
| `/help` | 查看帮助信息 |
| `/reset` `/clear` | 清空多轮对话历史，开始新会话 |
| `/status` | 查看当前会话状态（消息数 / 工具数 / MCP 工具数 / Skills） |
| `/tools` | 工具管理（list / enable / disable / reload） |
| `/config` | 配置管理（get / set / delete / list / path） |
| `/mcp` | MCP 管理（list / add / remove / reload / test） |
| `/session` | 会话管理（list / load / save / new / current / delete / delete-all） |
| `/skill` | Skill 管理（list / reload / show） |
| `/memory` | 记忆管理（status / curated / episodic / search / dream / gate / init） |
| `exit` / `quit` / `退出` | 退出程序（Ctrl+C 同样有效） |

### 输出示例

```
━━━ 迭代 1/10 ━━━

[Thought] 我需要读取 package.json 文件来获取版本号...

[Action] fileRead({"path":"package.json"})
[Observation]
  {
    "name": "loop-agent-command",
    "version": "0.1.0",
    ...
  }

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
```

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
```

Skill 从全局 `~/.loop-agent/skills/` 与工作空间 `<cwd>/.loop-agent/skills/` 两个目录自动扫描，同名时工作空间优先。详见 [🎯 Skill 技能包](#-skill-技能包)。

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
| 📄 **文件读取** | `fileRead` | 读取文件内容，支持按行范围部分读取 | `path`（必填）, `startLine`（可选）, `endLine`（可选）, `encoding`（可选） |
| ✏️ **文件写入** | `fileWrite` | 写入文件，支持覆盖与追加，自动创建父目录 | `path`（必填）, `content`（必填）, `mode`（可选，`overwrite` / `append`） |
| 🔍 **内容检索** | `grep` | 在文件或目录中检索内容，支持正则、忽略大小写、递归搜索 | `pattern`（必填）, `path`（必填）, `ignoreCase`（可选）, `recursive`（可选）, `maxResults`（可选，默认 50） |
| 🎯 **Skill 激活** | `activate_skill` | 激活指定 Skill（技能包），返回 SKILL.md 完整指令供 Agent 参考执行 | `name`（必填） |

### 工具使用示例

```bash
# 命令执行
commandRun({ "command": "dir", "cwd": "." })

# 文件读取（全文）
fileRead({ "path": "package.json" })

# 文件读取（部分行）
fileRead({ "path": "src/agent/react-agent.ts", "startLine": 1, "endLine": 20 })

# 文件写入
fileWrite({ "path": "output.txt", "content": "Hello World", "mode": "overwrite" })

# 内容检索
grep({ "pattern": "config", "path": "src", "ignoreCase": true, "maxResults": 20 })

# Skill 激活（渐进式加载，返回 SKILL.md 完整内容）
activate_skill({ "name": "example-skill" })
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

MCP（Model Context Protocol）是一种标准化的工具接入协议，支持 stdio 和 SSE 两种传输方式。

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
    }
  }
}
```

项目启动时会自动加载配置并注册所有 MCP server 的工具。工具名规则：`{serverName}__{toolName}`（如 `filesystem__read_file`）。

#### 方式二：CLI 交互式添加

启动后输入 `mcp add my-server`，按提示输入传输类型、命令/URL 等，自动测试连接后写入配置。

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

#### 方式四：SSE 协议接入

```typescript
await registry.registerMCPServer('my-server', {
  type: 'sse',
  url: 'http://localhost:3000/mcp',
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

1. **启动时**：自动扫描全局 + 工作空间 Skill，元信息（name + description）注入 System Prompt
2. **运行时**：LLM 判断用户意图匹配某个 Skill → 调用 `activate_skill` 工具
3. **加载后**：工具返回 SKILL.md 完整内容，Agent 据此继续推理执行
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
  "tools": {
    "enabled": ["commandRun", "fileRead", "fileWrite", "grep", "activate_skill"],
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
  }
}
```

| 配置段 | 字段 | 说明 | 默认值 |
|---|---|---|---|
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` / `maxIterations` | LLM 模型配置 | `gpt-4o-mini` 等 |
| `tools` | `enabled` / `disabled` / `mcpServers` | 内置工具开关与 MCP server 配置 | 全部启用 |
| `agent` | `verbose` | 是否输出 Thought/Action/Observation 控制台日志 | `true` |
| `agent` | `debug` | 是否开启文件调试日志（见 📝 调试日志） | `false` |
| `agent` | `systemPrompt` | 自定义 system prompt 覆盖 | `null` |
| `agent` | `showTokenStats` | 是否输出每轮/会话汇总 token 统计（Task-15） | `true` |
| `session` | `autoSave` | `run()` 结束后自动保存会话到磁盘 | `true` |
| `session` | `autoRestore` | 启动时自动恢复最近会话 | `true` |
| `session` | `encryptionEnabled` | 会话文件是否加密存储（AES-256-GCM） | `true` |
| `skill` | `enabled` / `globalDir` / `workspaceDir` / `autoLoad` | Skill 技能包开关与扫描目录 | 全部启用 |
| `memory` | `enabled` / `working` / `episodic` / `curated` / `dreaming` / `vectorSearch` | 三层记忆系统配置（含检索增强） | 全部启用 |

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

---

## 🎧 事件监听器

参考 LangChain callbacks 设计，支持 **11 个生命周期钩子**。可叠加任意数量的监听器。

### 钩子列表

| 钩子 | 触发时机 | 参数 |
|---|---|---|
| `onStart` | Agent 开始执行 | `input: string` |
| `onIterationStart` | 每轮迭代开始 | `iteration: number, maxIterations: number` |
| `onLLMStream` | LLM 流式输出文本片段 | `delta: string` |
| `onLLMEnd` | 每轮 LLM 调用结束 | `response: LLMResponse, iteration: number` |
| `onToolStart` | 工具开始执行 | `tool: string, args: Record<string, unknown>` |
| `onToolEnd` | 工具执行结束 | `tool: string, result: string` |
| `onFinal` | Agent 给出最终答案 | `answer: string` |
| `onError` | 发生错误 | `error: Error` |
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
│       ├── grep.ts                   # 🔍 内置工具：内容检索
│       ├── activateSkill.ts          # 🎯 内置工具：Skill 激活（渐进式加载）
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
│   └── llm-stats.test.ts             # LLM 统计聚合
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
