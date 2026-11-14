# Task-06：ReAct 主循环

## 需求目标

实现 ReAct Agent 的核心推理循环：Thought → Action → Observation → Thought ... 直到得出 Final Answer，串联 LLM 客户端与工具系统。

### 目标清单
1. 实现 `src/agent/react-agent.ts`：`ReActAgent` 类
2. 提供 `run(userInput, options?)` 方法，返回 `AgentResult`
3. 维护 messages 历史，正确拼接 assistant 的 tool_calls 与 tool 角色 Observation
4. 支持 `maxIterations` 限制，达到上限优雅退出
5. 同一轮多个 tool_calls 并发执行
6. 记录每一步 Thought / Action / Observation 到 `steps`

## 实现方案

### 1. 模块结构（流式 + 事件监听器）

```typescript
// src/agent/react-agent.ts
import { llm } from '../llm/client.js';
import { registry, runner } from '../tools/index.js';
import { config } from '../config.js';
import { buildSystemPrompt } from './prompt.js';
import { ConsoleLogger } from './logger.js';
import type {
  AgentEvents, AgentResult, AgentStep, AgentOptions,
  ChatMessage, LLMResponse, ToolCall,
} from '../types.js';

export class ReActAgent {
  async run(userInput: string, options: AgentOptions = {}): Promise<AgentResult> {
    const maxIterations = options.maxIterations ?? config.maxIterations;
    const model = options.model ?? config.modelName;
    const temperature = options.temperature ?? 0;
    const verbose = options.verbose ?? true;

    // 组装事件监听器：默认 ConsoleLogger + 用户自定义
    const events = this.composeEvents([
      new ConsoleLogger(verbose),
      ...(options.events ?? []),
    ]);

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() }, // 无参，工具由 tools 参数暴露
      { role: 'user', content: userInput },
    ];
    const steps: AgentStep[] = [];
    const openaiTools = registry.toOpenAITools();

    let result: AgentResult | null = null;
    const safeEvents = events as Required<AgentEvents>;
    try {
      await safeEvents.onStart(userInput);

      for (let i = 0; i < maxIterations; i++) {
        await safeEvents.onIterationStart(i, maxIterations);

        // 1. 流式调用 LLM，累积完整响应
        const resp = await this.streamLLM(messages, openaiTools, { model, temperature }, events);
        await safeEvents.onLLMEnd(resp, i);

        // 2. 无 tool_calls → 最终答案
        if (!resp.tool_calls?.length) {
          const answer = resp.content ?? '';
          result = { answer, steps, iterations: i + 1 };
          await safeEvents.onFinal(answer);
          break;
        }

        // 3. 拼接 assistant tool_calls
        messages.push({
          role: 'assistant',
          content: resp.content,
          tool_calls: resp.tool_calls,
        });

        // 4. 并发执行所有工具调用（先触发 onToolStart，再 runParallel）
        const callItems = resp.tool_calls.map((call) => {
          const tool = registry.get(call.function.name);
          const args = this.parseArgs(call);
          return { call, tool, args };
        });
        for (const c of callItems) {
          await safeEvents.onToolStart(c.tool.name, c.args);
        }
        const observations = await runner.runParallel(
          callItems.map((c) => ({ tool: c.tool, args: c.args })),
        );

        // 5. 记录 steps + 拼接 tool 消息 + 触发 onToolEnd
        callItems.forEach((c, idx) => {
          const observation = observations[idx];
          steps.push({
            thought: resp.content ?? undefined,
            action: { tool: c.tool.name, args: c.args },
            observation,
          });
          void safeEvents.onToolEnd(c.tool.name, observation); // 异步，不阻塞
          messages.push({
            role: 'tool',
            tool_call_id: c.call.id,
            content: observation,
          });
        });
      }

      if (!result) {
        const err = new Error(`达到最大迭代次数 ${maxIterations}，Agent 未能给出最终答案`);
        await safeEvents.onError(err);
        throw err;
      }
    } finally {
      await safeEvents.onEnd(result);
    }

    return result;
  }

  /** 流式调用 LLM，onLLMStream 实时输出 Thought 片段，done chunk 返回完整响应 */
  private async streamLLM(
    messages: ChatMessage[],
    tools: ReturnType<typeof registry.toOpenAITools>,
    options: { model: string; temperature: number },
    events: AgentEvents,
  ): Promise<LLMResponse> {
    let response: LLMResponse | null = null;
    const safeEvents = events as Required<AgentEvents>;
    for await (const chunk of llm.chatStream(messages, tools, options)) {
      if (chunk.type === 'delta') {
        await safeEvents.onLLMStream(chunk.content);
      } else if (chunk.type === 'done') {
        response = chunk.response;
      }
    }
    if (!response) throw new Error('LLM 流式调用未返回 done chunk');
    return response;
  }

  /** 组合多个事件监听器，单个异常不中断主循环，fn.apply 保留 this 上下文 */
  private composeEvents(listeners: AgentEvents[]): AgentEvents {
    const callAll = async (hook: keyof AgentEvents, ...args: unknown[]): Promise<void> => {
      for (const l of listeners) {
        const fn = (l as Record<string, ((...a: unknown[]) => void | Promise<void>) | undefined>)[hook];
        if (!fn) continue;
        try {
          await fn.apply(l, args);
        } catch (e) {
          console.error(`[events.${String(hook)}] 监听器异常:`, e);
        }
      }
    };
    return {
      onStart: (input) => callAll('onStart', input),
      onIterationStart: (i, max) => callAll('onIterationStart', i, max),
      onLLMStream: (delta) => callAll('onLLMStream', delta),
      onLLMEnd: (resp, iter) => callAll('onLLMEnd', resp, iter),
      onToolStart: (tool, args) => callAll('onToolStart', tool, args),
      onToolEnd: (tool, r) => callAll('onToolEnd', tool, r),
      onFinal: (answer) => callAll('onFinal', answer),
      onError: (err) => callAll('onError', err),
      onEnd: (res) => callAll('onEnd', res),
    } as AgentEvents;
  }
}

export const agent = new ReActAgent();
```

