// L1 Working Memory：当前会话的上下文窗口管理
// 核心机制：token 超阈值时，先让 LLM 提取关键信息 flush 到 L2，再压缩
import type { ChatMessage } from '../types.js';
import type { WorkingMemoryConfig, ILLMClient } from './types.js';
import { DEFAULT_WORKING_CONFIG } from './types.js';
import { debug } from '../debug.js';
import { buildCompactionPayload } from './compaction-payload.js';
import { isSummaryMessage, SUMMARY_TRUNCATE_MAX_CHARS } from './summary-message.js';

/** 摘要占位消息的固定前缀（内存压缩与磁盘恢复共用的临时上下文占位） */
export const SUMMARY_PLACEHOLDER_PREFIX = '[历史摘要]';

/**
 * 判断是否为摘要占位/总结消息（与落盘层共用 isSummaryMessage，避免两处判据不一致）。
 * 显式标记为 kind='summary'；旧数据回退到「role=user 且 is_show=false」。
 */
export function isSummaryPlaceholder(msg: ChatMessage): boolean {
  return isSummaryMessage(msg);
}

/** 压缩计划：本次将被丢弃的消息 + 已有摘要（供 flush 构造请求载荷） */
export interface CompactionPlan {
  /** 本次压缩将被丢弃的消息（已排除 system / 摘要占位） */
  droppable: ChatMessage[];
  /** 本次压缩保留的消息（droppable + kept 恰好是参与压缩的全部消息） */
  kept: ChatMessage[];
  /** 已有摘要文本（[历史摘要] 占位去掉前缀后的内容） */
  previousSummary?: string;
  /** 将被丢弃的消息数；0 表示本次压缩是空操作，不应调用 LLM */
  droppedCount: number;
  /**
   * 是否走了「单次调用内按 token 预算截尾」：
   * 只剩 1 次模型调用仍超预算（单次调用内工具输出过大）时启用，
   * 此时 compact 必须用 kept 作为保留后缀，不能再用 keepRecentTurns 重新切分。
   * 该模式下当前轮的原始 user 消息会作为任务锚点被固定保留（见 planCompaction）。
   */
  withinTurnTrim?: boolean;
}

export interface CompactedViewOptions {
  /** 保留最近多少次模型调用（每条 assistant 消息 = 1 次，其前导 user 与后续 tool 归入同一次） */
  keepRecentTurns: number;
  /** 头部被裁剪部分的摘要文本；为空则不注入占位 */
  summaryText?: string;
  /** 消息里没有 system 时的兜底 system prompt */
  systemPrompt?: string;
  /**
   * 显式指定保留的消息后缀（单次调用内按 token 截尾时使用）。
   * 提供时忽略 keepRecentTurns 切分，直接以该数组作为保留部分。
   */
  keptMessages?: ChatMessage[];
}

/** 一次模型调用组：前导 user（若有）+ assistant + 其后连续 tool 结果 */
interface CallGroup {
  start: number;
  end: number;
}

/**
 * 按「模型调用」切分消息：每条 assistant 消息 = 1 次调用，
 * 其前导 user 归入该次调用，其后连续的 tool 结果整组跟随。
 * 组边界永远「assistant 起、tool 止」，保证 tool_calls / tool 配对不被截断。
 */
function segmentCallGroups(messages: ChatMessage[]): CallGroup[] {
  const groups: CallGroup[] = [];
  let start = 0;
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role === 'assistant') {
      let end = i;
      while (end + 1 < messages.length && messages[end + 1].role === 'tool') end++;
      groups.push({ start, end });
      start = end + 1;
      i = end + 1;
    } else {
      // user / 孤立 tool：作为下一次调用的前缀
      i++;
    }
  }
  // 尾部残留（最后一条 user 尚未被回复）并入最后一组：它不构成一次模型调用，
  // 不应占用 keepRecentTurns 名额，且必须始终保留
  if (start < messages.length) {
    if (groups.length > 0) {
      groups[groups.length - 1].end = messages.length - 1;
    } else {
      groups.push({ start, end: messages.length - 1 });
    }
  }
  return groups;
}

