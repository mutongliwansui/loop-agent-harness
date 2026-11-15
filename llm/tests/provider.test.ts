import { describe, expect, it } from 'vitest';

import { defaultCapabilities, LlmProvider } from '../src/index.js';
import { FakeProvider, makeRequest } from './helpers.js';

/** 只实现最小必选项的 provider，用于验证「最小实现」承诺 */
class MinimalProvider extends LlmProvider {
  readonly id = 'minimal';
  async complete() {
    return { content: 'x', finishReason: 'stop' as const, model: 'm' };
  }
}

describe('LlmProvider 抽象基类', () => {
  it('最小实现只需 id + complete() 两个成员', async () => {
    const p = new MinimalProvider();
    const res = await p.complete();
    expect(res.content).toBe('x');
    expect(p.displayName).toBe('minimal');
  });

  it('缺省 capabilities() 全 false（保守默认，逼实现者显式声明）', () => {
    const caps = new MinimalProvider().capabilities();
    expect(caps).toEqual(defaultCapabilities());
    expect(caps.streaming).toBe(false);
    expect(caps.toolCalling).toBe(false);
    expect(caps.usageReporting).toBe(false);
  });

  it('maxContextTokens 缺省为 undefined，不伪造数值', () => {
    expect(new MinimalProvider().capabilities().maxContextTokens).toBeUndefined();
  });

  it('默认 stream() 由 complete() 降级：text-delta → usage → done', async () => {
    const p = new FakeProvider('f');
    const events = [];
    for await (const e of p.stream(makeRequest())) events.push(e);

    expect(events.map((e) => e.type)).toEqual(['text-delta', 'usage', 'done']);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.response.content).toBe('ok');
  });

  it('默认 stream() 的末事件恒为 done', async () => {
    class NoUsage extends LlmProvider {
      readonly id = 'no-usage';
      async complete() {
        return { content: 'a', finishReason: 'stop' as const, model: 'm' };
      }
    }
    const events = [];
    for await (const e of new NoUsage().stream(makeRequest())) events.push(e);
    expect(events.at(-1)?.type).toBe('done');
    // 无用量时不发 usage 事件
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('默认 stream() 在 content 为 null 时不发 text-delta', async () => {
    class NullContent extends LlmProvider {
      readonly id = 'null-content';
      async complete() {
        return { content: null, finishReason: 'stop' as const, model: 'm' };
      }
    }
    const events = [];
    for await (const e of new NullContent().stream(makeRequest())) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['done']);
  });

  it('默认降级不发 tool-call 增量（工具调用在 complete() 里已是完整结果）', async () => {
    class ToolProvider extends LlmProvider {
      readonly id = 'tool';
      async complete() {
        return {
          content: null,
          finishReason: 'tool_calls' as const,
          model: 'm',
          toolCalls: [{ id: 't1', name: 'fn', arguments: '{}' }],
        };
      }
    }
    const events = [];
    for await (const e of new ToolProvider().stream(makeRequest())) events.push(e);
    expect(events.some((e) => e.type === 'tool-call-start')).toBe(false);
    expect(events.some((e) => e.type === 'tool-call-delta')).toBe(false);
    const done = events.at(-1);
    if (done?.type === 'done') expect(done.response.toolCalls).toHaveLength(1);
  });

  it('onDispose() 经 public dispose() 转发被调用', async () => {
    const p = new FakeProvider('d');
    expect(p.disposeCount).toBe(0);
    await p.dispose();
    expect(p.disposeCount).toBe(1);
  });
});
