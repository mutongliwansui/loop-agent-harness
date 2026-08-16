// ContextAssembler：上下文组装
// 每次 LLM 调用前组装完整 context：L3 常驻 + L2 检索 + L1 当前
import type { ChatMessage } from '../types.js';
import type { SkillMetadata } from '../skill/types.js';
import type { MemorySearchResult } from './types.js';
import { CuratedMemory } from './curated.js';
import { EpisodicMemory } from './episodic.js';
import { buildSystemPrompt } from '../agent/prompt.js';

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
    } = {},
  ): Promise<ChatMessage[]> {
    const searchTopK = options.searchTopK ?? 3;
    const searchTimeoutMs = options.searchTimeoutMs ?? 500;

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

    // 2. L2 检索：召回相关历史片段（传递 sessionId 用于隔离）
    let memoryBlock = '';
    try {
      const retrieved = await this.safeSearch(userMessage, searchTopK, searchTimeoutMs, options.sessionId);
      if (retrieved.length > 0) {
        memoryBlock = retrieved.map((r) => r.content).join('\n');
      }
    } catch {
      // 检索失败不影响主流程
    }

    const memorySection = memoryBlock
      ? `\n\n## 相关历史记忆\n以下是你在之前会话中积累的相关信息，请参考：\n${memoryBlock}`
      : '';

    // 3. 组装完整 messages + 修复损坏的 tool-assistant 配对
    const finalSystemPrompt = basePrompt + curatedSection + memorySection;

    const rawMessages: ChatMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...currentMessages.filter((m) => m.role !== 'system'),
    ];

    return repairMessageSequence(rawMessages);
  }

  /** 带超时的安全检索（支持 sessionId 隔离） */
  private async safeSearch(
    query: string,
    topK: number,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<MemorySearchResult[]> {
    try {
      const result = await Promise.race([
        this.episodic.search(query, topK, { sessionId }),
        new Promise<MemorySearchResult[]>((resolve) =>
          setTimeout(() => resolve([]), timeoutMs),
        ),
      ]);
      return result;
    } catch {
      return [];
    }
  }
}