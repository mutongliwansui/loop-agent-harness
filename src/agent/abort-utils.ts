// 中止收尾工具（Task-20261021-002-03；Task-20261029-001 从 src/api/ 下移至 src/agent/）：
//
// 位置说明：取消链路（AbortController/AgentAbortedError）本身在 agent 层，封口逻辑只依赖
// ChatMessage，与 HTTP/API 无关。CLI 也需要封口（Ctrl+C 中断后落盘部分输出），若留在
// src/api/ 会让 CLI 反向依赖 API 层，故下移到 agent 层由两端共用；
// src/api/abort-utils.ts 保留同名 re-export，既有引用方零改动。
//
// run 被取消时，partial.messages 的尾部可能形如
//   assistant(tool_calls=[A, B]) + tool(→A)
// ——B 没有对应 tool 响应。这种"孤立 tool_calls"直接落盘后，
// 下一轮发消息会触发 OpenAI 协议校验错误「tool must be response to preceding tool_calls」。
// sealPendingToolCalls 为每个未被响应的 tool_call 补一条合成 tool 消息（D3：补而非删），
// 保留"当时确实发起过该工具"的信息；与 restore 路径的 repairMessageSequence（删孤立）互补。

import type { ChatMessage } from '../types.js';

/** 为未被响应的 tool_call 补合成 tool 消息（内容标明取消），保证消息序自洽（D3） */
export function sealPendingToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set(
    messages
      .filter((m) => (m as { tool_call_id?: string }).tool_call_id !== undefined)
      .map((m) => (m as { tool_call_id?: string }).tool_call_id as string),
  );
  const out = [...messages];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (const tc of m.tool_calls) {
      if (!answered.has(tc.id)) {
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '（运行已被用户停止，该工具调用未完成）',
        });
      }
    }
  }
  return out;
}
