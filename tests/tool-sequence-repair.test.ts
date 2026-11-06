/**
 * tool_calls / tool 消息序列修复与审计（400 回归）
 *
 * 线上报错：An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'。根因是 repairMessageSequence 旧实现假设 tool_call_id
 * 全局唯一——同一会话多次重试时上游会复用同一批 id，后出现的 assistant 覆盖了
 * id→assistant 映射，较早那组 tool 被误删而 assistant 的 tool_calls 被保留。
 */
import { describe, it, expect } from 'vitest';
import {
  repairMessageSequence,
  auditToolSequence,
  SYNTHETIC_TOOL_RESULT_TEXT,
} from '../src/memory/context.js';
import type { ChatMessage } from '../src/types.js';

const assistantWithCalls = (ids: string[], content = ''): ChatMessage =>
  ({
    role: 'assistant',
    content,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'fileRead', arguments: '{}' },
    })),
  }) as ChatMessage;

const toolMsg = (callId: string, content = 'ok'): ChatMessage =>
  ({ role: 'tool', tool_call_id: callId, content }) as ChatMessage;

/** 模拟上游协议校验：每个 assistant(tool_calls) 必须紧跟其全部 tool 响应 */
function assertProtocolValid(messages: ChatMessage[]): void {
  let pending = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      expect(pending.size, '上一个 assistant(tool_calls) 未被完全响应').toBe(0);
      pending = new Set(m.tool_calls.map((tc) => tc.id));
    } else if (m.role === 'tool') {
      expect(pending.has(m.tool_call_id), `tool ${m.tool_call_id} 不在紧邻的 tool_calls 中`).toBe(true);
      pending.delete(m.tool_call_id);
    } else {
      expect(pending.size, 'assistant(tool_calls) 后未紧跟 tool 响应').toBe(0);
    }
  }
  expect(pending.size).toBe(0);
}

describe('repairMessageSequence：按顺序配对（不依赖 id 全局唯一）', () => {
  it('跨轮次复用同一 tool_call_id：两组 tool 全部保留，序列不被破坏', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '继续' },
      assistantWithCalls(['X']),
      toolMsg('X', 'r1'),
      { role: 'user', content: '继续' },
      assistantWithCalls(['X']),
      toolMsg('X', 'r2'),
    ];
    const repaired = repairMessageSequence(messages);
    expect(repaired).toEqual(messages);
    expect(repaired.filter((m) => m.role === 'tool')).toHaveLength(2);
    assertProtocolValid(repaired);
  });

  it('复现线上形态：历史段 assistant(tc=X) 无 tool + 当前轮 assistant(tc=X)+tool → 仍合法', () => {
    // 旧实现此时会保留历史段 tool_calls 却删掉它的 tool，产出 assistant → assistant
    const messages: ChatMessage[] = [
      { role: 'user', content: '[历史摘要] ...' },
      assistantWithCalls(['X', 'Y']),
      assistantWithCalls(['X']),
      toolMsg('X'),
    ];
    const repaired = repairMessageSequence(messages);
    assertProtocolValid(repaired);
    // 历史段两个 tool_call 都被补齐（补而非删）
    const first = repaired[1];
    expect(first.tool_calls).toHaveLength(2);
    const synthesized = repaired.filter(
      (m) => m.role === 'tool' && String(m.content) === SYNTHETIC_TOOL_RESULT_TEXT,
    );
    expect(synthesized.length).toBeGreaterThan(0);
  });

  it('一组内缺少部分响应：紧邻补合成 tool，tool_calls 不被裁掉', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      assistantWithCalls(['a1', 'a2']),
      toolMsg('a1'),
      { role: 'assistant', content: '继续' },
    ];
    const repaired = repairMessageSequence(messages);
    expect(repaired[2]).toEqual(toolMsg('a1'));
    expect(repaired[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'a2',
      content: SYNTHETIC_TOOL_RESULT_TEXT,
    });
    expect(repaired[1].tool_calls).toHaveLength(2);
    assertProtocolValid(repaired);
  });

  it('纯孤立 tool（前面没有任何 tool_calls）→ 丢弃', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      toolMsg('ghost'),
      { role: 'assistant', content: 'a' },
    ];
    const repaired = repairMessageSequence(messages);
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('合法序列零改动（返回原数组引用）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      assistantWithCalls(['a1']),
      toolMsg('a1'),
      { role: 'assistant', content: 'done' },
    ];
    expect(repairMessageSequence(messages)).toBe(messages);
  });
});

describe('auditToolSequence：请求前审计', () => {
  it('合法序列返回空', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      assistantWithCalls(['a1']),
      toolMsg('a1'),
    ];
    expect(auditToolSequence(messages)).toEqual([]);
  });

  it('复现报错形态（assistant → assistant）能定位到具体下标', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '[历史摘要] ...' },
      assistantWithCalls(['X']),
      assistantWithCalls(['X']),
      toolMsg('X'),
    ];
    const issues = auditToolSequence(messages);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('#1');
  });
});