/**
 * 保留最近 keepCalls 次模型调用，返回保留区起点。
 * 调用次数不足时整段保留（keptStart = 0）。
 */
function pickRecentCallGroups(
  messages: ChatMessage[],
  keepCalls: number,
): { groups: CallGroup[]; keptGroups: number; keptStart: number } {
  const groups = segmentCallGroups(messages);
  if (groups.length === 0) return { groups, keptGroups: 0, keptStart: 0 };
  const keptGroups = Math.max(1, Math.min(keepCalls, groups.length));
  return {
    groups,
    keptGroups,
    keptStart: groups[groups.length - keptGroups].start,
  };
}

/**
 * 估算消息 token（简化版：字符数 / 4，与 WorkingMemory.estimateTokens 同口径）。
 * 需求 20261106-005：API 层对历史会话做估算兜底时复用同一口径。
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + Math.ceil((m.content ?? '').length / 4), 0);
}

/**
 * 把截尾起点对齐到「工具组」边界。
 *
 * 组 = assistant(tool_calls) + 其后连续的 tool 结果。起点落在 tool 上时有两种取法：
 * - 整组保留：回退到该组 assistant，但会把整组 token 拉回保留区（可能远超预算）
 * - 整组丢弃：前移到该组最后一个 tool 之后，保留区一定不超预算
 * 默认整组丢弃；只有整组丢弃会把保留区清空（这是最后一组）时才整组保留，
 * 否则当前迭代拿不到最新的 observation。
 */
function snapToGroupBoundary(messages: ChatMessage[], start: number): number {
  if (start >= messages.length || messages[start].role !== 'tool') return start;
  let groupStart = start;
  while (groupStart > 0 && messages[groupStart].role === 'tool') groupStart--;
  let groupEnd = start;
  while (groupEnd + 1 < messages.length && messages[groupEnd + 1].role === 'tool') {
    groupEnd++;
  }
  const dropped = groupEnd + 1 < messages.length;
  const snapped = dropped ? groupEnd + 1 : groupStart;
  debug.log(
    `[L1 trimTailByTokenBudget] 起点${start}落在工具组内（${groupStart}~${groupEnd}），` +
      `${dropped ? `整组丢弃→起点${snapped}` : `整组保留→起点${snapped}（超出预算，最后一组必留）`}`,
  );
  return snapped;
}

/**
 * 单轮内按 token 预算截尾：从尾部累积保留，直到再加一条就超出预算。
 * 起点落在 tool 消息上时按「工具组整体」取舍，保证 tool_calls / tool 配对不被截断。
 */
function trimTailByTokenBudget(
  messages: ChatMessage[],
  tokenBudget: number,
): { kept: ChatMessage[]; start: number } {
  let acc = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = Math.ceil((messages[i].content ?? '').length / 4);
    if (start < messages.length && acc + t > tokenBudget) break;
    acc += t;
    start = i;
  }
  start = snapToGroupBoundary(messages, start);
  return { kept: messages.slice(start), start };
}

