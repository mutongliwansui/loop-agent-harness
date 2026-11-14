# Task-03：LLM 客户端封装

## 需求目标

封装 OpenAI 官方 SDK，提供统一的 `chat()` 方法供 ReAct Agent 调用，支持自定义 baseURL（兼容 DeepSeek/Moonshot/本地 vLLM）、工具调用参数、流式输出，并具备错误处理能力。

### 目标清单
1. 实现 `src/llm/client.ts`：封装 `OpenAI` 客户端实例
2. 提供 `chat(messages, tools?, options?)` 方法
3. 将 SDK 响应转换为项目统一的 `LLMResponse` 类型
4. 支持流式（`chatStream`）与非流式两种模式
5. 网络错误 / 速率限制的简单重试机制
6. 从 `config` 读取 apiKey / baseURL / model

## 实现方案

### 1. 模块结构

```typescript
// src/llm/client.ts
import OpenAI from 'openai';
import { config } from '../config.js';
import type { ChatMessage, LLMResponse, OpenAIToolDef } from '../types.js';

export interface ChatOptions {
  temperature?: number;
  model?: string;
  maxTokens?: number;
}

export class LLMClient {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
    });
  }

  async chat(
    messages: ChatMessage[],
    tools?: OpenAIToolDef[],
    options: ChatOptions = {}
  ): Promise<LLMResponse> { /* ... */ }

  async *chatStream(
    messages: ChatMessage[],
    tools?: OpenAIToolDef[],
    options: ChatOptions = {}
  ): AsyncGenerator<string> { /* ... */ }
}

export const llm = new LLMClient();
```

### 2. chat() 实现要点

- 调用 `this.client.chat.completions.create()`
- 传入 `model`（默认 `config.modelName`）、`messages`、`tools`、`tool_choice: 'auto'`
- 取 `choices[0].message`，映射为 `LLMResponse`：
  - `content` ← `message.content`
  - `tool_calls` ← `message.tool_calls`（如有）
  - `finish_reason` ← `choices[0].finish_reason`
- 包裹 try/catch，遇到错误调用 `retry()`

### 3. 重试机制

```typescript
private async retry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      await sleep(1000 * (i + 1)); // 指数退避 1s/2s
    }
  }
  throw new Error('unreachable');
}
```

- 仅对网络错误 / 429 速率限制重试
- 4xx（除 429）不重试，直接抛出

### 4. 流式实现（方案 B：完整支持 tool_calls）

- `AsyncGenerator<StreamChunk>` 产出 4 种 chunk：
  - `delta`：文本片段（逐 token）
  - `toolCallStart`：新 tool_call 首次出现（带 index/id/name）
  - `toolCallDelta`：tool_call arguments 增量片段
  - `done`：流结束，携带完整 LLMResponse（含累积后的 content/tool_calls）
- 用 `Map<index, {id, name, arguments}>` 按 index 累积 tool_calls 分片
- 最后组装成完整 ToolCall[]，按 index 排序

> **为什么支持流式 tool_calls**：OpenAI 流式协议会把 `tool_call.arguments` 拆成多个 chunk，需按 `index` 累积拼接，最后才能得到可 JSON.parse 的完整字符串。方案 A 只 yield content 会丢失 tool_calls，导致 ReAct 循环无法用流式。

### 5. 错误处理

- API key 无效（401）：抛出"API Key 无效，请检查 .env"
- 模型不存在（404）：抛出"模型不存在"
- 速率限制（429）：重试 + 退避
- 网络错误：重试

## 验收测试清单

- [x] 项1：`LLMClient` 类已实现，构造函数从 config 读取 apiKey / baseURL
- [x] 项2：`chat()` 接受 messages + 可选 tools + 可选 options 参数
- [x] 项3：`chat()` 返回 `LLMResponse` 类型，包含 content / tool_calls / finish_reason
- [x] 项4：无 tools 调用时，`finish_reason` 为 'stop'，content 有内容（实测：DeepSeek 返回 "我是DeepSeek，一个智能AI助手。"）
- [x] 项5：有 tools 调用时，`finish_reason` 为 'tool_calls'，`tool_calls` 数组非空（实测：触发 calculator 工具）
- [x] 项6：`tool_calls[i].function.arguments` 是合法 JSON 字符串（实测：`{"expression": "23 * 17"}` 可被 JSON.parse）
- [x] 项7：`chatStream()` 返回 `AsyncGenerator<StreamChunk>`，产出 delta / toolCallStart / toolCallDelta / done 四种 chunk（实测：同轮触发 calculator + fileRead 两个 tool_call，arguments 正确拼接，均可 JSON.parse）
- [x] 项8：API Key 错误时抛出明确中文错误提示（`wrapError()` 对 401 返回 "API Key 无效或已过期..."）
- [x] 项9：网络错误时重试 2 次后抛出原错误（`retry()` 函数 `retries=2`，非 APIError 默认可重试）
- [x] 项10：429 速率限制时执行退避重试（`isRetryable()` 对 429 返回 true，指数退避 1s/2s）
- [x] 项11：切换 `OPENAI_BASE_URL` 后可调用其他兼容服务商（实测：`http://192.168.1.155:23620/v1` 调用成功，模型 `deepseek-v4-flash`）
- [x] 项12：`npm run typecheck` 通过

## 验证记录

```
===== 测试1：单轮对话（无工具）=====
finish_reason: stop
content: 我是DeepSeek，一个智能AI助手。
tool_calls: 无

===== 测试2：带工具调用（非流式）=====
finish_reason: tool_calls
content:
tool_call: calculator {"expression": "23 * 17"}
parsed args: { expression: '23 * 17' }

===== 测试3：流式 tool_calls（方案 B）=====
[toolCallStart] index=0 id=call_37aa... name=calculator
{"expression": "23 * 17"}
[toolCallStart] index=1 id=call_7c18... name=fileRead
{"path": "./package.json"}
[done] 流结束

done 中的完整 LLMResponse:
finish_reason: tool_calls
tool_calls 数量: 2
  - calculator: arguments={"expression": "23 * 17"} parsed OK
  - fileRead:   arguments={"path": "./package.json"} parsed OK
```

## 状态

- 状态：已完成
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-02
- 备注：
  - 已接入用户提供的本地模型服务（deepseek-v4-flash @ 192.168.1.155:23620）
  - chatStream 已升级为方案 B：完整支持 tool_calls 分片拼接，可被 ReAct 主循环复用

> 完成时同步更新 plan.md 状态汇总表与本文件验收清单。
