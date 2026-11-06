/**
 * sealPendingToolCalls 封口工具测试（Task-20261021-002-03 P1，验收 6.2.8）
 *
 * - 孤立 tool_calls（assistant(tool_calls) 无对应 tool 响应）→ 补合成 tool 消息
 * - 已响应的 tool_call 不重复补
 * - 无 tool_calls 的消息原样返回（引用相等，零拷贝）
 * - 混合场景：多个孤立 tool_call 逐条补齐、消息序不变
 */
import { describe, it, expect } from 'vitest';
import { sealPendingToolCalls } from '../src/api/abort-utils.js';
import type { ChatMessage } from '../src/types.js';

const assistantWithCalls = (ids: string[]): ChatMessage =>
  ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: { name: 'fileRead', arguments: '{}' },
    })),
  }) as ChatMessage;

const toolMsg = (callId: string): ChatMessage =>
  ({ role: 'tool', tool_call_id: callId, content: 'ok' }) as ChatMessage;

describe('sealPendingToolCalls（Task-20261021-002-03 D3）', () => {
  it('6.2.8a 孤立 tool_calls → 逐条补合成 tool 消息', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      assistantWithCalls(['a1', 'a2']),
    ];
    const sealed = sealPendingToolCalls(messages);
    expect(sealed.length).toBe(4);
    const added = sealed.slice(2);
    expect(added.map((m) => (m as { tool_call_id?: string }).tool_call_id)).toEqual(['a1', 'a2']);
    for (const m of added) {
      expect(m.role).toBe('tool');
      expect(String(m.content)).toContain('已被用户停止');
    }
  });

  it('6.2.8b 已响应的 tool_call 不重复补', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      assistantWithCalls(['a1', 'a2']),
      toolMsg('a1'), // 只响应了 a1
    ];
    const sealed = sealPendingToolCalls(messages);
    expect(sealed.length).toBe(4); // 原样 + 补 a2
    const toolIds = sealed
      .filter((m) => m.role === 'tool')
      .map((m) => (m as { tool_call_id?: string }).tool_call_id);
    expect(toolIds.filter((id) => id === 'a1').length).toBe(1);
    expect(toolIds).toContain('a2');
  });

  it('6.2.8c 无 tool_calls 的消息原样返回（零拷贝）', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const sealed = sealPendingToolCalls(messages);
    // 无孤立 tool_calls：不追加任何消息（实现返回新数组、内容原样）
    expect(sealed).toEqual(messages);
    expect(sealed.length).toBe(3);
  });

  it('混合：孤立 tool_call 在中间轮次也能补齐（消息序不重排）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q1' },
      assistantWithCalls(['a1']),
      toolMsg('a1'),
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'q2' },
      assistantWithCalls(['a2', 'a3']), // 中止轮：a2 已完成、a3 孤立
      toolMsg('a2'),
    ];
    const sealed = sealPendingToolCalls(messages);
    // 前 6 条不动，只 append 一条 a3
    expect(sealed.slice(0, 7)).toEqual(messages);
    expect(sealed.length).toBe(8);
    expect((sealed[7] as { tool_call_id?: string }).tool_call_id).toBe('a3');
  });

  it('合成 tool 必须紧邻 assistant：后续还有消息时补在其 tool 区之后（不追加到末尾）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q1' },
      assistantWithCalls(['a1', 'a2']),
      toolMsg('a1'),
      { role: 'user', content: 'q2' },
    ];
    const sealed = sealPendingToolCalls(messages);
    expect(sealed.length).toBe(5);
    expect((sealed[3] as { tool_call_id?: string }).tool_call_id).toBe('a2');
    expect(sealed[4]).toEqual({ role: 'user', content: 'q2' });
  });
});