/**
 * 统一压缩视图：内存压缩与磁盘恢复共用同一形态。
 * 输出 = [system, (摘要占位 · kind='summary'、is_show=false), 最近 N 次模型调用]
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

  // 1) 提取已有占位（本轮已压缩过）：重复压缩时若头部无新丢弃，仍需保留占位，
  //    否则落盘链路（updateSession 靠 kind='summary' 识别压缩轮次）会漏写总结消息
  const existingPlaceholder = messages.find((m) => isSummaryPlaceholder(m));

  // 清掉旧占位与旧总结消息（由本次新摘要取代），system 不参与切分
  const nonSystem = messages.filter(
    (m) => m.role !== 'system' && m.is_show !== false,
  );

  // 2) 确定保留部分：优先用调用方显式给定的后缀（单次调用内 token 截尾），
  //    否则保留最近 N 次模型调用
  let kept: ChatMessage[];
  let droppedCount: number;
  let callCount = 0;
  if (opts.keptMessages) {
    kept = opts.keptMessages;
    droppedCount = Math.max(0, nonSystem.length - kept.length);
  } else {
    const picked = pickRecentCallGroups(nonSystem, opts.keepRecentTurns);
    kept = nonSystem.slice(picked.keptStart);
    callCount = picked.keptGroups;
    // 任务锚点：当前轮原始 user 若落在丢弃区，pin 回保留区头部（与 planCompaction 同口径）
    const lastUserIdx = nonSystem.reduceRight(
      (acc, m, i) => (acc === -1 && m.role === 'user' ? i : acc),
      -1,
    );
    if (lastUserIdx >= 0 && lastUserIdx < picked.keptStart) {
      kept = [nonSystem[lastUserIdx], ...kept];
    }
    droppedCount = nonSystem.length - kept.length;
  }

  const result: ChatMessage[] = [];
  if (systemMsg) result.push(systemMsg);

  // 3) 注入摘要占位：有新摘要用新摘要；无新摘要但输入已有占位（重复压缩）时沿用原摘要文本，
  //    保证占位不丢失；条件为「有丢弃」或「输入已有占位」，二者满足其一且摘要非空即注入。
  //    占位与已落盘总结消息统一用 kind='summary' 标记（is_show=false 不展示），落盘时仅需剥离 [历史摘要] 前缀。
  let summary = opts.summaryText?.trim();
  if (!summary && existingPlaceholder) {
    const text = typeof existingPlaceholder.content === 'string' ? existingPlaceholder.content : '';
    summary = text.startsWith(SUMMARY_PLACEHOLDER_PREFIX)
      ? text.slice(SUMMARY_PLACEHOLDER_PREFIX.length).trim()
      : text.trim();
  }
  if ((droppedCount > 0 || existingPlaceholder) && summary) {
    result.push({
      role: 'user',
      // 正常摘要已由压缩指令约束在 SUMMARY_MAX_CHARS 内；此处按上浮 20% 兜底硬截断
      content: `${SUMMARY_PLACEHOLDER_PREFIX} ${summary.slice(0, SUMMARY_TRUNCATE_MAX_CHARS)}`,
      is_show: false,
      kind: 'summary',
    });
  }

  result.push(...kept);
  // 关键排查信息：丢弃为 0 说明切分窗口装下了全部消息，此时压缩是空操作（只有占位被沿用）
  debug.log(
    `[L1 buildCompactedView] 输入=${messages.length}条 参与切分=${nonSystem.length}条 ` +
      `保留=${kept.length}条${opts.keptMessages ? '(显式后缀)' : `/${callCount}次调用`} 丢弃=${droppedCount}条 ` +
      `已有占位=${existingPlaceholder ? '有' : '无'} 新摘要=${opts.summaryText ? `${opts.summaryText.length}字` : '无'} ` +
      `注入占位=${(droppedCount > 0 || existingPlaceholder) && summary ? '是' : '否'} 输出=${result.length}条`,
  );
  return result;
}

export class WorkingMemory {
  private config: WorkingMemoryConfig;

  constructor(config: WorkingMemoryConfig = DEFAULT_WORKING_CONFIG) {
    this.config = config;
  }

  /** 估算当前 token 用量（简化版：字符数 / 4） */
  estimateTokens(messages: ChatMessage[]): number {
    return estimateMessageTokens(messages);
  }

  /** 是否需要压缩 */
  needsCompaction(messages: ChatMessage[]): boolean {
    return this.estimateTokens(messages) >= this.config.maxTokens * this.config.compactionThreshold;
  }

  /**
   * 计算本次压缩计划。
   *
   * 保留粒度 = 一次模型调用（每条 assistant 消息 = 1 次调用，其前导 user 与后续 tool 归入该次），
   * 先保留最近 keepRecentTurns 次调用；若仍超 messageTokensBudget 则继续减少保留次数（保底 1 次），
   * 只有「单次调用自身就超预算」（如超大工具输出）时才退回单次内按 token 截尾兜底。
   *
   * 任务锚点：当前轮的原始 user 消息若落在丢弃区，无条件 pin 回保留区头部
   * （只靠摘要会让剩余迭代丢失精确约束，锚点过大时允许轻微超预算）。
   */
  planCompaction(
    messages: ChatMessage[],
    opts?: { messageTokensBudget?: number },
  ): CompactionPlan {
    // 与 buildCompactedView 保持同一过滤口径，保证 droppable 恰好等于后续被丢弃的部分
    const nonSystem = messages.filter(
      (m) => m.role !== 'system' && m.is_show !== false,
    );
    const budget = opts?.messageTokensBudget;
    const picked = pickRecentCallGroups(nonSystem, this.config.keepRecentTurns);
    let keptGroups = picked.keptGroups;
    let keptStart = picked.keptStart;

    // 按调用次数保留后若仍超预算，继续少留一次调用（保底 1 次，交给下面的单次截尾兜底）
    if (budget !== undefined && budget > 0) {
      while (
        keptGroups > 1 &&
        estimateMessageTokens(nonSystem.slice(keptStart)) > budget
      ) {
        keptGroups--;
        keptStart = picked.groups[picked.groups.length - keptGroups].start;
      }
    }

    // 保留预算取消息预算的 60%，给压缩后重新注入的摘要占位留出余量
    const keepBudget = Math.max(1, Math.floor((budget ?? 0) * 0.6));
    let withinTurnTrim = false;

    // 最后兜底：只剩 1 次调用仍超预算 → 单次调用内按 token 截尾
    if (
      budget !== undefined &&
      budget > 0 &&
      keptGroups === 1 &&
      estimateMessageTokens(nonSystem.slice(keptStart)) > budget
    ) {
      const trimmed = trimTailByTokenBudget(nonSystem, keepBudget);
      if (trimmed.start > 0) {
        withinTurnTrim = true;
        keptStart = trimmed.start;
      }
    }

    let droppable = nonSystem.slice(0, keptStart);
    let kept = nonSystem.slice(keptStart);

    // 任务锚点：当前轮的原始 user 即最后一条 user，它若落在丢弃区则 pin 回保留区头部
    const lastUserIdx = nonSystem.reduceRight(
      (acc, m, i) => (acc === -1 && m.role === 'user' ? i : acc),
      -1,
    );
    if (lastUserIdx >= 0 && lastUserIdx < keptStart) {
      const anchor = nonSystem[lastUserIdx];
      const anchorTokens = Math.ceil((anchor.content ?? '').length / 4);
      if (withinTurnTrim) {
        // 扣掉锚点 token 重新截尾，尽量让「锚点 + 后缀」仍控制在原保留预算的量级
        const retrim = trimTailByTokenBudget(
          nonSystem,
          Math.max(1, keepBudget - anchorTokens),
        );
        keptStart = retrim.start;
      }
      // 锚点无条件保留：丢失精确的原始问题比多占 token 更严重，允许因此轻微超预算
      droppable = nonSystem.slice(0, keptStart).filter((m) => m !== anchor);
      kept = [anchor, ...nonSystem.slice(keptStart).filter((m) => m !== anchor)];
      debug.log(
        `[L1 planCompaction] 固定保留当前轮 user 锚点（${anchorTokens} tokens），` +
          `摘要覆盖其余 ${droppable.length} 条`,
      );
    }

    if (withinTurnTrim) {
      debug.log(
        `[L1 planCompaction] 单次调用内 token 截尾：消息 ${estimateMessageTokens(nonSystem)} tokens > 预算 ${budget}，` +
          `保留后缀 ${kept.length} 条（约 ${estimateMessageTokens(kept)} tokens）、丢弃 ${droppable.length} 条`,
      );
    } else if (budget !== undefined && budget > 0 && keptStart > 0) {
      debug.log(
        `[L1 planCompaction] 按模型调用保留：消息 ${estimateMessageTokens(nonSystem)} tokens / 预算 ${budget}，` +
          `保留最近 ${keptGroups} 次调用（${kept.length} 条、约 ${estimateMessageTokens(kept)} tokens）、丢弃 ${droppable.length} 条`,
      );
    }

    const placeholder = messages.find((m) => isSummaryPlaceholder(m));
    let previousSummary: string | undefined;
    if (placeholder) {
      const text = typeof placeholder.content === 'string' ? placeholder.content : '';
      previousSummary = text.startsWith(SUMMARY_PLACEHOLDER_PREFIX)
        ? text.slice(SUMMARY_PLACEHOLDER_PREFIX.length).trim()
        : text.trim();
    }

    return {
      droppable,
      kept,
      previousSummary,
      droppedCount: droppable.length,
      withinTurnTrim,
    };
  }

  /**
   * Pre-compaction Flush：关键机制
   * 不是简单截断旧消息，而是先让 LLM 把重要信息"存档"再丢。
   * 请求固定为 2 条消息：system 指令 + user(将被丢弃消息的 JSON)，返回提取出的笔记文本。
   * 本次没有要丢弃的消息时不调用 LLM，返回空串。
   */
  async preCompactionFlush(
    messages: ChatMessage[],
    llm: ILLMClient,
    plan?: CompactionPlan,
  ): Promise<string> {
    const resolved = plan ?? this.planCompaction(messages);
    if (resolved.droppedCount === 0) {
      debug.log('[L1 preCompactionFlush] 本次无可丢弃消息，跳过 flush（不调用 LLM）');
      return '';
    }

    const { messages: extractMessages, stats } = buildCompactionPayload(
      resolved.droppable,
      resolved.previousSummary,
    );
    if (stats.outputCount === 0) {
      debug.log(
        `[L1 preCompactionFlush] 可丢弃 ${stats.inputCount} 条消息均为空/不可用，跳过 flush（不调用 LLM）`,
      );
      return '';
    }
    debug.log(
      `[L1 preCompactionFlush] 请求=${extractMessages.length}条消息 可丢弃=${stats.inputCount}条 ` +
        `输出=${stats.outputCount}条 JSON=${stats.jsonChars}字 旧摘要=${resolved.previousSummary ? `${resolved.previousSummary.length}字` : '无'} ` +
        `截断tool=${stats.truncatedTools} 截断args=${stats.truncatedArgs} ` +
        `用show_content=${stats.usedShowContent} 剥离记忆前缀=${stats.strippedMemory} ` +
        `降级(删tool/截assistant/截user/删消息)=${stats.omittedTools}/${stats.truncatedAssistants}/${stats.truncatedUsers}/${stats.omittedMessages}`,
    );

    try {
      // 优先流式调用（长非流式连接在部分后端/代理下易被截断）；adapter 未实现时回退非流式
      const response = llm.chatViaStream
        ? await llm.chatViaStream(extractMessages)
        : await llm.chat(extractMessages);
      return response.content ?? '';
    } catch (e) {
      // 取消冒泡例外（Task-20261021-002-02）：abort 不算「提取失败」，
      // 吞掉它会让压缩期取消退化为正常压缩继续执行（用户感知"停不下来"）
      if (
        (e as { aborted?: boolean }).aborted === true ||
        (e as { name?: string }).name === 'AbortError'
      ) {
        throw e;
      }
      return '';
    }
  }

  /**
   * 压缩：保留 system + 最近 N 次模型调用
   * 每次调用 = 前导 user（若有）+ assistant + 其后的 tool 结果
   *
   * 传入 plan 时保留部分直接用 plan.kept（含任务锚点与预算收缩后的结果），
   * 与 planCompaction 算出的 droppable 严格互补，避免「摘要了却仍留在上下文」。
   */
  compact(
    messages: ChatMessage[],
    summaryText?: string,
    plan?: CompactionPlan,
  ): ChatMessage[] {
    return buildCompactedView(messages, {
      keepRecentTurns: this.config.keepRecentTurns,
      summaryText,
      keptMessages: plan?.kept,
    });
  }

  /** 获取当前配置 */
  getConfig(): WorkingMemoryConfig {
    return { ...this.config };
  }
}