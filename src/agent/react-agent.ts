// ReAct 主循环：Thought → Action → Observation → ... → Final Answer
// 使用流式 LLM 调用 + 事件监听器（events）扩展
// 集成三层记忆管理：L1 压缩 + L2 情景记忆 + L3 Curated
import { llm } from '../llm/client.js';
import { registry, runner } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { ConsoleLogger } from './logger.js';
import { debug } from '../debug.js';
import { configLoader, type ConfigLoader, type PartialAgentConfig } from '../config/index.js';
import { skillLoader } from '../skill/loader.js';
import { type SessionStore } from '../session/store.js';
import type { SessionData } from '../session/types.js';
import {
  WorkingMemory,
  EpisodicMemory,
  CuratedMemory,
  ContextAssembler,
  ToolMemoryCallback,
  type ILLMClient,
  type WorkingMemoryConfig,
} from '../memory/index.js';
import type {
  AgentEvents,
  AgentResult,
  AgentStep,
  AgentOptions,
  ChatMessage,
  LLMResponse,
  ToolCall,
} from '../types.js';

/** 适配器：将 LLMClient 包装为 ILLMClient（用于记忆模块） */
function createLLMAdapter(model: string, temperature: number): ILLMClient {
  return {
    async chat(messages: ChatMessage[]): Promise<{ content: string | null }> {
      const resp = await llm.chat(messages, undefined, { model, temperature });
      return { content: resp.content };
    },
  };
}

export class ReActAgent {
  /** 跨 run() 调用持久化的对话历史，用于 CLI 多轮会话 */
  private _chatHistory: ChatMessage[] = [];
  /** 会话存储（可选，用于持久化） */
  private _sessionStore: SessionStore | null = null;
  /** 当前会话 ID */
  private _currentSessionId: string | null = null;

  /** 记忆模块（可选，根据配置启用） */
  private _workingMemory: WorkingMemory | null = null;
  private _episodicMemory: EpisodicMemory | null = null;
  private _curatedMemory: CuratedMemory | null = null;
  private _contextAssembler: ContextAssembler | null = null;
  private _memoryCallback: ToolMemoryCallback | null = null;

  /** 记忆配置 */
  private _memoryEnabled = false;
  private _workingConfig: WorkingMemoryConfig | null = null;

  constructor(private _configLoader: ConfigLoader = configLoader) {}

  /** 设置会话存储 */
  setSessionStore(store: SessionStore): void {
    this._sessionStore = store;
  }

  /** 获取当前会话 ID */
  get currentSessionId(): string | null {
    return this._currentSessionId;
  }

  /** 设置当前会话 ID（由外部 /session load 调用） */
  setCurrentSessionId(id: string | null): void {
    this._currentSessionId = id;
  }

  /** 手动清空持久化的对话历史（不影响正在进行中的 run 调用） */
  resetSession(): void {
    this._chatHistory = [];
    this._currentSessionId = null;
    // 同步清理记忆回调的 sessionId
    if (this._memoryCallback) {
      this._memoryCallback.setSessionId(null);
    }
  }

  /**
   * 从 SessionData 恢复对话（使用分层存储）
   * - recentMessages → 加载到 _chatHistory
   * - lastSummary → 注入 system prompt（作为历史摘要）
   * - archivedMessages → 不加载，由 L2 检索覆盖
   */
  restoreSession(data: SessionData, systemPrompt: string): void {
    this._currentSessionId = data.id;

    // 同步设置记忆回调的 sessionId
    if (this._memoryCallback) {
      this._memoryCallback.setSessionId(data.id);
    }

    const restored: ChatMessage[] = [];

    // 1. 构建增强的 system prompt（注入 lastSummary）
    let enhancedSystem = systemPrompt;
    if (data.lastSummary) {
      enhancedSystem += `\n\n## 会话历史摘要\n以下是你之前与用户的对话摘要，请在回答时参考上下文：\n${data.lastSummary}`;
    }
    restored.push({ role: 'system', content: enhancedSystem });

    // 2. 添加 recentMessages
    if (data.recentMessages && data.recentMessages.length > 0) {
      restored.push(...data.recentMessages);
    } else if (data.messages) {
      // 兼容旧格式
      restored.push(...data.messages.filter((m) => m.role !== 'system'));
    }

    this._chatHistory = restored;
    debug.log(`Session 恢复: ${data.id}, recentMessages=${data.recentMessages?.length ?? 0}, archivedCount=${data.archivedCount ?? 0}`);
  }

