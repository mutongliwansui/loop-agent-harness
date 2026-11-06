// ContextAssembler：上下文组装
// 每次 LLM 调用前组装完整 context：L3 常驻 + L2 检索 + L1 当前
import type { ChatMessage } from '../types.js';
import type { SkillMetadata } from '../skill/types.js';
import type { MemorySearchResult } from './types.js';
import { CuratedMemory } from './curated.js';
import { EpisodicMemory } from './episodic.js';
import { withMemorySection, stripMemorySection } from './memory-section.js';
import { isSummaryMessage } from './summary-message.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { debug } from '../debug.js';

/** Task-19 方案 5：内置停用词——过于通用的短词，不触发 L2 检索 */
const BUILTIN_STOPWORDS = new Set([
  '继续', '好的', '是的', '可以', 'ok', '嗯', '对', '行', '不是',
  '继续。', '好的。', '是的。', '可以。', '嗯。', '对。',
  '继续吧', '好的吧', '可以吧',
  '好', '是', '否', 'ok.', 'OK', 'OK.',
  '继续修改', '继续吧。',
  'got it', 'gotcha', 'sure', 'nice', 'great',
]);

/** 修复/封口时为「确实拿不到结果」的 tool_call 补的合成 tool 消息内容 */
export const SYNTHETIC_TOOL_RESULT_TEXT = '（该工具调用未返回结果，已由消息序列修复补齐）';

/**
 * 消息序列验证与修复（按顺序配对，不依赖 tool_call_id 全局唯一）
 *
 * 问题：assistant(tool_calls) 必须「紧邻」其全部 tool 响应，否则上游直接 400
 * （An assistant message with 'tool_calls' must be followed by tool messages ...）。
 *
 * 旧实现用全局 `tool_call_id → assistant 索引` 映射判断合法 tool，隐含假设 id 全局唯一。
 * 但上游/响应缓存会复用同一个 id（同会话多次重试「继续」时同一段轨迹的 id 完全相同），
 * 后出现的 assistant 会覆盖映射，导致较早那一组的 tool 被判为孤儿删掉，而该 assistant
 * 的 tool_calls 因 id 仍被后面的 tool 响应「兜住」而保留 → 产出的正是报错里的非法序列。
 *
 * 修复策略（一次线性扫描）：
 * 1. 维护「当前待响应的 assistant」，只有紧邻其后的 tool 才归属它，按 id 逐个消费；
 * 2. 不属于当前待响应 assistant 的 tool（顺序错乱/纯孤儿）→ 丢弃；
 * 3. 一组配对结束时仍有未被响应的 tool_call → 在该位置补合成 tool 消息（补而非删，
 *    与 sealPendingToolCalls 的 D3 口径一致），保持 assistant 的 tool_calls 不被裁掉。
 */
export function repairMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;

  const result: ChatMessage[] = [];
  let pending: Set<string> | null = null;
  let changed = false;

  // 收尾当前待响应的 assistant：仍未被响应的 tool_call 原地补合成 tool 消息
  const closePending = (): void => {
    if (!pending) return;
    for (const id of pending) {
      changed = true;
      result.push({ role: 'tool', tool_call_id: id, content: SYNTHETIC_TOOL_RESULT_TEXT });
    }
    pending = null;
  };

  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      closePending();
      pending = new Set(m.tool_calls.map((tc) => tc.id));
      result.push(m);
    } else if (m.role === 'tool') {
      if (pending && pending.has(m.tool_call_id)) {
        pending.delete(m.tool_call_id);
        result.push(m);
        // 该组已全部响应：后续同 id 的 tool 不再归属它（避免跨轮次同名 id 串组）
        if (pending.size === 0) pending = null;
      } else {
        // 无紧邻的待响应 assistant → 孤立/顺序错乱的 tool，丢弃
        changed = true;
      }
    } else {
      closePending();
      result.push(m);
    }
  }
  closePending();

  return changed ? result : messages;
}

