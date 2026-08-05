// ReAct 主循环：Thought → Action → Observation → ... → Final Answer
// 使用流式 LLM 调用 + 事件监听器（events）扩展
import { llm } from '../llm/client.js';
import { registry, runner } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { ConsoleLogger } from './logger.js';
import { configLoader, type ConfigLoader, type PartialAgentConfig } from '../config/index.js';
import type {
  AgentEvents,
  AgentResult,
  AgentStep,
  AgentOptions,
  ChatMessage,
  LLMResponse,
  ToolCall,
} from '../types.js';

export class ReActAgent {
  /** 跨 run() 调用持久化的对话历史，用于 CLI 多轮会话 */
  private _chatHistory: ChatMessage[] = [];

  constructor(private _configLoader: ConfigLoader = configLoader) {}

  /** 手动清空持久化的对话历史（不影响正在进行中的 run 调用） */
  resetSession(): void {
    this._chatHistory = [];
  }

  /** 获取当前持久化的对话历史（只读拷贝） */
  getSessionMessages(): ChatMessage[] {
    return [...this._chatHistory];
  }

  async run(userInput: string, options: AgentOptions = {}): Promise<AgentResult> {
    // 构建 CLI override：从 AgentOptions 提取能映射的字段
    const cliOverride: PartialAgentConfig = {};
    if (options.model !== undefined) cliOverride.model = { name: options.model };
    if (options.maxIterations !== undefined) cliOverride.model = { ...cliOverride.model, maxIterations: options.maxIterations };
    if (options.temperature !== undefined) cliOverride.model = { ...cliOverride.model, temperature: options.temperature };
    if (options.verbose !== undefined) cliOverride.agent = { verbose: options.verbose };

    const { config: cfg } = this._configLoader.load(cliOverride);

    const maxIterations = cfg.model.maxIterations;
    const model = cfg.model.name;
    const temperature = cfg.model.temperature;
    const verbose = cfg.agent.verbose;

    // 自定义 system prompt 覆盖
    const systemPrompt = cfg.agent.systemPrompt ?? buildSystemPrompt();

    // 组装事件监听器：默认 ConsoleLogger + 用户自定义
    const events = this.composeEvents([
      new ConsoleLogger(verbose),
      ...(options.events ?? []),
    ]);

    // 构造 messages：优先 resetHistory → 其次 options.messages → 再次实例 _chatHistory → 最后新建
    let messages: ChatMessage[];
    if (options.resetHistory) {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ];
    } else if (options.messages && options.messages.length > 0) {
      // 外部传入历史（含 system 也可），直接追加 user
      messages = [...options.messages, { role: 'user', content: userInput }];
      // 若历史里没有 system，则补上（保证总在第 0 条）
      const hasSystem = messages.some((m) => m.role === 'system');
      if (!hasSystem) messages.unshift({ role: 'system', content: systemPrompt });
    } else if (this._chatHistory.length > 0) {
      // 复用上次持久化的历史，追加新 user（历史里已含 system）
      messages = [...this._chatHistory, { role: 'user', content: userInput }];
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ];
    }

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
          // 把最终 assistant 回复写入 messages，便于多轮续接
          messages.push({ role: 'assistant', content: answer });
          result = { answer, steps, iterations: i + 1, messages: [...messages] };
          await safeEvents.onFinal(answer);
          break;
        }

        // 3. 拼接 assistant tool_calls
        messages.push({
          role: 'assistant',
          content: resp.content,
          tool_calls: resp.tool_calls,
        });

        // 4. 并发执行所有工具调用
        // 工具不存在时不抛错，返回错误 Observation 让 Agent 继续
        const callItems = resp.tool_calls.map((call) => {
          const args = this.parseArgs(call);
          const toolName = call.function.name;
          const tool = registry.has(toolName) ? registry.get(toolName) : null;
          return { call, toolName, tool, args };
        });

        // 触发 onToolStart
        for (const c of callItems) {
          await safeEvents.onToolStart(c.toolName, c.args);
        }

        // 执行工具：存在则 runner.run，不存在则返回错误
        const observations = await Promise.all(
          callItems.map(async (c) => {
            if (!c.tool) return `工具 ${c.toolName} 未注册，无法执行`;
            return runner.run(c.tool, c.args);
          }),
        );

        // 5. 记录步骤 + 拼接 tool 角色 Observation + 触发 onToolEnd
        callItems.forEach((c, idx) => {
          const observation = observations[idx];
          steps.push({
            thought: resp.content ?? undefined,
            action: { tool: c.toolName, args: c.args },
            observation,
          });
          // 异步触发，不 await（避免日志拖延主循环）
          void safeEvents.onToolEnd(c.toolName, observation);
          messages.push({
            role: 'tool',
            tool_call_id: c.call.id,
            content: observation,
          });
        });
        // 回到循环顶部继续推理
      }

      if (!result) {
        const errMsg = `达到最大迭代次数 ${maxIterations}，Agent 未能给出最终答案`;
        const err = new Error(errMsg);
        await safeEvents.onError(err);
        // 即使迭代超限，也把当前 messages 存下来便于调试
        this._chatHistory = [...messages];
        throw err;
      }

      // 持久化到实例，供下一轮多轮对话复用
      this._chatHistory = [...result.messages];
    } finally {
      await safeEvents.onEnd(result);
    }

    return result;
  }

  /**
   * 流式调用 LLM，通过 events.onLLMStream 实时输出 Thought 片段
   * 返回流结束后的完整 LLMResponse
   */
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
      // toolCallStart / toolCallDelta 可由 events 自行扩展处理（默认 logger 不展示）
    }
    if (!response) {
      throw new Error('LLM 流式调用未返回 done chunk');
    }
    return response;
  }

  /** 解析 tool_call.function.arguments（JSON 字符串 → 对象） */
  private parseArgs(call: ToolCall): Record<string, unknown> {
    try {
      return JSON.parse(call.function.arguments);
    } catch {
      return {};
    }
  }

  /**
   * 组合多个事件监听器为一个顺序执行器
   * 单个 listener 抛错被捕获不中断其他 listener 与主循环
   */
  private composeEvents(listeners: AgentEvents[]): AgentEvents {
    const callAll = async (
      hook: keyof AgentEvents,
      ...args: unknown[]
    ): Promise<void> => {
      for (const l of listeners) {
        // 用 bind 绑定 this，避免类方法丢失上下文
        const fn = (l as Record<string, ((...a: unknown[]) => void | Promise<void>) | undefined>)[hook];
        if (!fn) continue;
        try {
          await fn.apply(l, args);
        } catch (e) {
          // 监听器异常不中断主循环
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
      onToolEnd: (tool, result) => callAll('onToolEnd', tool, result),
      onFinal: (answer) => callAll('onFinal', answer),
      onError: (err) => callAll('onError', err),
      onEnd: (res) => callAll('onEnd', res),
    } as AgentEvents;
  }
}

/** 全局单例 */
export const agent = new ReActAgent();
