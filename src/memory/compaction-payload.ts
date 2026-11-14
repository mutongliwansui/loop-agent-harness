// Pre-compaction Flush 的请求载荷构造
//
// 目的：压缩请求不再直接透传原始会话消息，而是固定为 2 条消息：
//   1) system：固定的压缩指令（含旧摘要合并要求）
//   2) user：本次「将被丢弃」的消息列表 + 旧摘要，序列化为 JSON 文本
// 好处：上下文可控（截断 + 总长度上限），旧摘要不会因二次压缩被覆盖而丢失。
import type { ChatMessage } from '../types.js';
import { stripMemorySection } from './memory-section.js';
import { SUMMARY_MAX_CHARS } from './summary-message.js';

/** 压缩请求的固定 system prompt（必须保留「压缩对话历史」字样，测试与日志据此识别 flush 请求） */
export const FLUSH_SYSTEM_PROMPT = `你正在压缩对话历史。下面这条 user 消息是一个 JSON：
- previousSummary：此前压缩生成的摘要（可能为空），必须与本次要点合并去重后输出；
  其中以 [当前问题] 起头的段落是历史轮次的原始用户问题，请作为要点合并，不要原样照抄该标记
- messages：本次将被丢弃的对话消息列表（已做精简处理）

请提取并合并关键信息，保留：
- 用户表达的稳定偏好和约束
- 已确认的事实和决策
- 未完成的任务和目标
- 工具调用的关键结果

忽略：闲聊、重复确认、临时中间结果。
注意：当前轮的原始用户问题会由系统单独追加在摘要之后，无需在摘要中复述；
但若 previousSummary 中 [当前问题] 起头的段落所述问题已无法在 messages 中找到（多轮压缩后的历史问题），须把它的要点合并进摘要，不要丢弃。
输出格式：纯文本，每条一行，以 "- " 开头；不要输出 JSON、标题或解释。
长度约束：总字数控制在 ${SUMMARY_MAX_CHARS} 字以内，超出时优先保留偏好/结论/未完成任务，舍弃次要细节。`;

/** 工具执行结果单条最大字符数 */
export const TOOL_RESULT_MAX_CHARS = 200;

/** 工具调用参数单条最大字符数 */
export const TOOL_ARGS_MAX_CHARS = 200;

/** 压缩载荷（消息2 的 JSON 文本）总长度上限 */
export const MAX_PAYLOAD_CHARS = 12000;

/** D4 最后一档降级时，正文压缩到的字符数 */
const HARD_CONTENT_MAX_CHARS = 200;

export interface FlushPayloadStats {
  /** 传入的候选消息数 */
  inputCount: number;
  /** 最终进入 JSON 的消息数 */
  outputCount: number;
  /** 最终 JSON 字符数 */
  jsonChars: number;
  /** 被 200 字截断的 tool 结果数 */
  truncatedTools: number;
  /** 被 200 字截断的 tool_calls.arguments 数 */
  truncatedArgs: number;
  /** 使用 show_content 的 user 消息数 */
  usedShowContent: number;
  /** 剥离 L2 记忆前缀的 user 消息数 */
  strippedMemory: number;
  /** 被过滤掉的消息数（system/摘要占位/空消息等） */
  skipped: number;
  /** D4 降级中删除的 tool 消息数 */
  omittedTools: number;
  /** D4 降级中截断的 assistant 正文数 */
  truncatedAssistants: number;
  /** D4 降级中截断的 user 正文数 */
  truncatedUsers: number;
  /** D4 兜底中整条删除的消息数 */
  omittedMessages: number;
}

export interface CompactionPayload {
  /** 固定 2 条：system 指令 + user(JSON 文本) */
  messages: ChatMessage[];
  stats: FlushPayloadStats;
}