/**
 * 审计 tool_calls / tool 配对是否符合上游协议（只读、一次线性扫描）。
 * 返回问题描述（空数组 = 合法）；供发起 LLM 请求前留痕，便于定位 400。
 */
export function auditToolSequence(messages: ChatMessage[]): string[] {
  const issues: string[] = [];
  let pending: Set<string> | null = null;
  let pendingAt = -1;

  const closePending = (endAt: number): void => {
    if (pending && pending.size > 0) {
      issues.push(
        `#${pendingAt} assistant(tool_calls) 有 ${pending.size} 个 id 缺少紧邻 tool 响应（截至 #${endAt}）`,
      );
    }
    pending = null;
  };

  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      closePending(i);
      pending = new Set(m.tool_calls.map((tc) => tc.id));
      pendingAt = i;
    } else if (m.role === 'tool') {
      if (pending && pending.has(m.tool_call_id)) {
        pending.delete(m.tool_call_id);
        if (pending.size === 0) pending = null;
      } else {
        issues.push(`#${i} tool(${m.tool_call_id}) 没有紧邻的 tool_calls 响应对象`);
      }
    } else {
      closePending(i);
    }
  });
  closePending(messages.length);

  return issues;
}

export class ContextAssembler {
  private curated: CuratedMemory;
  private episodic: EpisodicMemory;
  /**
   * 20261021-008 R1：L2 检索结果的 run 级缓存。
   * 同一 run 内每轮迭代都会调用 assemble()（userMessage/sessionId 不变），
   * 而工具结果持续写入 L2、检索结果集可能漂移——注入「最后一条 user 消息」的
   * memoryBlock 一旦变化，其后所有 tool/assistant 消息的前缀缓存整段 miss。
   * 这里按 (userMessage, sessionId) 冻结检索结果：同 run 复用首轮结果，
   * 新 run 的 userMessage 必然不同，天然失效，无需显式 invalidate。
   * 另顺带消除 safeSearch 超时导致的「有注入 ↔ 无注入」前缀翻转。
   */
  private runCache: {
    userMessage: string;
    sessionId: string | null;
    memoryBlock: string;
  } | null = null;

  constructor(curated: CuratedMemory, episodic: EpisodicMemory) {
    this.curated = curated;
    this.episodic = episodic;
  }

