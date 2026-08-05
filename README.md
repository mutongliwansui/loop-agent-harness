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
[⚙️ 配置管理](#️-配置管理)
[🎧 事件监听器](#-事件监听器)
[💬 多轮对话](#-多轮对话)
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
| 🔌 **OpenAI 协议** | 兼容任意 OpenAI 协议服务商（OpenAI、DeepSeek、Moonshot、本地 vLLM 等） |
| 🛠️ **内置工具** | 命令执行、文件读取（支持行范围）、文件写入、内容检索（grep） |
| 🌐 **MCP 接入** | 支持通过 Model Context Protocol 接入外部工具服务（stdio / SSE） |
| 🔧 **分层配置系统** | CLI > 工作空间 > 全局 > .env > 默认值，多层覆盖，来源可追溯 |
| 🎛️ **运行时配置管理** | CLI 内置 `/config`、`/mcp`、`/tools` 命令，支持热修改 |
| 🎯 **事件监听** | 参考 LangChain callbacks 设计，9 个生命周期钩子便于扩展 |
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
```

### 3. 运行

```bash
# 🎮 CLI 交互模式
npm start

# 📝 编程式调用示例
npx tsx examples/run.ts

# 🧪 集成测试（7 个用例，串行执行避免 API 限速）
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
内置工具: [commandRun, fileRead, fileWrite, grep]

Agent> 帮我读取 package.json 的版本号
```

### 内置命令

| 命令 | 说明 |
|---|---|
| `输入问题` | Agent 流式输出 Thought / Action / Observation / Final |
| `/help` | 查看帮助信息 |
| `/reset` `/clear` | 清空多轮对话历史，开始新会话 |
| `/status` | 查看当前会话状态（消息数 / 工具数 / MCP 工具数） |
| `/tools` | 工具管理（list / enable / disable / reload） |
| `/config` | 配置管理（get / set / delete / list / path） |
| `/mcp` | MCP 管理（list / add / remove / reload / test） |
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
│                   Configuration System                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  ConfigLoader│  │  ConfigWriter│  │  MCPManager      │  │
│  │  (分层加载)  │  │  (持久化写入)│  │  (生命周期管理)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                   Built-in Tools                             │
│  commandRun │ fileRead │ fileWrite │ grep                   │
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

### 配置分层加载

```
加载优先级（高 → 低）：
  CLI 参数 > 工作空间配置 (.agent-config.json)
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

## ⚙️ 配置管理

支持多层配置系统，优先级从高到低为：**CLI 参数 > 工作空间配置 > 全局配置 > 环境变量 > 默认值**。

### 配置层级

| 层级 | 文件位置 | 说明 |
|---|---|---|
| CLI 参数 | 运行时传入 | 最高优先级，仅内存中生效 |
| 工作空间 (workspace) | `{项目目录}/.agent-config.json` | 项目级配置，随项目分发 |
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
    "enabled": ["commandRun", "fileRead", "fileWrite", "grep"],
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
    "systemPrompt": null
  }
}
```

### 环境变量（向后兼容）

| 环境变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | API Key | 无 |
| `OPENAI_BASE_URL` | ❌ | 模型服务地址 | `https://api.openai.com/v1` |
| `MODEL_NAME` | ❌ | 模型名称 | `gpt-4o-mini` |
| `MAX_ITERATIONS` | ❌ | Agent 最大迭代次数 | `10` |

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

通过 CLI 内置的 `/config` 命令可直接修改配置（写入 `.agent-config.json`）：

```bash
# 查看当前完整配置及来源
/config list

# 修改模型名称（写入工作空间配置）
/config set model.name deepseek-chat

# 修改最大迭代次数
/config set model.maxIterations 20

# 写入全局配置（跨项目共享）
/config set model.name gpt-4 --global

# 删除某配置项（恢复为上层默认值）
/config delete model.name

# 查看配置文件路径
/config path
```

---

## 🎧 事件监听器

参考 LangChain callbacks 设计，支持 **9 个生命周期钩子**。可叠加任意数量的监听器。

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

---

## 📁 项目结构

```
loop-agent-command/
├── src/
│   ├── index.ts                      # 🚪 CLI 入口（交互式 REPL + 多命令支持）
│   ├── config.ts                     # ⚙️ 环境变量配置加载（遗留）
│   ├── types.ts                      # 📐 核心类型定义（Tool, ChatMessage, AgentEvents 等）
│   ├── agent/
│   │   ├── react-agent.ts            # 🔄 ReAct 主循环（流式版本）
│   │   ├── prompt.ts                 # 📝 System Prompt 构造器
│   │   └── logger.ts                 # 🎨 ConsoleLogger（彩色日志输出，实现 AgentEvents）
│   ├── llm/
│   │   └── client.ts                 # 🤖 LLM 客户端（chat + chatStream + 自动重试）
│   ├── config/                       # ⚙️ 分层配置系统
│   │   ├── index.ts                  # 统一导出
│   │   ├── schema.ts                 # 配置类型定义 + 默认值
│   │   ├── loader.ts                 # 配置加载器（分层合并）
│   │   ├── writer.ts                 # 配置写入器（持久化）
│   │   ├── merge.ts                  # 深度合并工具
│   │   └── mcp-manager.ts            # MCP 生命周期管理器
│   └── tools/
│       ├── index.ts                  # 🛠️ 工具系统聚合入口
│       ├── registry.ts               # 📋 工具注册表（注册/查询/转 OpenAI 格式/MCP 管理）
│       ├── runner.ts                 # ⚡ 工具执行器（超时控制 + 异常捕获）
│       ├── commandRun.ts             # 🖥️ 内置工具：命令执行
│       ├── fileRead.ts               # 📄 内置工具：文件读取
│       ├── fileWrite.ts              # ✏️ 内置工具：文件写入
│       ├── grep.ts                   # 🔍 内置工具：内容检索
│       └── mcp/                      # 🌐 MCP 工具接入
│           ├── index.ts              # 入口
│           ├── client.ts             # MCP 客户端（stdio / SSE 传输）
│           └── adapter.ts            # MCP 工具适配器（转 Tool 接口）
├── examples/
│   └── run.ts                        # 📝 编程式调用示例
├── tests/
│   └── integration/                  # 🧪 集成测试（7 个用例，串行执行）
│       ├── a-no-tool.test.ts         # 无需工具的场景
│       ├── b-single-tool.test.ts     # 单工具调用
│       ├── c-multi-tool.test.ts      # 多工具调用
│       ├── d-tool-failure.test.ts    # 工具执行失败
│       ├── e-unknown-tool.test.ts    # 工具不存在
│       ├── f-max-iterations.test.ts  # 达到最大迭代次数
│       └── g-parallel-tools.test.ts  # 同轮并行工具
├── docs/
│   ├── plan.md                       # 📋 开发总计划与里程碑
│   └── tasks/                        # 📂 逐任务文档（11 个任务）
├── .env                              # 🔒 环境变量（需从 .env.example 复制创建）
├── .env.example                      # 📄 环境变量模板
├── .agent-config.json                # 📋 工作空间配置（可选，运行时生成）
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
| **测试框架** | vitest | 集成测试，串行执行 |
| **构建工具** | tsup | 输出 ESM 格式 |
| **开发工具** | tsx | 开发时直接运行 TypeScript |
| **环境变量** | dotenv | 从 `.env` 加载配置 |

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

### 配置来源追踪

当配置未按预期生效时，可通过 `/config list` 查看每个字段的实际来源（cli / workspace / global / env / default），快速定位是哪一层覆盖了配置。

---

## 📄 License

[MIT](LICENSE) © 2026

---

<div align="center">
  <sub>Built with ❤️ using TypeScript</sub>
</div>