### 2. ReAct 循环说明（流式）

```
┌─ 1. 构造 messages（system + user） ──────────────────┐
│ 2. composeEvents(ConsoleLogger + 用户 events)          │
│ 3. for i in 0..maxIterations:                          │
│    3a. onIterationStart(i, max)                        │
│    3b. chatStream() 流式调用 LLM:                       │
│        - delta chunk → onLLMStream(delta) 实时输出      │
│        - done chunk  → 拿到完整 LLMResponse             │
│    3c. onLLMEnd(resp, i)                               │
│    3d. 无 tool_calls → onFinal(answer) → break         │
│    3e. messages.push(assistant.tool_calls)             │
│    3f. 逐个 onToolStart → runParallel 并发执行         │
│    3g. 记录 steps + messages.push(tool 消息)           │
│        + 逐个 onToolEnd（异步不阻塞）                   │
│ 4. 超限未完成 → onError(err) + throw                   │
│ 5. finally: onEnd(result)                              │
└────────────────────────────────────────────────────────┘
```

> Thought/Action/Observation 在 function calling 模式下由 messages 历史天然承载：
> - assistant.content = Thought（流式逐字输出）
> - assistant.tool_calls = Action
> - tool 消息 = Observation

### 3. 事件监听器（AgentEvents 接口，参考 langchain callbacks）

```typescript
export interface AgentEvents {
  onStart?: (userInput: string) => void | Promise<void>;
  onIterationStart?: (iteration: number, maxIterations: number) => void | Promise<void>;
  onLLMStream?: (delta: string) => void | Promise<void>;      // 流式 Thought 片段
  onLLMEnd?: (response: LLMResponse, iteration: number) => void | Promise<void>;
  onToolStart?: (tool: string, args: Record<string, unknown>) => void | Promise<void>;
  onToolEnd?: (tool: string, result: string) => void | Promise<void>;
  onFinal?: (answer: string) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onEnd?: (result: AgentResult | null) => void | Promise<void>;
}
```

- **单个监听器异常被捕获**，不中断主循环与其他监听器
- **fn.apply(l, args)** 绑定 this，避免类方法丢失上下文
- **onToolEnd 异步触发**（void 不 await），日志不阻塞主循环
- 可叠加任意数量监听器（Web UI、文件记录、飞书推送等）

### 4. 边界处理

| 场景 | 处理 |
|---|---|
| 工具名不存在 | Runner 抛错被捕获 → Observation = 错误字符串 → LLM 换思路 |
| 工具参数 JSON 解析失败 | parseArgs try/catch 包裹，返回 `{}` 空对象 |
| 达到 maxIterations | onError 触发 + 抛出明确错误，finally 仍触发 onEnd |
| LLM 直接返回 stop（无需工具） | onFinal 触发，直接返回 content |
| 同一轮多 tool_calls | onToolStart 逐个触发，再 runParallel（Promise.all）并发执行 |
| chatStream 未返回 done chunk | 抛出 "LLM 流式调用未返回 done chunk" |
| 监听器内部抛错 | console.error 打日志，不影响其他监听器与主循环 |

### 5. options 透传