  /**
   * 组装完整 context
   * @param userMessage 用户当前消息（用于 L2 检索）
   * @param currentMessages 当前 L1 消息历史
   * @param skills 可用 Skill 列表
   * @param options 配置选项（含 sessionId 用于 L2 隔离）
   */
  async assemble(
    userMessage: string,
    currentMessages: ChatMessage[],
    skills: SkillMetadata[] = [],
    options: {
      searchTopK?: number;
      searchTimeoutMs?: number;
      /** 当前会话 ID，用于 L2 检索隔离 */
      sessionId?: string;
      /** Task-19：BM25/匹配分数最低阈值 */
      searchMinScore?: number;
      /** Task-19：查询增强轮数（0=禁用） */
      queryEnhanceRounds?: number;
      /** Task-19：短查询最小长度 */
      shortQueryMinLength?: number;
      /** Task-19：自定义停用词 */
      stopwords?: string[];
      /** Task-19 方案 3：时间衰减半衰期（天，0=禁用） */
      recencyHalfLifeDays?: number;
      /**
       * 20261021-008 R3：run() 首轮构建的 system prompt 产物（含
       * `cfg.agent.systemPrompt` 覆盖与 workspaceDir/visionEnabled 段）。
       * 传入后 assemble 直接复用，保证同一会话 system 字节级稳定；
       * 缺省时回退 buildSystemPrompt(skills)（旧行为，既有调用方兼容）。
       */
      systemPrompt?: string;
    } = {},
  ): Promise<ChatMessage[]> {
    const searchTopK = options.searchTopK ?? 3;
    const searchTimeoutMs = options.searchTimeoutMs ?? 500;
    const searchMinScore = options.searchMinScore ?? 0;
    const queryEnhanceRounds = options.queryEnhanceRounds ?? 0;
    const shortQueryMinLength = options.shortQueryMinLength ?? 0;
    const customStopwords = options.stopwords ?? [];
    const recencyHalfLifeDays = options.recencyHalfLifeDays ?? 0;

    // 1. L3 常驻：system prompt（含 SOUL/USER/MEMORY）
    let curatedContent = '';
    try {
      // 20261021-008 R2：走缓存版（mtime+size 短路，未变化不重读不重拼）
      curatedContent = await this.curated.buildSystemPromptCached();
    } catch {
      // L3 读取失败不影响主流程
    }
    const curatedSection = curatedContent
      ? `\n\n## 你的长期记忆（Curated Memory）\n以下是关于你服务的用户和积累的知识，请在回答时参考：\n${curatedContent}`
      : '';

    // 20261021-008 R3：优先复用 run() 首轮构建的 system prompt（单一来源），
    // 保证同一会话内 system 与首轮产物字节级一致（含 workspaceDir/vision 段）。
    const basePrompt = options.systemPrompt ?? buildSystemPrompt(skills);
    // 2. L2 检索：召回相关历史片段
    // Task-19 三层防线：短查询保护 → 查询增强 → 最低阈值过滤
    // 20261021-008 R1：同 (userMessage, sessionId) 直接复用 run 级缓存的检索结果——
    // 避免同 run 内工具写入 L2 后检索结果漂移（注入内容变化 → 其后全部消息前缀 miss）。
    const cachedKeySessionId = options.sessionId ?? null;
    if (
      this.runCache
      && this.runCache.userMessage === userMessage
      && this.runCache.sessionId === cachedKeySessionId
    ) {
      return this.assembleWithMemoryBlock(
        this.runCache.memoryBlock,
        basePrompt,
        curatedSection,
        userMessage,
        currentMessages,
      );
    }
    let memoryBlock = '';
    try {
      // 方案 1：查询增强——拼接最近 N 轮对话，使搜索词更有区分度
      let searchQuery = userMessage;
      if (queryEnhanceRounds > 0) {
        const recentMsgs = currentMessages
          // 排除摘要占位/总结消息（is_show=false 的 user）：若拼进检索词会把摘要文本当查询内容，污染召回结果
          .filter(m => (m.role === 'user' || m.role === 'assistant') && m.is_show !== false)
          .slice(-queryEnhanceRounds * 2);
        if (recentMsgs.length > 0) {
          const contextStr = recentMsgs
            // 剥离历史消息里可能已落盘的记忆前缀，避免污染检索词
            .map(m => typeof m.content === 'string' ? stripMemorySection(m.content) : '')
            .join(' ');
          searchQuery = `${contextStr} ${userMessage}`;
        }
      }

      // 方案 5：短查询保护——过短或停用词直接跳过 L2 检索
      const trimmedQuery = searchQuery.trim();
      const allStopwords = new Set([...BUILTIN_STOPWORDS, ...customStopwords]);
      const isStopword = allStopwords.has(trimmedQuery.toLowerCase());
      const tooShort = shortQueryMinLength > 0 && trimmedQuery.length < shortQueryMinLength;
      if (isStopword || tooShort) {
        debug.log(`[context] 跳过 L2 检索：${isStopword ? '停用词' : '查询过短'} ("${trimmedQuery}")`);
      } else {
        const retrieved = await this.safeSearch(
          searchQuery,
          searchTopK,
          searchTimeoutMs,
          options.sessionId,
          recencyHalfLifeDays,
        );

        // 方案 2c：最低阈值过滤——弱匹配不注入
        const filtered = searchMinScore > 0
          ? retrieved.filter(r => r.score >= searchMinScore)
          : retrieved;
        if (filtered.length > 0) {
          memoryBlock = filtered.map(r => r.content).join('\n');
        }
      }
    } catch {
      // 检索失败不影响主流程
    }
    // R1：冻结本次 run 的检索结果（含空结果——超时/失败也冻结，避免「有注入 ↔ 无注入」翻转）
    this.runCache = { userMessage, sessionId: cachedKeySessionId, memoryBlock };

    // 3. 组装完整 messages + 修复损坏的 tool-assistant 配对
    // L2 检索结果不注入 system prompt：system 前缀必须保持稳定才能命中 DeepSeek 前缀缓存。
    // 检索结果改为附加到最后一条 user 消息之前（通常即本次用户输入），避免污染 system 前缀。
    return this.assembleWithMemoryBlock(
      memoryBlock,
      basePrompt,
      curatedSection,
      userMessage,
      currentMessages,
    );
  }

