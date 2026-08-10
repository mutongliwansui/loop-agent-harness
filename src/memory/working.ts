// L1 Working Memory：当前会话的上下文窗口管理
// 核心机制：token 超阈值时，先让 LLM 提取关键信息 flush 到 L2，再压缩
import type { ChatMessage } from '../types.js';
import type { WorkingMemoryConfig, ILLMClient } from './types.js';
import { DEFAULT_WORKING_CONFIG } from './types.js';

export class WorkingMemory {
  private config: WorkingMemoryConfig;

  constructor(config: WorkingMemoryConfig = DEFAULT_WORKING_CONFIG) {
    this.config = config;
  }

  /** 估算当前 token 用量（简化版：字符数 / 4） */
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((acc, m) => {
      const content = m.content ?? '';
      return acc + Math.ceil(content.length / 4);
    }, 0);
  }

  /** 是否需要压缩 */
  needsCompaction(messages: ChatMessage[]): boolean {
    return this.estimateTokens(messages) >= this.config.maxTokens * this.config.compactionThreshold;
  }

  /**
   * Pre-compaction Flush：关键机制
   * 不是简单截断旧消息，而是先让 LLM 把重要信息"存档"再丢
   * 返回提取出的结构化笔记文本，供写入 L2
   */
  async preCompactionFlush(
    messages: ChatMessage[],
    llm: ILLMClient,
  ): Promise<string> {
    const flushPrompt = `你正在压缩对话历史。请将以下对话中的关键信息提取为结构化笔记，保留：
- 用户表达的稳定偏好和约束
- 已确认的事实和决策
- 未完成的任务和目标
- 工具调用的关键结果

忽略：闲聊、重复确认、临时中间结果。
输出格式：纯文本，每条一行，以 "- " 开头。`;

    const extractMessages: ChatMessage[] = [
      { role: 'system', content: flushPrompt },
      ...messages,
    ];

    try {
      const response = await llm.chat(extractMessages);
      return response.content ?? '';
    } catch {
      return '';
    }
  }

  /**
   * 压缩：保留 system + 最近 N 轮对话
   * 每轮 = user 消息及其对应的 assistant/tool 消息
   */
  compact(messages: ChatMessage[]): ChatMessage[] {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    // 从后向前分轮：以 user 消息为一轮的起点
    const turns: ChatMessage[][] = [];
    let currentTurn: ChatMessage[] = [];

    for (let i = nonSystem.length - 1; i >= 0; i--) {
      currentTurn.unshift(nonSystem[i]);
      if (nonSystem[i].role === 'user' && currentTurn.length > 1) {
        turns.unshift(currentTurn);
        currentTurn = [];
        if (turns.length >= this.config.keepRecentTurns) break;
      }
    }
    // 处理剩余的不成轮消息
    if (currentTurn.length > 0) {
      turns.unshift(currentTurn);
    }

    const result: ChatMessage[] = [];
    if (systemMsg) result.push(systemMsg);
    result.push(...turns.flat());
    return result;
  }

  /** 获取当前配置 */
  getConfig(): WorkingMemoryConfig {
    return { ...this.config };
  }
}