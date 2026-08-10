// ContextAssembler：上下文组装
// 每次 LLM 调用前组装完整 context：L3 常驻 + L2 检索 + L1 当前
import type { ChatMessage } from '../types.js';
import type { SkillMetadata } from '../skill/types.js';
import type { MemorySearchResult } from './types.js';
import { CuratedMemory } from './curated.js';
import { EpisodicMemory } from './episodic.js';
import { buildSystemPrompt } from '../agent/prompt.js';

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

    // 3. 组装完整 messages
    const finalSystemPrompt = basePrompt + curatedSection + memorySection;

    const messages: ChatMessage[] = [
      { role: 'system', content: finalSystemPrompt },
      ...currentMessages.filter((m) => m.role !== 'system'),
    ];

    return messages;
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