  /**
   * 用确定的 memoryBlock 组装最终视图（R1 抽取：缓存命中与冷启动两条路径共用，
   * 保证同一 run 内产物逐字节一致）。
   */
  private assembleWithMemoryBlock(
    memoryBlock: string,
    basePrompt: string,
    curatedSection: string,
    _userMessage: string,
    currentMessages: ChatMessage[],
  ): ChatMessage[] {
    const finalSystemPrompt = basePrompt + curatedSection;

    const rawMessages: ChatMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...currentMessages.filter((m) => m.role !== 'system'),
    ];
    if (memoryBlock) {
      // 拼接/剥离格式约定见 memory-section.ts（SessionStore 生成会话标题时依赖哨兵剥离前缀）
      // 只注入最后一条「真实用户消息」：压缩总结消息也是 role=user（头部占位），
      // 单轮内 token 截尾时视图中可能没有真实 user，此时跳过注入，避免把记忆写进摘要。
      const lastUserIdx = rawMessages.reduceRight(
        (acc, m, i) => (acc === -1 && m.role === 'user' && !isSummaryMessage(m) ? i : acc),
        -1,
      );
      if (lastUserIdx >= 0 && rawMessages[lastUserIdx].role === 'user') {
        const lastUser = rawMessages[lastUserIdx];
        rawMessages[lastUserIdx] = {
          ...lastUser,
          // 注入前先剥离已有记忆前缀，保证幂等（避免多轮/恢复后前缀嵌套叠加）
          content: withMemorySection(memoryBlock, stripMemorySection(lastUser.content)),
        };
      }
    }

    return repairMessageSequence(rawMessages);
  }

  /**
   * 带超时的安全检索（支持 sessionId 隔离 + Task-19 方案 3/4）
   * 方案 4：会话优先——先搜当前 session 级条目，有结果则不搜全局
   * 方案 3：时间衰减——将 recencyHalfLifeDays 透传给 episodic 检索加权
   */
  private async safeSearch(
    query: string,
    topK: number,
    timeoutMs: number,
    sessionId?: string,
    recencyHalfLifeDays?: number,
  ): Promise<MemorySearchResult[]> {
    const doSearch = async (): Promise<MemorySearchResult[]> => {
      // 方案 4 第一轮：仅搜当前会话的 session 级条目
      if (sessionId) {
        const sessionResults = await this.episodic.search(query, topK, {
          sessionId,
          scope: 'session',
          recencyHalfLifeDays,
        });
        if (sessionResults.length > 0) return sessionResults;
      }
      // 第二轮兜底：搜全局（含 global 条目 + 当前 session 可见条目）
      return this.episodic.search(query, topK, {
        sessionId,
        recencyHalfLifeDays,
      });
    };

    try {
      return await Promise.race([
        doSearch(),
        new Promise<MemorySearchResult[]>((resolve) =>
          setTimeout(() => resolve([]), timeoutMs),
        ),
      ]);
    } catch {
      return [];
    }
  }
}