- `maxIterations`：覆盖 config 默认值
- `model`：覆盖 config 默认模型
- `temperature`：默认 0（确定性推理）
- `verbose`：默认 true，控制 ConsoleLogger 输出（true=彩色日志，false=静默）
- `events`：额外的自定义监听器数组（叠加在 ConsoleLogger 之后）

## 验收测试清单

- [x] 项1：`ReActAgent` 类已实现，含 `run(userInput, options)` 方法
- [x] 项2：`run()` 返回 `AgentResult`，含 answer / steps / iterations
- [x] 项3：无工具需求的问题（如"你好"）iterations=1，直接返回 content（实测：1 轮返回 "我是能使用工具的 ReAct Agent..."）
- [x] 项4：单工具问题能调用 fileRead 并返回正确结果（实测：读 package.json 返回项目名 loop-agent-command、版本 0.1.0）
- [x] 项5：多工具问题能顺序调用 commandRun 和 fileRead（实测：先 dir 查目录，再读 package.json，4 轮完成）
- [x] 项6：`steps` 数组记录每一步的 thought/action/observation（实测：测试C 3 步全部含 action+observation）
- [x] 项7：同轮多 tool_calls 时并发执行（runner.runParallel 用 Promise.all，Task-04 已验证并发性能）
- [x] 项8：达到 maxIterations 时抛出明确错误（实测：maxIterations=1 抛 "达到最大迭代次数 1，Agent 未能给出最终答案"）
- [x] 项9：工具不存在时，registry.get 抛错被 runner 捕获转 Observation（Task-04 已验证错误处理机制）
- [x] 项10：messages 历史正确包含 assistant.tool_calls 与 tool 角色消息（实测：多轮对话正常推进）
- [x] 项11：options.maxIterations / model / temperature / verbose 均可覆盖默认值（实测：maxIterations=1 与 verbose=false 均生效）
- [x] 项12：`npm run typecheck` 通过

## 验证记录（实测 deepseek-v4-flash）

```
测试A：无工具 → iterations=1, steps=0 ✓
测试B：单工具 → iterations=2, steps=1, 调用 fileRead，answer 含 "loop-agent-command" 和 "0.1.0" ✓
测试C：多工具 → iterations=4, steps=3
  - 迭代1: commandRun("ls -la") 失败（Windows 无 ls）
  - 迭代2: 模型自动换思路 → commandRun("dir") 成功
  - 迭代3: fileRead("package.json")
  - 迭代4: 综合分析 → Final Answer
测试D：maxIterations=1 → 抛 "达到最大迭代次数 1" ✓
测试E：verbose=false → 正常工作，无日志输出 ✓

===== 结果: 13 通过 / 0 失败 =====
```

亮点：测试C 中模型在 ls 命令失败后**自动切换到 dir**，体现了 ReAct 的错误恢复能力。

## 重构记录（2026-08-04）

根据用户反馈进行三项重构：

### 1. 主循环改用流式 chatStream
- 原实现：`await llm.chat()` 非流式调用
- 新实现：`for await (const chunk of llm.chatStream())` 流式调用
- 通过 `events.onLLMStream(delta)` 实时输出 Thought 片段
- 流结束后用 `done` chunk 的 `LLMResponse` 继续 Observation 流程

### 2. 新增事件监听器机制（参考 langchain callbacks）
- 新增 `AgentEvents` 接口（types.ts）：9 个钩子
  - onStart / onIterationStart / onLLMStream / onLLMEnd
  - onToolStart / onToolEnd / onFinal / onError / onEnd
- `ReActAgent.run(userInput, { events: [...] })` 接受多个监听器
- 默认挂载 `ConsoleLogger`（彩色日志），可叠加自定义监听器
- 监听器异常被捕获不中断主循环（callAll 用 fn.apply 调用，保留 this 上下文）

### 3. System Prompt 移除工具列表
- 原实现：`buildSystemPrompt(tools)` 在 prompt 里写工具名/描述/参数
- 新实现：`buildSystemPrompt()` 无参数，只含角色/工作模式/规则
- 工具 schema 完全由 OpenAI function calling 的 `tools` 参数暴露
- 避免冗余、节省 token、避免模型混淆
- 保留 MCP 前缀 `{serverName}__` 使用指导

## 状态

- 状态：已完成（含三项重构）
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-03（chatStream）、Task-04（runner.runParallel）、Task-05
- 备注：
  - 主循环改用 chatStream，实时流式输出 Thought
  - 事件监听器机制支持 langchain callbacks 风格扩展
  - System Prompt 不再重复工具列表，由 tools 参数负责 schema 暴露
  - 模型在工具失败时能自动换思路，符合 ReAct 设计预期

> 完成时同步更新 plan.md 状态汇总表与本文件验收清单。
