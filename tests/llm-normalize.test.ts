/**
 * LLM 请求消息清洗（normalizeMessages）单测
 *
 * 覆盖：
 * - 摘要占位（is_show=false 的 user）：消息内容对 LLM 可见（保留），仅剥离会话标记字段
 * - assistant 空 tool_calls 数组：剥离该字段（否则 API 400）
 * - assistant 非空 tool_calls：原样保留
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llm } from '../src/llm/client.js';
import type { ChatMessage } from '../src/types.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.name = 'APIError';
      this.status = status;
    }
  }
  class MockOpenAI {
    static APIError = APIError;
    chat = { completions: { create: createMock } };
    constructor(_opts?: unknown) {}
  }
  return { default: MockOpenAI };
});

const okResp = {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue(okResp);
});

/** 取出本次 chat() 实际发给 API 的 messages */
async function sentMessages(messages: ChatMessage[]): Promise<Array<Record<string, unknown>>> {
  await llm.chat(messages);
  return createMock.mock.calls[0][0].messages as Array<Record<string, unknown>>;
}

describe('normalizeMessages：摘要占位与会话标记', () => {
  it('占位消息内容保留（LLM 可见），is_show/is_compact 标记字段被剥离', async () => {
    const sent = await sentMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '[历史摘要] 用户偏好 X', is_show: false, is_compact: false },
      { role: 'user', content: '继续' },
    ]);

    expect(sent).toHaveLength(3);
    expect(sent[1]).toEqual({ role: 'user', content: '[历史摘要] 用户偏好 X' });
    expect(sent[1]).not.toHaveProperty('is_show');
    expect(sent[1]).not.toHaveProperty('is_compact');
    expect(sent[2]).toEqual({ role: 'user', content: '继续' });
  });

  it('无标记时普通消息原样透传（不引入多余字段）', async () => {
    const sent = await sentMessages([{ role: 'user', content: 'hi' }]);
    expect(sent[0]).toEqual({ role: 'user', content: 'hi' });
  });
});

describe('normalizeMessages：assistant tool_calls', () => {
  it('空数组被剥离（避免 API 400），content 保留', async () => {
    const sent = await sentMessages([{ role: 'assistant', content: 'a', tool_calls: [] }]);
    expect(sent[0]).not.toHaveProperty('tool_calls');
    expect(sent[0].content).toBe('a');
  });

  it('非空 tool_calls 保留', async () => {
    const tc = [
      { id: 'c1', type: 'function' as const, function: { name: 'f', arguments: '{}' } },
    ];
    const sent = await sentMessages([{ role: 'assistant', content: null, tool_calls: tc }]);
    expect(sent[0].tool_calls).toEqual(tc);
  });
});
