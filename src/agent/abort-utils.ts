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
// 保留"当时确实发起过该工具"的信息；与 restore 路径的 repairMessageSequence（按序配对）互补。
//
// 关键：协议要求合成 tool 消息必须「紧邻」其 assistant（而不是一律追加到数组末尾），
// 且 tool_call_id 可能在不同轮次重复（上游/缓存会复用 id），因此按「当前 assistant」作用域
// 逐个消费 id，不建立全局 id 集合。

import type { ChatMessage } from '../types.js';

/** 为未被响应的 tool_call 补合成 tool 消息（内容标明取消），保证消息序自洽（D3） */
export function sealPendingToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // 当前 assistant(tool_calls) 尚未被响应的 id（同 id 在不同轮次重复时各自独立计数）
  let pendingIds: string[] | null = null;

  const flush = (): void => {
    if (!pendingIds) return;
    for (const id of pendingIds) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        content: '（运行已被用户停止，该工具调用未完成）',
      });
    }
    pendingIds = null;
  };

  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      // 上一条 assistant 若还缺响应，先在其 tool 区之后补齐，再进入新的一组
      flush();
      pendingIds = m.tool_calls.map((tc) => tc.id);
      out.push(m);
    } else if (m.role === 'tool') {
      const idx = pendingIds ? pendingIds.indexOf(m.tool_call_id) : -1;
      if (idx >= 0) {
        pendingIds!.splice(idx, 1);
        if (pendingIds!.length === 0) pendingIds = null;
      }
      // 不归属当前 assistant 的 tool 原样保留（交给 repairMessageSequence 判定是否孤立）
      out.push(m);
    } else {
      // 非 tool 消息出现：当前 assistant 的 tool 区已结束，先补齐缺失的合成 tool
      flush();
      out.push(m);
    }
  }
  flush();

  return out;
}
