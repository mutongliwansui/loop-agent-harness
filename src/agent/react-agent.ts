// ReAct 主循环：Thought → Action → Observation → ... → Final Answer
// 使用流式 LLM 调用 + 事件监听器（events）扩展
// 集成三层记忆管理：L1 压缩 + L2 情景记忆 + L3 Curated
import { llm } from '../llm/client.js';
import { copyFile, writeFile, rename, cp, rm, mkdir } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { registry, runner } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { ConsoleLogger } from './logger.js';
import { buildLLMStatsSummary } from './stats.js';
import { createToolCallGenTracker, dispatchStreamChunk } from './stream-forward.js';
import { debug } from '../debug.js';
import { configLoader, type ConfigLoader, type PartialAgentConfig } from '../config/index.js';
import { skillLoader } from '../skill/loader.js';
import { SessionStore, workspaceId } from '../session/store.js';
import type { SessionData } from '../session/types.js';
import { dedupeCuratedFile } from '../memory/curated-dedupe.js';
import type { CuratedFileKey } from '../memory/types.js';
import {
  WorkingMemory,
  buildCompactedView,
  DEFAULT_WORKING_CONFIG,
  EpisodicMemory,
  CuratedMemory,
  ContextAssembler,
  repairMessageSequence,
  ToolMemoryCallback,
  PromotionGate,
  DreamingPipeline,
  type ILLMClient,
  type WorkingMemoryConfig,
  type DreamingResult,
  type DreamingProgress,
} from '../memory/index.js';
import type {
  AgentEvents,
  AgentResult,
  AgentStep,
  AgentOptions,
  ChatMessage,
  LLMResponse,
  LLMStats,
  LLMUsage,
  ToolCall,
} from '../types.js';

