# ReAct Agent 开发总计划

## 一、项目概述

基于 OpenAI 协议与 Function Calling 实现一个 ReAct（Reasoning + Acting）Agent，支持 Thought / Action / Observation 循环推理，可接入任意 OpenAI 协议兼容模型（OpenAI、DeepSeek、Moonshot、本地 vLLM 等）。

## 二、技术选型

| 项目 | 选型 |
|---|---|
| 语言 | TypeScript 5.x（strict） |
| 运行时 | Node.js 18+ |
| LLM SDK | `openai` 官方 SDK |
| 工具调用 | OpenAI Function Calling |
| 包管理 | pnpm |
| 构建工具 | tsx（开发）/ tsup（构建） |

## 三、目录结构

```
loop-agent-command/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── docs/                         # 任务文档
│   ├── plan.md
│   └── tasks/
├── src/
│   ├── index.ts                  # CLI 入口
│   ├── config.ts                 # 环境配置
│   ├── types.ts                  # 核心类型
│   ├── llm/
│   │   └── client.ts             # OpenAI 客户端封装
│   ├── tools/
│   │   ├── registry.ts           # 工具注册表
│   │   ├── runner.ts             # 工具执行器
│   │   ├── calculator.ts         # 计算器
│   │   ├── weather.ts            # 天气查询
│   │   └── webSearch.ts          # 网页搜索
│   ├── agent/
│   │   ├── react-agent.ts        # ReAct 主循环
│   │   ├── prompt.ts             # System Prompt
│   │   └── logger.ts             # 执行日志
│   └── utils/
│       └── stream.ts             # 流式输出
└── examples/
    └── run.ts                    # 使用示例
```

## 四、任务拆解与依赖关系

| 编号 | 任务 | 依赖 | 优先级 |
|---|---|---|---|
| Task-01 | 项目初始化与依赖安装（已完成，改用 npm） | 无 | 高 |
| Task-02 | 核心类型定义与配置模块 | Task-01 | 高 |
| Task-03 | LLM 客户端封装 | Task-02 | 高 |
| Task-04 | 工具系统（Registry + Runner） | Task-02 | 高 |
| Task-05 | 内置工具实现（commandRun/fileRead/fileWrite/grep） | Task-04 | 中 |
| Task-05-1 | MCP Tool 接入（外部工具服务器接入） | Task-04、Task-05 | 中 |
| Task-06 | ReAct 主循环 | Task-03、Task-04 | 高 |
| Task-07 | System Prompt 与执行日志 | Task-06 | 中 |
| Task-08 | CLI 入口与示例 | Task-06、Task-07 | 中 |
| Task-09 | 集成测试与文档完善 | Task-08 | 中 |

### 依赖图

```
Task-01 ──▶ Task-02 ──┬──▶ Task-03 ──┐
                      └──▶ Task-04 ──┼──▶ Task-06 ──▶ Task-07 ──▶ Task-08 ──▶ Task-09
                            ▲         │                  │
                            └Task-05──┘                  │
                               │
                               └──▶ Task-05-1（MCP 接入，可与 Task-06+ 并行）
```

## 五、整体里程碑

- **M1 基础框架**：Task-01 ~ Task-02 完成，项目可编译运行空壳
- **M2 LLM 接入**：Task-03 完成，可调用 LLM 进行单轮对话
- **M3 工具系统**：Task-04 ~ Task-05 完成，工具可注册执行
- **M4 ReAct 闭环**：Task-06 ~ Task-07 完成，Agent 可完成多轮推理
- **M5 可交付**：Task-08 ~ Task-09 完成，CLI 可用、文档齐全
- **M6 生态扩展**：Task-05-1 完成，支持 MCP 外部工具接入

## 六、验收标准（整体）

1. `pnpm dev` 可启动 CLI 交互
2. 输入多步推理问题（如"北京天气 + 23*17"），Agent 能正确调用多个工具并综合回答
3. 单轮问题（无需工具）能直接回答
4. 工具调用失败时 Agent 能换思路或报错退出
5. 达到最大迭代次数能优雅退出并返回已推理内容

## 七、状态汇总

