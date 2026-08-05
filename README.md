# ReAct Agent

基于 ReAct（Reasoning + Acting）框架的智能 Agent，采用 OpenAI 协议接入模型，通过 Function Call 实现工具调用，使用 TypeScript 开发。

## 特性

- **ReAct 循环**：Thought → Action → Observation 逐步推理，直到得出最终答案
- **流式输出**：LLM 推理过程实时流式输出，支持 `content` 与 `tool_calls` 分片拼接
- **OpenAI 协议**：兼容任意 OpenAI 协议服务商（OpenAI、DeepSeek、本地部署等）
- **内置工具**：命令执行、文件读取（支持行范围）、文件写入、内容检索（grep）
- **MCP 接入**：支持通过 Model Context Protocol 接入外部工具服务
- **事件监听**：参考 LangChain callbacks 设计，9 个生命周期钩子便于扩展
- **多轮对话**：跨 `run()` 调用持久化消息历史，支持上下文续接
- **同轮多工具**：支持 LLM 单轮返回多个 `tool_calls`，`Promise.all` 并发执行

## 架构

```
┌─────────────────────────────────────────────────┐
│                    CLI / API                     │
│                  (src/index.ts)                   │
├─────────────────────────────────────────────────┤
│                  ReAct Agent                      │
│                (react-agent.ts)                   │
│   ┌───────────┐  ┌──────────┐  ┌────────────┐  │
│   │  Prompt    │  │  Events  │  │  ChatHistory│  │
│   │ (prompt.ts)│  │ (logger) │  │ (多轮持久化)│  │
│   └───────────┘  └──────────┘  └────────────┘  │
├─────────────────────────────────────────────────┤
│                   LLM Client                      │
│                 (llm/client.ts)                  │
│         chat() / chatStream() + 重试             │
├─────────────────────────────────────────────────┤
│                  Tool System                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Registry  │  │  Runner  │  │ MCP Adapter  │  │
│  │(注册/查询)│  │(执行/超时)│  │(外部工具适配)│  │
│  └──────────┘  └──────────┘  └──────────────┘  │
├─────────────────────────────────────────────────┤
│                  Built-in Tools                   │
│  commandRun │ fileRead │ fileWrite │ grep        │
└─────────────────────────────────────────────────┘
```

## 快速开始

### 1. 安装

```bash
git clone <repo-url> loop-agent-command
cd loop-agent-command
npm install
```

### 2. 配置

创建 `.env` 文件：

```env
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=http://192.168.1.155:23620/v1
MODEL_NAME=deepseek-v4-flash
MAX_ITERATIONS=10
```

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `OPENAI_API_KEY` | API Key（必填） | 无 |
| `OPENAI_BASE_URL` | 模型服务地址 | `https://api.openai.com/v1` |
| `MODEL_NAME` | 模型名称 | `gpt-4o-mini` |
| `MAX_ITERATIONS` | Agent 最大迭代次数 | `10` |

### 3. 运行

```bash
# CLI 交互模式
npm start

# 编程式调用示例
npx tsx examples/run.ts

# 集成测试
npm test

# 类型检查
npm run typecheck

# 构建
npm run build
```

## CLI 使用

```bash
npm start
```

启动后进入交互式 REPL：

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃            ReAct Agent 交互式控制台                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

模型: deepseek-v4-flash
内置工具: [commandRun, fileRead, fileWrite, grep]

Agent> 帮我读取 package.json 的版本号
```

### 命令

| 命令 | 说明 |
|---|---|
| 输入问题 | Agent 流式输出 Thought / Action / Observation / Final |
| `/help` | 查看帮助 |
| `/reset` `/clear` | 清空多轮对话历史 |
| `/status` | 查看当前会话状态 |
| `/tools` | 列出所有可用工具 |
| `exit` `quit` `退出` | 退出程序（Ctrl+C 同样有效） |

## 编程式调用

```typescript
import { agent } from './src/agent/react-agent.js';
import { registerBuiltinTools } from './src/tools/index.js';

// 1. 注册内置工具
registerBuiltinTools();

// 2. 单次调用
const result = await agent.run('帮我读取 package.json 的版本号', {
  verbose: true,       // 输出 Thought/Action/Observation 日志
  resetHistory: true,  // 清空历史，开始新会话
});

console.log(result.answer);
console.log(`迭代: ${result.iterations}, 步骤: ${result.steps.length}`);

// 3. 多轮对话（自动复用历史）
const result2 = await agent.run('那它的名称是什么？');
// Agent 会从上一轮的 package.json 内容中回答，无需再次调用工具
```

### 自定义事件监听

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

const myListener: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[工具开始] ${tool}`, args);
  },
  onToolEnd: (tool, result) => {
    console.log(`[工具完成] ${tool} → ${result.slice(0, 100)}...`);
  },
  onFinal: (answer) => {
    console.log(`[最终答案] ${answer}`);
  },
};

