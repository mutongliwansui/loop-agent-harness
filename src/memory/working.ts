// L1 Working Memory：当前会话的上下文窗口管理
// 核心机制：token 超阈值时，先让 LLM 提取关键信息 flush 到 L2，再压缩
import type { ChatMessage } from '../types.js';
import type { WorkingMemoryConfig, ILLMClient } from './types.js';
import { DEFAULT_WORKING_CONFIG } from './types.js';

/** 摘要占位消息的固定前缀（内存压缩与磁盘恢复共用的临时上下文占位） */
export const SUMMARY_PLACEHOLDER_PREFIX = '[历史摘要]';

/** 摘要占位注入时的最大字符数（避免占位长期占用上下文 token） */
export const SUMMARY_PLACEHOLDER_MAX_CHARS = 500;

/**
 * 判断是否为临时占位消息。
 * 占位消息只在「给 LLM 的视图」中出现，写盘时必须过滤（见 SessionStore.updateSession）。
 */
export function isEphemeral(msg: ChatMessage): boolean {
  return msg.role === 'user' && msg.ephemeral === true;
}

export interface CompactedViewOptions {
  /** 保留最近多少轮（每轮 = 一条 user 及其后的 assistant/tool 消息） */
  keepRecentTurns: number;
  /** 头部被裁剪部分的摘要文本；为空则不注入占位 */
  summaryText?: string;
  /** 消息里没有 system 时的兜底 system prompt */
  systemPrompt?: string;
}

/**
 * 从后向前按 user 切轮，返回保留的轮次与被丢弃的消息数。
 * 与旧 compact() 语义一致：凑满 keepRecentTurns 轮即停止（头部轮次丢弃）；
 * 循环自然结束时剩余的头部残片保留（头部可能以 tool 开头），避免丢消息。
 */
function pickRecentTurns(
  messages: ChatMessage[],
  keepRecentTurns: number,
): { turns: ChatMessage[][]; droppedCount: number } {
  const turns: ChatMessage[][] = [];
  let currentTurn: ChatMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    currentTurn.unshift(messages[i]);
    if (messages[i].role === 'user' && currentTurn.length > 1) {
      turns.unshift(currentTurn);
      currentTurn = [];
      if (turns.length >= keepRecentTurns) break;
    }
  }
  if (currentTurn.length > 0) {
    turns.unshift(currentTurn);
  }

  const keptCount = turns.reduce((n, t) => n + t.length, 0);
  return { turns, droppedCount: messages.length - keptCount };
}

/**
 * 统一压缩视图：内存压缩与磁盘恢复共用同一形态。
 * 输出 = [system, (摘要占位 · ephemeral), 最近 N 轮]
 *
 * 单一出处的意义：避免「L1 压缩结果」与「磁盘恢复视图」两套参数、两种形态。
 */
export function buildCompactedView(
  messages: ChatMessage[],
  opts: CompactedViewOptions,
): ChatMessage[] {
  const systemMsg =
    messages.find((m) => m.role === 'system') ??
    (opts.systemPrompt ? { role: 'system' as const, content: opts.systemPrompt } : undefined);

  // 1) 清掉旧占位（多次压缩不堆积），system 不参与切轮
  const nonSystem = messages.filter((m) => m.role !== 'system' && !isEphemeral(m));

  // 2) 从后向前按 user 切轮，保留最近 N 轮
  const { turns, droppedCount } = pickRecentTurns(nonSystem, opts.keepRecentTurns);

  const result: ChatMessage[] = [];
  if (systemMsg) result.push(systemMsg);

  // 3) 头部确实被裁掉且有摘要 → 注入临时占位（截断后注入，避免长期吃 token）
  const summary = opts.summaryText?.trim();
  if (droppedCount > 0 && summary) {
    result.push({
      role: 'user',
      content: `${SUMMARY_PLACEHOLDER_PREFIX} ${summary.slice(0, SUMMARY_PLACEHOLDER_MAX_CHARS)}`,
      ephemeral: true,
    });
  }

  result.push(...turns.flat());
  return result;
}

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
      // 过滤掉原 messages 中的 system（主 system prompt），保证压缩 prompt 是唯一 system 且在首位
      //（部分模型后端严格要求 "System message must be at the beginning"，双 system 会 500）
      ...messages.filter((m) => m.role !== 'system'),
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
  compact(messages: ChatMessage[], summaryText?: string): ChatMessage[] {
    return buildCompactedView(messages, {
      keepRecentTurns: this.config.keepRecentTurns,
      summaryText,
    });
  }

  /** 获取当前配置 */
  getConfig(): WorkingMemoryConfig {
    return { ...this.config };
  }
}