| 任务 | 状态 | 完成时间 |
|---|---|---|
| Task-01 项目初始化 | 已完成 | 2026-08-04 |
| Task-02 类型与配置 | 已完成 | 2026-08-04 |
| Task-03 LLM 客户端 | 已完成 | 2026-08-04 |
| Task-04 工具系统 | 已完成 | 2026-08-04 |
| Task-05 内置工具 | 已完成 | 2026-08-04 |
| Task-05-1 MCP 接入 | 已完成 | 2026-08-04 |
| Task-06 ReAct 主循环 | 已完成 | 2026-08-04 |
| Task-07 Prompt 与日志 | 已完成 | 2026-08-04 |
| Task-08 CLI 入口 | 已完成 | 2026-08-05 |
| Task-09 集成测试 | 已完成 | 2026-08-05 |

> 状态说明：未开始 / 进行中 / 已完成。每个任务完成时同步更新本表与对应任务文档。

> **Task-01 ~ Task-09 全部完成。以下为新增扩展任务。**

| Task-10 配置存储管理 | 未开始 | - |
| Task-11 会话持久化存储 | 未开始 | - |
| Task-12 Skill 能力集成 | 未开始 | - |

## 八、快速开始

### 1. 安装

```bash
git clone <repo-url> loop-agent-command
cd loop-agent-command
npm install
```

### 2. 配置

复制 `.env.example` 为 `.env`，填入配置：

```bash
cp .env.example .env
```

```env
OPENAI_API_KEY=sk-your-api-key
OPENAI_BASE_URL=http://192.168.1.155:23620/v1
MODEL_NAME=deepseek-v4-flash
MAX_ITERATIONS=10
```

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

## 九、配置说明

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `OPENAI_API_KEY` | API Key（必填） | 无 |
| `OPENAI_BASE_URL` | 模型服务地址 | `https://api.openai.com/v1` |
| `MODEL_NAME` | 模型名称 | `gpt-4o-mini` |
| `MAX_ITERATIONS` | Agent 最大迭代次数 | `10` |

MCP 工具配置（可选）：在工作空间 `.agent-config.json` 或全局 `~/.loop-agent/config.json` 的 `tools.mcpServers` 中配置外部 MCP server（详见 Task-10）。

## 十、工具扩展指南

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

```typescript
import { registry } from './src/tools/registry.js';

await registry.registerMCPServer('my-server', {
  type: 'stdio',
  command: 'npx',
  args: ['my-mcp-server'],
});
```

工具名会自动加 `my-server__` 前缀。

## 十一、故障排查

### 1. API Key 无效或已过期

```
错误：API Key 无效或已过期，请检查 .env 中的 OPENAI_API_KEY
```

**解决**：检查 `.env` 中 `OPENAI_API_KEY` 是否正确，是否与 `OPENAI_BASE_URL` 对应的服务商匹配。

### 2. 模型不存在（404）

```
错误：模型不存在（404），请检查 .env 中的 MODEL_NAME
```

**解决**：确认 `MODEL_NAME` 在目标服务商上可用。不同服务商模型名不同。

### 3. 请求过于频繁（429）

```
错误：请求过于频繁（429），请稍后重试
```

**解决**：降低调用频率，或增大 `MAX_ITERATIONS` 让 Agent 在单次运行内完成更多步骤，减少外部调用次数。集成测试默认串行执行（`fileParallelism: false`）避免并发限速。

### 4. 工具执行超时

```
错误：工具执行超时 (30000ms)
```

**解决**：`commandRun` 工具默认 30s 超时，可通过 `timeout` 参数调整。复杂命令建议拆分为多步执行。

### 5. Windows 终端中文乱码

**解决**：CLI 启动时已自动执行 `chcp 65001` 切换到 UTF-8。如仍乱码，手动运行 `chcp 65001` 后再启动。

### 6. 达到最大迭代次数

```
错误：达到最大迭代次数 10，Agent 未能给出最终答案
```

**解决**：增大 `.env` 中 `MAX_ITERATIONS`，或简化问题让 Agent 在更少步骤内完成。可通过 `agent.run(input, { maxIterations: 20 })` 单次覆盖。