const result = await agent.run('搜索 src 目录中的 config', {
  verbose: false,
  events: [myListener],
});
```

## 内置工具

| 工具 | 说明 |
|---|---|
| `commandRun` | 在本地执行 shell 命令，返回 stdout + stderr |
| `fileRead` | 读取文件内容，支持 `startLine`/`endLine` 按行范围部分读取 |
| `fileWrite` | 写入文件内容，支持创建或覆盖 |
| `grep` | 在文件或目录中检索内容（模仿 grep），支持正则、忽略大小写、递归搜索 |

## 工具扩展

### 新增自定义工具

```typescript
import type { Tool } from './src/types.js';
import { registry } from './src/tools/registry.js';

const myTool: Tool = {
  name: 'myTool',
  description: '我的自定义工具',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
  },
  async execute(args) {
    return `处理结果: ${args.input}`;
  },
};

registry.register(myTool);
```

### 接入 MCP 外部工具

创建 `.mcp.json` 配置文件：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

或编程式接入：

```typescript
import { registry } from './src/tools/registry.js';

await registry.registerMCPServer('filesystem', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
});

// MCP 工具名自动加前缀：filesystem__read_file
```

## 事件监听器

参考 LangChain callbacks 设计，支持以下 9 个生命周期钩子：

| 钩子 | 触发时机 |
|---|---|
| `onStart(input)` | Agent 开始执行 |
| `onLLMStart(messages, iteration)` | 每轮 LLM 调用前 |
| `onLLMStream(delta)` | LLM 流式输出文本片段 |
| `onLLMEnd(response, iteration)` | 每轮 LLM 调用结束 |
| `onToolStart(tool, args)` | 工具开始执行 |
| `onToolEnd(tool, result)` | 工具执行结束 |
| `onFinal(answer)` | Agent 给出最终答案 |
| `onError(error)` | 发生错误 |
| `onEnd(result)` | Agent 执行结束 |

可叠加任意数量的监听器，通过 `events` 选项传入：

```typescript
await agent.run(input, { events: [logger, metricsCollector, auditLog] });
```

## 项目结构

```
loop-agent-command/
├── src/
│   ├── agent/
│   │   ├── react-agent.ts    # ReAct 主循环
│   │   ├── prompt.ts         # System Prompt 构造
│   │   └── logger.ts        # ConsoleLogger（实现 AgentEvents）
│   ├── llm/
│   │   └── client.ts         # LLM 客户端（chat + chatStream + 重试）
│   ├── tools/
│   │   ├── registry.ts       # 工具注册表
│   │   ├── runner.ts         # 工具执行器（超时 + 异常捕获）
│   │   ├── commandRun.ts     # 内置工具：命令执行
│   │   ├── fileRead.ts       # 内置工具：文件读取
│   │   ├── fileWrite.ts      # 内置工具：文件写入
│   │   ├── grep.ts           # 内置工具：内容检索
│   │   ├── index.ts          # 工具系统入口
│   │   └── mcp/              # MCP 工具接入
│   │       ├── client.ts     # MCP 客户端
│   │       ├── adapter.ts    # MCP 工具适配器
│   │       └── loader.ts     # .mcp.json 加载器
│   ├── config.ts             # 环境变量配置
│   ├── types.ts              # 核心类型定义
│   └── index.ts              # CLI 入口
├── examples/
│   └── run.ts                # 编程式调用示例（3 个场景）
├── tests/
│   └── integration/          # 集成测试（7 个用例）
├── docs/
│   ├── plan.md               # 总计划与文档
│   └── tasks/                # 任务文档
├── .env                      # 环境变量（需创建）
├── .mcp.json                 # MCP 配置（可选）
├── vitest.config.ts          # 测试配置
├── tsconfig.json             # TypeScript 配置
└── package.json
```

## 故障排查

### API Key 无效或已过期

检查 `.env` 中 `OPENAI_API_KEY` 是否正确，是否与 `OPENAI_BASE_URL` 对应的服务商匹配。

### 模型不存在（404）

确认 `MODEL_NAME` 在目标服务商上可用。不同服务商模型名不同。

### 请求过于频繁（429）

降低调用频率。集成测试默认串行执行（`fileParallelism: false`）避免并发限速。

### 工具执行超时

`commandRun` 工具默认 30s 超时，可通过 `timeout` 参数调整。复杂命令建议拆分多步执行。

### Windows 终端中文乱码

CLI 启动时已自动执行 `chcp 65001` 切换到 UTF-8。如仍乱码，手动运行 `chcp 65001` 后再启动。

### 达到最大迭代次数

增大 `.env` 中 `MAX_ITERATIONS`，或通过 `agent.run(input, { maxIterations: 20 })` 单次覆盖。

## 技术栈

- **语言**：TypeScript（strict 模式）
- **运行时**：Node.js（原生 ESM）
- **LLM SDK**：openai（兼容任意 OpenAI 协议服务商）
- **MCP SDK**：@modelcontextprotocol/sdk
- **测试**：vitest
- **构建**：tsup

## License

MIT