/** 序列化后的消息条目 */
interface PayloadEntry {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  name?: string;
  tool_calls?: Array<{ name: string; arguments: string }>;
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…[已截断，原 ${text.length} 字]`, truncated: true };
}

/** 收集 tool_call_id → 工具名（tool 消息自身没有 name 字段） */
function collectToolNames(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) names.set(tc.id, tc.function.name);
    }
  }
  return names;
}

/** 按 D3 规则把原始消息转换为精简条目 */
function toPayloadEntries(
  messages: ChatMessage[],
  stats: FlushPayloadStats,
): PayloadEntry[] {
  const toolNames = collectToolNames(messages);
  const entries: PayloadEntry[] = [];

  for (const m of messages) {
    if (m.role === 'system' || m.is_show === false || m.is_compact === true) {
      stats.skipped++;
      continue;
    }

    if (m.role === 'user') {
      const raw = typeof m.content === 'string' ? m.content : '';
      let content = raw;
      // 规则1：优先取 show_content（前端可见的真实用户输入），内存消息通常没有该字段
      if (typeof m.show_content === 'string' && m.show_content.trim()) {
        content = m.show_content;
        stats.usedShowContent++;
      } else {
        content = stripMemorySection(raw);
        if (content !== raw) stats.strippedMemory++;
      }
      if (!content.trim()) {
        stats.skipped++;
        continue;
      }
      entries.push({ role: 'user', content });
      continue;
    }

    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : '';
      const toolCalls = (m.tool_calls ?? []).map((tc) => {
        const args = truncateText(tc.function.arguments ?? '', TOOL_ARGS_MAX_CHARS);
        if (args.truncated) stats.truncatedArgs++;
        return { name: tc.function.name, arguments: args.text };
      });
      if (!content.trim() && toolCalls.length === 0) {
        stats.skipped++;
        continue;
      }
      const entry: PayloadEntry = { role: 'assistant' };
      if (content.trim()) entry.content = content;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      entries.push(entry);
      continue;
    }

    // role === 'tool'
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) {
      stats.skipped++;
      continue;
    }
    // 规则2：工具执行结果 200 字截断
    const truncated = truncateText(content, TOOL_RESULT_MAX_CHARS);
    if (truncated.truncated) stats.truncatedTools++;
    const entry: PayloadEntry = { role: 'tool', content: truncated.text };
    const name = toolNames.get(m.tool_call_id);
    if (name) entry.name = name;
    entries.push(entry);
  }

  return entries;
}

function serialize(entries: PayloadEntry[], previousSummary?: string): string {
  const summary = previousSummary?.trim();
  const payload: Record<string, unknown> = {};
  if (summary) payload.previousSummary = summary;
  payload.messages = entries;
  return JSON.stringify(payload);
}

/**
 * D4：总长度超限时按顺序降级
 * ① 移除最旧的 tool 消息 → ② 截断最旧的 assistant 正文 → ③ 截断最旧的 user 正文
 * ④ 兜底：仍超限则从最旧整条删除（保证上限，保留最近的上下文）
 */
function shrinkToLimit(
  entries: PayloadEntry[],
  previousSummary: string | undefined,
  stats: FlushPayloadStats,
): string {
  let json = serialize(entries, previousSummary);
  if (json.length <= MAX_PAYLOAD_CHARS) return json;

  for (let i = 0; i < entries.length && json.length > MAX_PAYLOAD_CHARS; ) {
    if (entries[i].role === 'tool') {
      entries.splice(i, 1);
      stats.omittedTools++;
      json = serialize(entries, previousSummary);
    } else {
      i++;
    }
  }

  for (const role of ['assistant', 'user'] as const) {
    for (const entry of entries) {
      if (json.length <= MAX_PAYLOAD_CHARS) break;
      if (entry.role !== role || !entry.content || entry.content.length <= HARD_CONTENT_MAX_CHARS) continue;
      entry.content = truncateText(entry.content, HARD_CONTENT_MAX_CHARS).text;
      if (role === 'assistant') stats.truncatedAssistants++;
      else stats.truncatedUsers++;
      json = serialize(entries, previousSummary);
    }
  }

  while (entries.length > 0 && json.length > MAX_PAYLOAD_CHARS) {
    entries.shift();
    stats.omittedMessages++;
    json = serialize(entries, previousSummary);
  }

  return json;
}

/**
 * 构造压缩请求载荷。
 * @param droppable 本次将被丢弃的消息（不含 system；旧摘要通过 previousSummary 传入）
 * @param previousSummary 已有摘要文本（来自 [历史摘要] 占位）
 */
export function buildCompactionPayload(
  droppable: ChatMessage[],
  previousSummary?: string,
): CompactionPayload {
  const stats: FlushPayloadStats = {
    inputCount: droppable.length,
    outputCount: 0,
    jsonChars: 0,
    truncatedTools: 0,
    truncatedArgs: 0,
    usedShowContent: 0,
    strippedMemory: 0,
    skipped: 0,
    omittedTools: 0,
    truncatedAssistants: 0,
    truncatedUsers: 0,
    omittedMessages: 0,
  };

  const entries = toPayloadEntries(droppable, stats);
  const json = shrinkToLimit(entries, previousSummary, stats);

  stats.outputCount = entries.length;
  stats.jsonChars = json.length;

  return {
    messages: [
      { role: 'system', content: FLUSH_SYSTEM_PROMPT },
      { role: 'user', content: json },
    ],
    stats,
  };
}