/** 适配器：将 LLMClient 包装为 ILLMClient（用于记忆模块） */
export function createLLMAdapter(model: string, temperature: number): ILLMClient {
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
  /** 最近一次 LLM 调用的真实 prompt_tokens（供 /status 展示） */
  private _lastContextTokens: number | null = null;

  /** 记忆模块（可选，根据配置启用） */
  private _workingMemory: WorkingMemory | null = null;
  private _episodicMemory: EpisodicMemory | null = null;
  private _curatedMemory: CuratedMemory | null = null;
  private _contextAssembler: ContextAssembler | null = null;
  private _memoryCallback: ToolMemoryCallback | null = null;
  private _promotionGate: PromotionGate | null = null;
  private _dreamingPipeline: DreamingPipeline | null = null;

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

  /** 向会话历史追加一条用户侧上下文备注（如 /upload 文件上传），随 autoSave 持久化（Task-20261012-001 D2） */
  appendContextNote(note: string): void {
    this._chatHistory.push({ role: 'user', content: note });
  }

  /** 手动清空持久化的对话历史（不影响正在进行中的 run 调用） */
  resetSession(): void {
    this._chatHistory = [];
    this._currentSessionId = null;
    this._lastContextTokens = null;
    // 同步清理记忆回调的 sessionId
    if (this._memoryCallback) {
      this._memoryCallback.setSessionId(null);
    }
  }

  /**
   * 从 SessionData 恢复对话（使用分层存储）
   * - recentMessages → 加载到 _chatHistory
   * - lastSummary → 作为首条 user 消息注入（不污染 system prompt，保持前缀缓存可命中）
   * - archivedMessages → 不加载，由 L2 检索覆盖
   */
  restoreSession(data: SessionData, systemPrompt: string): void {
    this._currentSessionId = data.id;

    // 同步设置记忆回调的 sessionId
    if (this._memoryCallback) {
      this._memoryCallback.setSessionId(data.id);
    }

    // 统一恢复视图：与 L1 压缩共用 buildCompactedView（同一逻辑/参数/形态）。
    // 原材料用 SessionStore.getAllAvailableMessages（覆盖修复前被截断的旧 session）；
    // system 用当前配置的 prompt（丢弃历史 system，避免旧 prompt 覆盖当前配置）；
    // 摘要以 ephemeral 占位注入，只对 LLM 可见，不会写入磁盘全量历史。
    const base = SessionStore.getAllAvailableMessages(data).filter(
      (m) => m.role !== 'system',
    );
    const restored = buildCompactedView(base, {
      systemPrompt,
      keepRecentTurns: DEFAULT_WORKING_CONFIG.keepRecentTurns,
      summaryText: data.lastSummary || undefined,
    });

    // 持久化/恢复过程中可能导致 tool-assistant 配对损坏，统一修复
    this._chatHistory = repairMessageSequence(restored);
    debug.log(`Session 恢复: ${data.id}, recentMessages=${data.recentMessages?.length ?? 0}, archivedCount=${data.archivedCount ?? 0}`);
  }

  /** 获取当前持久化的对话历史（只读拷贝） */
  getSessionMessages(): ChatMessage[] {
    return [...this._chatHistory];
  }

  /** 当前上下文消耗情况（供 /status 展示） */
  getContextUsage(): {
    contextTokens: number;
    maxTokens: number;
    threshold: number;
  } {
    const { config: cfg } = this._configLoader.load();
    const maxTokens = cfg.memory.working.maxTokens;
    const threshold = Math.round(maxTokens * cfg.memory.working.compactionThreshold);
    // 优先使用最近一次 API 调用的真实 token 数，缺失时回退到本地估算
    const messages = this.getSessionMessages();
    const contextTokens =
      this._lastContextTokens ?? this._workingMemory?.estimateTokens(messages) ?? 0;
    return { contextTokens, maxTokens, threshold };
  }

  /**
   * 初始化记忆系统（启动时调用；切换工作空间时可重入重建——先释放旧实例的 sqlite 句柄）
   */
  async initMemory(cwd: string): Promise<void> {
    const { config: cfg } = this._configLoader.load();

    if (!cfg.memory.enabled) {
      this._memoryEnabled = false;
      return;
    }

    this._memoryEnabled = true;
    this._workingConfig = cfg.memory.working;

    // L2 目录：显式绝对路径配置 → 尊重配置；默认相对路径 → ~/.loop-agent/memory/{workspaceId}
    const configEpisodicDir = cfg.memory.episodic.dir;
    const episodicDir = configEpisodicDir && isAbsolute(configEpisodicDir)
      ? configEpisodicDir
      : join(homedir(), '.loop-agent', 'memory', workspaceId(cwd));

    // 迁移旧版 L2 目录（{cwd}/memory → 用户目录），目标不存在且源存在时才迁移（幂等）
    const legacyEpisodicDir = join(cwd, configEpisodicDir);
    if (
      legacyEpisodicDir !== episodicDir
      && existsSync(legacyEpisodicDir)
      && !existsSync(episodicDir)
    ) {
      try {
        await mkdir(dirname(episodicDir), { recursive: true });
        await rename(legacyEpisodicDir, episodicDir);
      } catch {
        // 跨盘符时 rename 失败，回退为复制后删除
        try {
          await cp(legacyEpisodicDir, episodicDir, { recursive: true });
          await rm(legacyEpisodicDir, { recursive: true, force: true });
        } catch {
          // 迁移失败不影响启动
        }
      }
    }

    // 重入支持：旧实例的 FTS/向量索引持 sqlite 句柄，重建前先释放（首次调用时为 no-op）
    this._episodicMemory?.closeIndex();

    const curatedDir = cwd;
    // 全局 Curated 目录：SOUL/USER 存用户目录，MEMORY.md 留项目目录
    const globalCuratedDir = join(homedir(), '.loop-agent', 'curated');

    // L1 Working Memory
    this._workingMemory = new WorkingMemory(cfg.memory.working);

    // L2 Episodic Memory（Phase 5：可选向量检索配置透传）
    this._episodicMemory = new EpisodicMemory(episodicDir, cfg.memory.episodic.vectorSearch);
    await this._episodicMemory.init();

    // L3 Curated Memory（行数超限时自动 LLM 精简；SOUL/USER 全局，MEMORY 项目级）
    this._curatedMemory = new CuratedMemory(
      curatedDir,
      {
        maxLines: cfg.memory.curated.maxLines,
        compress: async (content, key) => {
          const { config: curCfg } = this._configLoader.load();
          if (!curCfg.memory.curated.dedupe.enabled) return null;
          const adapter = createLLMAdapter(curCfg.model.name, curCfg.model.temperature);
          return dedupeCuratedFile(adapter, content);
        },
      },
      globalCuratedDir,
    );
    await this._curatedMemory.init();

    // Promotion Gate（恢复持久化状态）
    this._promotionGate = new PromotionGate();
    await this._promotionGate.loadState(curatedDir);

    // Dreaming Pipeline（后台巡检）
    if (this._episodicMemory && this._promotionGate && this._curatedMemory) {
      // Task-20261011-002 P1：动态 adapter——每次调用时重读配置，
      // /model use 切换主模型后 Dreaming 跟随新模型（与上方 Curated 压缩回调同款写法）
      const configLoader = this._configLoader;
      const llmAdapter: ILLMClient = {
        async chat(messages: ChatMessage[]) {
          const { config: curCfg } = configLoader.load();
          return createLLMAdapter(curCfg.model.name, curCfg.model.temperature).chat(messages);
        },
      };
      this._dreamingPipeline = new DreamingPipeline(
        this._episodicMemory,
        this._promotionGate,
        this._curatedMemory,
        llmAdapter,
      );
    }

    // Context Assembler
    if (this._curatedMemory && this._episodicMemory) {
      this._contextAssembler = new ContextAssembler(this._curatedMemory, this._episodicMemory);
    }

    // Tool Memory Callback
    if (this._episodicMemory) {
      this._memoryCallback = new ToolMemoryCallback(this._episodicMemory);
    }

    debug.log(`记忆系统已初始化: L1(maxTokens=${cfg.memory.working.maxTokens}), L2(dir=${episodicDir}), L3(Curated), Dreaming(daysBack=${cfg.memory.dreaming.daysBack})`);
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

  /** 获取 PromotionGate 实例（供 CLI 命令使用） */
  get promotionGate(): PromotionGate | null {
    return this._promotionGate;
  }

  /** 获取 DreamingPipeline 实例（供 CLI 命令使用） */
  get dreamingPipeline(): DreamingPipeline | null {
    return this._dreamingPipeline;
  }

  /**
   * 运行 Dreaming 晋升巡检
   * 供 CLI `/memory dream` 与退出时自动触发使用
   */
  async runDreaming(daysBack?: number, onProgress?: DreamingProgress): Promise<DreamingResult | null> {
    if (!this._dreamingPipeline) return null;
    const { config: cfg } = this._configLoader.load();
    return this._dreamingPipeline.run(daysBack ?? cfg.memory.dreaming.daysBack, onProgress, {
      dedupeEnabled: cfg.memory.curated.dedupe.enabled,
      batchByDay: cfg.memory.dreaming.batchByDay,
      incremental: cfg.memory.dreaming.incremental,
    });
  }

  /**
   * 对指定 Curated 文件执行 LLM 存量去重（/memory curated dedupe 使用）
   * 返回前后行数与备份路径；失败或 LLM 输出异常时返回 null 且不修改文件
   */
  async dedupeCuratedMemory(
    key: CuratedFileKey,
  ): Promise<{ before: number; after: number; backup: string } | null> {
    if (!this._curatedMemory) return null;
    const { config: cfg } = this._configLoader.load();
    const filepath = this._curatedMemory.getFilePaths()[key];
    const content = await this._curatedMemory.read(key);
    if (!content.trim()) return null;

    // 备份原文件，防止 LLM 输出异常导致数据丢失
    const backup = `${filepath}.dedupe.bak`;
    await copyFile(filepath, backup);

    const llmAdapter = createLLMAdapter(cfg.model.name, cfg.model.temperature);
    const deduped = await dedupeCuratedFile(llmAdapter, content);
    if (!deduped) return null;

    // 防线：去重后行数不得多于原文件（防止 LLM 编造/新增内容）
    if (deduped.split('\n').length > content.split('\n').length) return null;

    await writeFile(filepath, deduped, 'utf-8');
    return {
      before: content.split('\n').length,
      after: deduped.split('\n').length,
      backup,
    };
  }

  async run(userInput: string, options: AgentOptions = {}): Promise<AgentResult> {
    // 构建 CLI override：从 AgentOptions 提取能映射的字段
    const cliOverride: PartialAgentConfig = {};
    if (options.model !== undefined) cliOverride.model = { name: options.model };
    if (options.maxIterations !== undefined) cliOverride.agent = { ...cliOverride.agent, maxIterations: options.maxIterations };
    if (options.temperature !== undefined) cliOverride.model = { ...cliOverride.model, temperature: options.temperature };
    if (options.verbose !== undefined) cliOverride.agent = { ...cliOverride.agent, verbose: options.verbose };

    const { config: cfg } = this._configLoader.load(cliOverride);

    const maxIterations = cfg.agent.maxIterations;
    const model = cfg.model.name;
    const temperature = cfg.model.temperature;
    const verbose = cfg.agent.verbose;

    // 自定义 system prompt 覆盖
    const skills = cfg.skill.enabled ? skillLoader.scan(process.cwd()) : [];
    const systemPrompt = cfg.agent.systemPrompt ?? buildSystemPrompt(skills, process.cwd(), cfg.vision.enabled);

    // 组装事件监听器：默认 ConsoleLogger + 用户自定义
    const events = this.composeEvents([
      new ConsoleLogger(verbose, cfg.agent.showTokenStats, options.spinner),
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
    const usageHistory: LLMUsage[] = [];
    /** Task-15：每轮统计历史（用于会话结束汇总） */
    const statsHistory: LLMStats[] = [];
    try {
      await safeEvents.onStart(userInput);

      for (let i = 0; i < maxIterations; i++) {
        await safeEvents.onIterationStart(i, maxIterations);

        // ===== 记忆管理：L1 压缩检查 =====
        if (this._workingMemory) {
          const wmConfig = this._workingMemory.getConfig();
          const threshold = Math.round(
            wmConfig.maxTokens * wmConfig.compactionThreshold,
          );
          // 优先使用上一轮 LLM 返回的真实 prompt_tokens（含 system/工具/L2/L3 注入），
          // 缺失时回退本地估算（长度/4，对中文会低估，可能导致压缩不触发）
          const overThreshold = this._lastContextTokens !== null
            ? this._lastContextTokens >= threshold
            : this._workingMemory.needsCompaction(messages);
          if (overThreshold) {
            debug.log('L1 超阈值，触发 pre-compaction flush');
            try {
              const llmAdapter = createLLMAdapter(model, temperature);
              const extracted = await this._workingMemory.preCompactionFlush(messages, llmAdapter);
              if (extracted && this._episodicMemory) {
                // 压缩笔记属会话内上下文语义：scope 改为 session，
                // 避免跨会话可见，也避免与 L1 摘要占位形成「同一份信息双通道注入」
                await this._episodicMemory.appendToday(extracted, {
                  sessionId: this._currentSessionId ?? undefined,
                  scope: 'session',
                  tag: 'compaction',
                });
                debug.log(`pre-compaction flush 完成，提取 ${extracted.length} 字符写入 L2`);
                // 同一份笔记既写 L2，也作为摘要占位注入内存视图，否则压缩后头部轮次直接从 LLM 视野消失
                messages = this._workingMemory.compact(messages, extracted);
                debug.log(`压缩完成，保留 ${messages.length} 条消息`);
                await safeEvents.onCompaction?.({
                  threshold,
                  contextTokens: this._lastContextTokens ?? this._workingMemory.estimateTokens(messages),
                  flushedChars: extracted.length,
                  keptMessages: messages.length,
                  failed: false,
                });
              } else if (wmConfig.flushFailure === 'archive' && this._episodicMemory) {
                // Task-17：提取失败 + archive → 原始对话降级写入 L2 保底，再压缩
                const rawContent = messages
                  .map((m) => `${m.role}: ${m.content}`)
                  .join('\n');
                await this._episodicMemory.appendToday(rawContent, {
                  sessionId: this._currentSessionId ?? undefined,
                  scope: 'session',
                  tag: 'compaction_fallback',
                });
                debug.log(`flush 失败，降级存档 ${rawContent.length} 字符到 L2（compaction_fallback）`);
                // 降级存档文本同样作为摘要占位注入，避免压缩后上下文断裂
                messages = this._workingMemory.compact(messages, rawContent);
                debug.log(`压缩完成，保留 ${messages.length} 条消息`);
                await safeEvents.onCompaction?.({
                  threshold,
                  contextTokens: this._lastContextTokens ?? this._workingMemory.estimateTokens(messages),
                  flushedChars: 0,
                  keptMessages: messages.length,
                  failed: true,
                  fallback: 'archive',
                });
              } else {
                // Task-17：提取失败 + skip（默认）→ 保留全部历史，不压缩（宁可超上下文不丢信息）
                debug.log('flush 提取失败，跳过压缩（保留全部历史）');
                await safeEvents.onCompaction?.({
                  threshold,
                  contextTokens: this._lastContextTokens ?? this._workingMemory.estimateTokens(messages),
                  flushedChars: 0,
                  keptMessages: messages.length,
                  failed: true,
                  fallback: 'skip',
                });
              }
            } catch (e) {
              debug.log(`压缩过程出错（不阻塞主流程）: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        // ===== 记忆管理：Context Assembly（L3 + L2 + L1 组装） =====
        // 组装结果仅作为本次 LLM 调用的视图（llmMessages），不覆盖工作数组 messages——
        // 否则 L2 记忆前缀会随 result.messages 持久化（前端渲染出记忆内容）并残留到后续轮次
        let llmMessages = messages;
        if (this._contextAssembler && this._memoryEnabled) {
          try {
            llmMessages = await this._contextAssembler.assemble(
              userInput,
              messages,
              skills,
              {
                searchTopK: cfg.memory.episodic.searchTopK,
                searchTimeoutMs: cfg.memory.episodic.searchTimeoutMs,
                sessionId: this._currentSessionId ?? undefined,
                searchMinScore: cfg.memory.episodic.searchMinScore,
                queryEnhanceRounds: cfg.memory.episodic.queryEnhanceRounds,
                shortQueryMinLength: cfg.memory.episodic.shortQueryMinLength,
                stopwords: cfg.memory.episodic.stopwords,
                recencyHalfLifeDays: cfg.memory.episodic.recencyHalfLifeDays,
              },
            );
          } catch {
            // Context 组装失败不阻塞主流程
          }
        }

        // 1. 流式调用 LLM，累积完整响应
        const llmStartTs = Date.now();
        const resp = await this.streamLLM(llmMessages, openaiTools, { model, temperature }, events);

        await safeEvents.onLLMEnd(resp, i);

        // 收集每轮 LLM 调用的 Token 使用数据（含缓存命中率）
        if (resp.usage) {
          usageHistory.push(resp.usage);
        }

        // ===== Task-15：每轮统计（上下文占用 / 缓存命中率 / 输入输出 token） =====
        const usage = resp.usage;
        const workingConfig = this._workingMemory?.getConfig();
        const contextTokens =
          usage?.prompt_tokens ?? (this._workingMemory?.estimateTokens(llmMessages) ?? 0);
        this._lastContextTokens = contextTokens;
        const maxTokens = workingConfig?.maxTokens ?? 0;
        const stats: LLMStats = {
          iteration: i,
          maxIterations,
          contextTokens,
          contextMaxTokens: maxTokens,
          contextThreshold: Math.round(maxTokens * (workingConfig?.compactionThreshold ?? 0)),
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? 0,
          cacheHitTokens: usage?.prompt_cache_hit_tokens,
          cacheHitRate:
            usage?.prompt_tokens
              ? (usage.prompt_cache_hit_tokens ?? 0) / usage.prompt_tokens
              : undefined,
          elapsedMs: Date.now() - llmStartTs,
        };
        statsHistory.push(stats);
        await safeEvents.onLLMStats(stats);

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
            // P2：执行期间每秒上报一次进度心跳，长耗时工具（如 commandRun）可见实时进展
            const ticker = setInterval(() => {
              void safeEvents.onToolProgress(c.toolName, Date.now() - toolStart);
            }, 1000);
            ticker.unref?.();
            try {
              const result = await runner.run(c.tool, c.args);
              void debug.toolCall(c.toolName, c.args ?? {}, result, Date.now() - toolStart);
              return result;
            } finally {
              clearInterval(ticker);
            }
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

      // 输出缓存命中率汇总（debug 日志 + Task-15 控制台汇总）
      debug.cacheSummary(usageHistory);
      if (statsHistory.length > 0) {
        await safeEvents.onLLMStatsSummary(buildLLMStatsSummary(statsHistory));
      }

      // 持久化到实例，供下一轮多轮对话复用
      this._chatHistory = [...result.messages];

      // 自动保存会话（如果配置启用且 SessionStore 可用）
      if (this._sessionStore && cfg.session.autoSave) {
        // P2：会话保存（常为加密写盘）期间的短指示器
        options.spinner?.start('保存会话…');
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
          await safeEvents.onWarning?.({
            level: 'warning',
            message: `会话自动保存失败: ${e instanceof Error ? e.message : String(e)}`,
            context: 'session',
          });
        } finally {
          options.spinner?.stop();
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
    const tracker = createToolCallGenTracker();
    for await (const chunk of llm.chatStream(messages, tools, options)) {
      const done = await dispatchStreamChunk(chunk, tracker, safeEvents);
      if (done) response = done;
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
          debug.log(`[events.${String(hook)}] 监听器异常: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };

    return {
      onStart: (input) => callAll('onStart', input),
      onIterationStart: (i, max) => callAll('onIterationStart', i, max),
      onLLMStream: (delta) => callAll('onLLMStream', delta),
      onLLMEnd: (resp, iter) => callAll('onLLMEnd', resp, iter),
      onLLMStats: (stats) => callAll('onLLMStats', stats),
      onLLMStatsSummary: (summary) => callAll('onLLMStatsSummary', summary),
      onToolStart: (tool, args) => callAll('onToolStart', tool, args),
      onToolEnd: (tool, result) => callAll('onToolEnd', tool, result),
      onToolProgress: (tool, elapsedMs) => callAll('onToolProgress', tool, elapsedMs),
      onToolCallDelta: (tool, bytes, elapsedMs) => callAll('onToolCallDelta', tool, bytes, elapsedMs),
      onCompaction: (info) => callAll('onCompaction', info),
      onFinal: (answer) => callAll('onFinal', answer),
      onError: (err) => callAll('onError', err),
      onWarning: (info) => callAll('onWarning', info),
      onEnd: (res) => callAll('onEnd', res),
    } as AgentEvents;
  }
}

/** 全局单例 */
export const agent = new ReActAgent();