// ContextAssembler：上下文组装
// 每次 LLM 调用前组装完整 context：L3 常驻 + L2 检索 + L1 当前
import type { ChatMessage } from '../types.js';
import type { SkillMetadata } from '../skill/types.js';
import type { MemorySearchResult } from './types.js';
import { CuratedMemory } from './curated.js';
import { EpisodicMemory } from './episodic.js';
import { withMemorySection } from './memory-section.js';
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

/**
 * 消息序列验证与修复
 *
 * 问题：当消息被持久化/恢复时，去重逻辑可能导致 assistant(tool_calls) 消息被错误移除，
 * 但其对应的 tool 消息仍然存在，造成 "tool must be response to preceding tool_calls" 错误。
 *
 * 修复策略：
 * 1. 扫描消息序列，收集所有 assistant(tool_calls) 中的 tool_call_id
 * 2. 对每条 tool 消息，检查其 tool_call_id 是否存在于前置 assistant 的 tool_calls 中
 * 3. 若 tool 的 tool_call_id 在任何前置 assistant 中找不到 → 移除该 tool 消息（孤立 tool）
 * 4. 若 assistant(tool_calls) 的所有 tool_call_id 都已被对应 tool 消息消费 → 保留
 */
export function repairMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;

  // 收集每个 assistant(tool_calls) 中的 tool_call_id，以及它们在数组中的位置
  const toolCallMap = new Map<string, number>(); // tool_call_id → assistant 消息的索引

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        toolCallMap.set(tc.id, i);
      }
    }
  }

  // 检查每条 tool 消息，看其 tool_call_id 是否在前置 assistant 中存在
  const validIndices = new Set<number>();
  const orphanToolIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      const toolId = msg.tool_call_id;
      const assistantIdx = toolCallMap.get(toolId);
      if (assistantIdx !== undefined && assistantIdx < i) {
        // 找到对应的 assistant，且在 tool 之前 → 合法
        validIndices.add(i);
      } else {
        // 孤立的 tool 消息，对应的 assistant 不存在或在 tool 之后
        orphanToolIndices.push(i);
      }
    } else {
      // 非 tool 消息直接保留
      validIndices.add(i);
    }
  }

  // 过滤掉孤立的 tool 消息
  let result = messages;
  if (orphanToolIndices.length > 0) {
    result = messages.filter((_, i) => validIndices.has(i));
  }

  // 清理 assistant 中已无对应 tool 消息的 tool_calls（含部分孤立场景）
  const validToolCallIds = new Set(
    result
      .filter((m) => m.role === 'tool')
      .map((m) => (m as { tool_call_id: string }).tool_call_id),
  );

  let changed = false;
  const finalResult = result.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const remainingCalls = msg.tool_calls.filter((tc) => validToolCallIds.has(tc.id));
      if (remainingCalls.length < msg.tool_calls.length) {
        changed = true;
        return { ...msg, tool_calls: remainingCalls };
      }
    }
    return msg;
  });

  return changed || orphanToolIndices.length > 0 ? finalResult : messages;
}

export class ContextAssembler {
  private curated: CuratedMemory;
  private episodic: EpisodicMemory;

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
      curatedContent = await this.curated.buildSystemPrompt();
    } catch {
      // L3 读取失败不影响主流程
    }

    const basePrompt = buildSystemPrompt(skills);
    const curatedSection = curatedContent
      ? `\n\n## 你的长期记忆（Curated Memory）\n以下是关于你服务的用户和积累的知识，请在回答时参考：\n${curatedContent}`
      : '';

    // 2. L2 检索：召回相关历史片段
    // Task-19 三层防线：短查询保护 → 查询增强 → 最低阈值过滤
    let memoryBlock = '';
    try {
      // 方案 1：查询增强——拼接最近 N 轮对话，使搜索词更有区分度
      let searchQuery = userMessage;
      if (queryEnhanceRounds > 0) {
        const recentMsgs = currentMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-queryEnhanceRounds * 2);
        if (recentMsgs.length > 0) {
          const contextStr = recentMsgs
            .map(m => typeof m.content === 'string' ? m.content : '')
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

    // 3. 组装完整 messages + 修复损坏的 tool-assistant 配对
    // L2 检索结果不注入 system prompt：system 前缀必须保持稳定才能命中 DeepSeek 前缀缓存。
    // 检索结果改为附加到最后一条 user 消息之前（通常即本次用户输入），避免污染 system 前缀。
    const finalSystemPrompt = basePrompt + curatedSection;

    const rawMessages: ChatMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...currentMessages.filter((m) => m.role !== 'system'),
    ];

    if (memoryBlock) {
      // 拼接/剥离格式约定见 memory-section.ts（SessionStore 生成会话标题时依赖哨兵剥离前缀）
      const lastUserIdx = rawMessages.reduceRight(
        (acc, m, i) => (acc === -1 && m.role === 'user' ? i : acc),
        -1,
      );
      if (lastUserIdx >= 0 && rawMessages[lastUserIdx].role === 'user') {
        const lastUser = rawMessages[lastUserIdx];
        rawMessages[lastUserIdx] = {
          ...lastUser,
          content: withMemorySection(memoryBlock, lastUser.content),
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