  /** 获取当前持久化的对话历史（只读拷贝） */
  getSessionMessages(): ChatMessage[] {
    return [...this._chatHistory];
  }

  /**
   * 初始化记忆系统（在启动时调用一次）
   */
  async initMemory(cwd: string): Promise<void> {
    const { config: cfg } = this._configLoader.load();

    if (!cfg.memory.enabled) {
      this._memoryEnabled = false;
      return;
    }

    this._memoryEnabled = true;
    this._workingConfig = cfg.memory.working;

    const episodicDir = cfg.memory.episodic.dir;
    const curatedDir = cwd;

    // L1 Working Memory
    this._workingMemory = new WorkingMemory(cfg.memory.working);

    // L2 Episodic Memory
    this._episodicMemory = new EpisodicMemory(episodicDir);
    await this._episodicMemory.init();

    // L3 Curated Memory
    this._curatedMemory = new CuratedMemory(curatedDir);
    await this._curatedMemory.init();

    // Context Assembler
    if (this._curatedMemory && this._episodicMemory) {
      this._contextAssembler = new ContextAssembler(this._curatedMemory, this._episodicMemory);
    }

    // Tool Memory Callback
    if (this._episodicMemory) {
      this._memoryCallback = new ToolMemoryCallback(this._episodicMemory);
    }

    debug.log(`记忆系统已初始化: L1(maxTokens=${cfg.memory.working.maxTokens}), L2(dir=${episodicDir}), L3(Curated)`);
  }

  /** 是否启用了记忆系统 */
  get memoryEnabled(): boolean {
    return this._memoryEnabled;
  }

  /** 获取 EpisodicMemory 实例（供 CLI 命令使用） */
  get episodicMemory(): EpisodicMemory | null {
    return this._episodicMemory;
  }

