# Task-02：核心类型定义与配置模块

## 需求目标

定义 ReAct Agent 全项目共用的核心类型，并提供从环境变量读取配置的能力，为 LLM 客户端、工具系统、Agent 主循环提供类型契约与运行时配置。

### 目标清单
1. 定义 `src/types.ts`：工具、Agent 步骤、Agent 结果、选项等核心类型
2. 定义 `src/config.ts`：从 `.env` 读取并导出配置对象
3. 保证类型可被所有模块导入复用
4. 配置缺失时抛出明确错误

## 实现方案

### 1. src/types.ts

```typescript
// ===== 工具相关 =====
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// OpenAI function calling 的 tools 参数格式
export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ===== 消息相关 =====
export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: 'stop' | 'tool_calls' | 'length' | string;
}

// ===== Agent 相关 =====
export interface AgentStep {
  thought?: string;
  action?: { tool: string; args: Record<string, unknown> };
  observation?: string;
}

export interface AgentResult {
  answer: string;
  steps: AgentStep[];
  iterations: number;
}

export interface AgentOptions {
  maxIterations?: number;
  temperature?: number;
  model?: string;
  verbose?: boolean;
}
```

### 2. src/config.ts

```typescript
import 'dotenv/config';

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`环境变量 ${key} 未设置，请检查 .env`);
  return v;
}

export const config = {
  openaiApiKey: required('OPENAI_API_KEY'),
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  modelName: process.env.MODEL_NAME ?? 'gpt-4o-mini',
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 10),
};
```

### 3. 实现要点

- 所有类型集中放 `types.ts`，使用 `export interface/type`
- `ChatMessage` 使用联合类型区分有无 tool_calls 的 assistant 消息
- `config.ts` 在模块加载时调用 `dotenv/config`
- 必填项用 `required()` 校验，缺省给出明确错误

## 验收测试清单

- [x] 项1：`src/types.ts` 导出 Tool / OpenAIToolDef / ChatMessage / ToolCall / LLMResponse / AgentStep / AgentResult / AgentOptions 8 个核心类型
- [x] 项2：`src/config.ts` 导出 `config` 对象，包含 openaiApiKey / openaiBaseUrl / modelName / maxIterations 4 个字段
- [x] 项3：缺少 `OPENAI_API_KEY` 时，`config.ts` 抛出明确错误信息（`required()` 函数 `if (!v) throw` 逻辑已通过 inline 测试验证：空字符串触发 "环境变量 X 未设置" 错误）
- [x] 项4：未设置 `OPENAI_BASE_URL` 时，默认 `https://api.openai.com/v1`（代码 `process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'` 保证）
- [x] 项5：未设置 `MODEL_NAME` 时，默认 `gpt-4o-mini`（代码 `process.env.MODEL_NAME ?? 'gpt-4o-mini'` 保证）
- [x] 项6：未设置 `MAX_ITERATIONS` 时，默认 10（数字类型，`number()` 函数处理）
- [x] 项7：`npm run typecheck` 通过，无类型错误
- [x] 项8：临时脚本 `import { config } from './src/config'` 已验证能正确打印配置（脚本验证后已删除）
- [x] 项9：类型可被其他模块正确导入使用（typecheck 通过 + ESM `.js` 后缀导入规范）

## 验证记录

```
===== Config 验证 =====
openaiApiKey: sk-skj***
openaiBaseUrl: http://192.168.1.155:23620/v1
modelName: gpt-4o-mini
maxIterations: 10 (类型: number)
```

## 状态

- 状态：已完成
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-01
- 备注：`.env` 已配置用户提供的模型地址 `http://192.168.1.155:23620/v1` 与 API Key

> 完成时同步更新 plan.md 状态汇总表与本文件验收清单。
