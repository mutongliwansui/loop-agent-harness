// 流式 chunk → 事件派发
// Task-20260930-001：补齐「工具调用参数生成」阶段的可见进度（Thought 文本结束 → [Action] 之间的空窗）
import type { AgentEvents, LLMResponse, StreamChunk } from '../types.js';

/** tool_calls 参数生成的累积状态（按 tool_call index 维度） */
export interface ToolCallGenTracker {
  /** index → 工具名（首帧 name 可能为空，后续 chunk 补全） */
  nameByIndex: Map<number, string>;
  /** index → 已累积参数字节数 */
  bytesByIndex: Map<number, number>;
  /** 本轮参数生成起始时间戳（0 表示尚未开始） */
  startTs: number;
}

export function createToolCallGenTracker(): ToolCallGenTracker {
  return { nameByIndex: new Map(), bytesByIndex: new Map(), startTs: 0 };
}

/**
 * 将单个流式 chunk 派发为对应事件：
 * - `delta` → `onLLMStream`
 * - `toolCallStart` → 记录工具名与起始时间（不产生输出）
 * - `toolCallDelta` → 累积字节并派发 `onToolCallDelta`（生成参数阶段的可见进度）
 * - `done` → 返回完整响应
 *
 * @returns 若为 `done` 则返回 `LLMResponse`，否则返回 `null`
 */
export async function dispatchStreamChunk(
  chunk: StreamChunk,
  tracker: ToolCallGenTracker,
  events: Required<AgentEvents>,
): Promise<LLMResponse | null> {
  switch (chunk.type) {
    case 'delta':
      await events.onLLMStream(chunk.content);
      return null;

    case 'toolCallStart':
      if (tracker.startTs === 0) tracker.startTs = Date.now();
      if (chunk.name) tracker.nameByIndex.set(chunk.index, chunk.name);
      return null;

    case 'toolCallDelta': {
      if (tracker.startTs === 0) tracker.startTs = Date.now();
      const name = tracker.nameByIndex.get(chunk.index) ?? '工具';
      const bytes =
        (tracker.bytesByIndex.get(chunk.index) ?? 0) +
        Buffer.byteLength(chunk.argumentsDelta ?? '', 'utf8');
      tracker.bytesByIndex.set(chunk.index, bytes);
      await events.onToolCallDelta(name, bytes, Date.now() - tracker.startTs);
      return null;
    }

    case 'done':
      return chunk.response;
  }
}