  /** 获取 CuratedMemory 实例（供 CLI 命令使用） */
  get curatedMemory(): CuratedMemory | null {
    return this._curatedMemory;
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
    const skills = cfg.skill.enabled ? skillLoader.scan(process.cwd()) : [];
    const systemPrompt = cfg.agent.systemPrompt ?? buildSystemPrompt(skills);

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
      messages = [...options.messages, { role: 'user', content: userInput }];
      const hasSystem = messages.some((m) => m.role === 'system');
      if (!hasSystem) messages.unshift({ role: 'system', content: systemPrompt });
    } else if (this._chatHistory.length > 0) {
      messages = [...this._chatHistory, { role: 'user', content: userInput }];
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ];
    }

    const steps: AgentStep[] = [];
    const openaiTools = registry.toOpenAITools();

    debug.session(messages.length, openaiTools.length, this._currentSessionId);

    // ===== 设置记忆回调的 sessionId =====
    if (this._memoryCallback && this._currentSessionId) {
      this._memoryCallback.setSessionId(this._currentSessionId);
    }

    let result: AgentResult | null = null;
    const safeEvents = events as Required<AgentEvents>;
    try {
      await safeEvents.onStart(userInput);

      for (let i = 0; i < maxIterations; i++) {
        await safeEvents.onIterationStart(i, maxIterations);

        // ===== 记忆管理：L1 压缩检查 =====
        if (this._workingMemory && this._workingMemory.needsCompaction(messages)) {
          debug.log('L1 超阈值，触发 pre-compaction flush');
          try {
            const llmAdapter = createLLMAdapter(model, temperature);
            const extracted = await this._workingMemory.preCompactionFlush(messages, llmAdapter);
            if (extracted && this._episodicMemory) {
              // pre-compaction flush 的内容标记为 global（跨会话知识）
              await this._episodicMemory.appendToday(extracted, {
                sessionId: this._currentSessionId ?? undefined,
                scope: 'global',
                tag: 'compaction',
              });
              debug.log(`pre-compaction flush 完成，提取 ${extracted.length} 字符写入 L2`);
            }
            messages = this._workingMemory.compact(messages);
            debug.log(`压缩完成，保留 ${messages.length} 条消息`);
          } catch (e) {
            debug.log(`压缩过程出错（不阻塞主流程）: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // ===== 记忆管理：Context Assembly（L3 + L2 + L1 组装） =====
        if (this._contextAssembler && this._memoryEnabled) {
          try {
            messages = await this._contextAssembler.assemble(
              userInput,
              messages,
              skills,
              {
                searchTopK: cfg.memory.episodic.searchTopK,
                searchTimeoutMs: cfg.memory.episodic.searchTimeoutMs,
                sessionId: this._currentSessionId ?? undefined,
              },
            );
          } catch {
            // Context 组装失败不阻塞主流程
          }
        }

        // 1. 流式调用 LLM，累积完整响应
        const resp = await this.streamLLM(messages, openaiTools, { model, temperature }, events);

        await safeEvents.onLLMEnd(resp, i);

        // 2. 无 tool_calls → 最终答案
        if (!resp.tool_calls?.length) {
          const answer = resp.content ?? '';
          debug.log(`最终回答生成完毕，共 ${i + 1} 轮迭代`);
          messages.push({ role: 'assistant', content: answer });
          result = { answer, steps, iterations: i + 1, messages: [...messages] };
          await safeEvents.onFinal(answer);

          // ===== 记忆管理：最终回答写入 L2 =====
          if (this._episodicMemory) {
            try {
              const summary = `用户: ${userInput}\n结果: ${answer.slice(0, 200)}`;
              await this._episodicMemory.appendToday(summary, {
                sessionId: this._currentSessionId ?? undefined,
                scope: 'session',
                tag: 'final_answer',
              });
            } catch { /* 静默 */ }
          }
          break;
        }

        // 3. 拼接 assistant tool_calls
        messages.push({
          role: 'assistant',
          content: resp.content,
          tool_calls: resp.tool_calls,
        });

        // 4. 并发执行所有工具调用
        const callItems = resp.tool_calls.map((call) => {
          const args = this.parseArgs(call);
          const toolName = call.function.name;
          const tool = registry.has(toolName) ? registry.get(toolName) : null;
          return { call, toolName, tool, args };
        });

        // 触发 onToolStart
        for (const c of callItems) {
          await safeEvents.onToolStart(c.toolName, c.args ?? {});
        }

        // 执行工具
        const observations = await Promise.all(
          callItems.map(async (c) => {
            if (!c.tool) return `工具 ${c.toolName} 未注册，无法执行`;
            if (!c.args) return `工具 ${c.toolName} 参数无效：参数为空或解析失败，请重新调用并提供正确的参数`;
            const required = (c.tool.parameters?.required as string[] | undefined) ?? [];
            const missing = required.filter((k) => !(k in c.args!));
            if (missing.length > 0) {
              return `工具 ${c.toolName} 缺少必需参数: ${missing.join(', ')}，请补充后重试`;
            }
            const toolStart = Date.now();
            const result = runner.run(c.tool, c.args);
            void result.then((r) => debug.toolCall(c.toolName, c.args ?? {}, r, Date.now() - toolStart));
            return result;
          }),
        );

        // 5. 记录步骤 + 拼接 tool 角色 Observation + 触发 onToolEnd
        callItems.forEach((c, idx) => {
          const observation = observations[idx];
          steps.push({
            thought: resp.content ?? undefined,
            action: { tool: c.toolName, args: c.args ?? {} },
            observation,
          });
          void safeEvents.onToolEnd(c.toolName, observation);
          messages.push({
            role: 'tool',
            tool_call_id: c.call.id,
            content: observation,
          });

          // ===== 记忆管理：工具结果写入 L2 =====
          if (this._memoryCallback) {
            void this._memoryCallback.log(c.toolName, c.args ?? {}, observation);
          }
        });

        debug.iteration(
          i + 1,
          resp.content,
          callItems.map((c) => c.toolName).join(', '),
          observations.join(' | '),
        );
      }

      if (!result) {
        const errMsg = `达到最大迭代次数 ${maxIterations}，Agent 未能给出最终答案`;
        const err = new Error(errMsg);
        await safeEvents.onError(err);
        this._chatHistory = [...messages];
        throw err;
      }

      // 持久化到实例，供下一轮多轮对话复用
      this._chatHistory = [...result.messages];

      // 自动保存会话（如果配置启用且 SessionStore 可用）
      if (this._sessionStore && cfg.session.autoSave) {
        try {
          if (this._currentSessionId) {
            await this._sessionStore.updateSession(
              this._currentSessionId,
              result.messages,
              steps,
            );
          } else {
            const userMsg = userInput;
            const meta = await this._sessionStore.createSession(
              userMsg,
              result.messages,
              steps,
            );
            this._currentSessionId = meta.id;
          }
        } catch (e) {
          console.error('[session] 自动保存失败:', e instanceof Error ? e.message : String(e));
        }
      }
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
      onToolEnd: (tool, result) => callAll('onToolEnd', tool, result),
      onFinal: (answer) => callAll('onFinal', answer),
      onError: (err) => callAll('onError', err),
      onEnd: (res) => callAll('onEnd', res),
    } as AgentEvents;
  }
}

/** 全局单例 */
export const agent = new ReActAgent();