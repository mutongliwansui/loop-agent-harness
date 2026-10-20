/**
 * 压缩请求载荷构造（compaction-payload）验证
 *
 * 覆盖：
 * - 固定 2 条消息：system 指令 + user(JSON)
 * - user 取 show_content / 剥离 L2 记忆前缀
 * - tool 结果 200 字截断、tool_calls.arguments 200 字截断、tool 名称反查
 * - 过滤 system / 摘要占位 / is_compact / 空消息
 * - previousSummary 顶层字段
 * - D4 总长度上限 12000 降级
 */

import { describe, it, expect } from 'vitest';
import {
  buildCompactionPayload,
  FLUSH_SYSTEM_PROMPT,
  MAX_PAYLOAD_CHARS,
  TOOL_ARGS_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
} from '../src/memory/compaction-payload.js';
import { withMemorySection } from '../src/memory/memory-section.js';
import type { ChatMessage } from '../src/types.js';

function parseUserPayload(messages: ChatMessage[]): { previousSummary?: string; messages: unknown[] } {
  return JSON.parse(messages[1].content as string);
}

describe('buildCompactionPayload', () => {
  it('输出固定 2 条消息：system 指令 + JSON 文本', () => {
    const { messages, stats } = buildCompactionPayload([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你' },
    ]);

    expect(messages.length).toBe(2);
    expect(messages[0]).toEqual({ role: 'system', content: FLUSH_SYSTEM_PROMPT });
    expect(messages[0].content).toContain('压缩对话历史');
    expect(messages[1].role).toBe('user');
    expect(() => JSON.parse(messages[1].content as string)).not.toThrow();
    expect(stats.outputCount).toBe(2);
    expect(stats.jsonChars).toBe((messages[1].content as string).length);
  });

  it('user 优先取 show_content（含记忆前缀时不会把前缀带进载荷）', () => {
    const { messages } = buildCompactionPayload([
      {
        role: 'user',
        content: withMemorySection('旧记忆片段', '原始问题'),
        show_content: '原始问题',
      } as ChatMessage,
    ]);

    expect(parseUserPayload(messages).messages).toEqual([
      { role: 'user', content: '原始问题' },
    ]);
  });

  it('无 show_content 时剥离 L2 记忆前缀', () => {
    const { messages, stats } = buildCompactionPayload([
      { role: 'user', content: withMemorySection('旧记忆片段', '原始问题') },
    ]);

    expect(parseUserPayload(messages).messages).toEqual([
      { role: 'user', content: '原始问题' },
    ]);
    expect(stats.strippedMemory).toBe(1);
  });

  it('tool 结果截断到 200 字并反查工具名', () => {
    const longResult = 'r'.repeat(TOOL_RESULT_MAX_CHARS + 100);
    const { messages, stats } = buildCompactionPayload([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'readFile', arguments: '{"path":"a.txt"}' } },
        ],
      } as ChatMessage,
      { role: 'tool', tool_call_id: 'call_1', content: longResult },
    ]);

    const entries = parseUserPayload(messages).messages as Array<Record<string, unknown>>;
    expect(entries.length).toBe(2);
    const toolEntry = entries[1];
    expect(toolEntry.role).toBe('tool');
    expect(toolEntry.name).toBe('readFile');
    const content = toolEntry.content as string;
    expect(content.startsWith('r'.repeat(TOOL_RESULT_MAX_CHARS))).toBe(true);
    expect(content).toContain('已截断，原 300 字');
    expect(stats.truncatedTools).toBe(1);
  });

  it('tool_calls.arguments 截断到 200 字', () => {
    const longArgs = JSON.stringify({ text: 'x'.repeat(TOOL_ARGS_MAX_CHARS + 50) });
    const { messages, stats } = buildCompactionPayload([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'writeFile', arguments: longArgs } }],
      } as ChatMessage,
    ]);

    const entries = parseUserPayload(messages).messages as Array<Record<string, unknown>>;
    const toolCalls = entries[0].tool_calls as Array<{ name: string; arguments: string }>;
    expect(toolCalls[0].name).toBe('writeFile');
    expect(toolCalls[0].arguments.length).toBeLessThan(longArgs.length);
    expect(toolCalls[0].arguments).toContain('已截断');
    expect(stats.truncatedArgs).toBe(1);
  });

  it('过滤 system / 摘要占位 / is_compact / 空消息', () => {
    const { messages, stats } = buildCompactionPayload([
      { role: 'system', content: '主 system' },
      { role: 'user', content: '[历史摘要] 旧摘要', is_show: false },
      { role: 'user', content: '已折叠', is_compact: true },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: '' },
      { role: 'tool', tool_call_id: 'c', content: '' },
      { role: 'user', content: '保留' },
    ]);

    expect(parseUserPayload(messages).messages).toEqual([
      { role: 'user', content: '保留' },
    ]);
    expect(stats.skipped).toBe(6);
  });

  it('previousSummary 放在顶层，为空时省略', () => {
    const withSummary = buildCompactionPayload([{ role: 'user', content: 'q' }], '- 旧事实');
    expect(parseUserPayload(withSummary.messages)).toEqual({
      previousSummary: '- 旧事实',
      messages: [{ role: 'user', content: 'q' }],
    });

    const withoutSummary = buildCompactionPayload([{ role: 'user', content: 'q' }], '   ');
    expect(parseUserPayload(withoutSummary.messages)).not.toHaveProperty('previousSummary');
  });

  it('D4：超 12000 字符时优先删除最旧的 tool 消息', () => {
    const droppable: ChatMessage[] = [];
    for (let i = 0; i < 80; i++) {
      droppable.push({ role: 'tool', tool_call_id: `c${i}`, content: `${i}:` + 't'.repeat(TOOL_RESULT_MAX_CHARS) });
    }

    const { messages, stats } = buildCompactionPayload(droppable);
    const json = messages[1].content as string;

    expect(json.length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
    expect(stats.omittedTools).toBeGreaterThan(0);
    expect(stats.outputCount).toBeLessThan(droppable.length);
    // 保留的是最近的 tool 消息
    const entries = parseUserPayload(messages).messages as Array<{ content: string }>;
    expect(entries[entries.length - 1].content.startsWith('79:')).toBe(true);
  });

  it('D4：tool 删完仍超限时截断最旧的 user 正文', () => {
    const droppable: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      droppable.push({ role: 'user', content: `${i}:` + 'u'.repeat(2000) });
    }

    const { messages, stats } = buildCompactionPayload(droppable);
    const json = messages[1].content as string;

    expect(json.length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
    expect(stats.truncatedUsers).toBeGreaterThan(0);
    // 最新的 user 未被截断
    const entries = parseUserPayload(messages).messages as Array<{ content: string }>;
    expect(entries[entries.length - 1].content.length).toBeGreaterThan(200);
  });

  it('空输入也返回合法的 2 条消息', () => {
    const { messages, stats } = buildCompactionPayload([]);
    expect(messages.length).toBe(2);
    expect(parseUserPayload(messages).messages).toEqual([]);
    expect(stats.outputCount).toBe(0);
  });
});
