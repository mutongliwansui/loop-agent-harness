/**
 * 纯类型断言：验证联合类型的收窄、穷举与不可赋值性。
 *
 * Vitest 只跑 *.test.ts；本文件命名为 .test-d.ts 是沿用惯例，同时也确实
 * 会作为普通测试被收集（因为以 .ts 结尾）。真正的类型检查由
 * `npx tsc --noEmit` 覆盖——这里是「运行期也能跑」的可执行断言补充。
 */

import { describe, expect, it } from 'vitest';

import type {
  LlmContentPart,
  LlmEvents,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmToolCall,
} from '../src/index.js';

/** 编译期断言辅助：类型相等 */
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe('领域类型的类型级契约', () => {
  it('LlmMessage 四态可判别', () => {
    const msgs: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, toolCalls: [] },
      { role: 'tool', toolCallId: 't1', content: 'result' },
    ];
    for (const msg of msgs) {
      switch (msg.role) {
        case 'system':
          expect(typeof msg.content).toBe('string');
          break;
        case 'user':
          // user 的 content 是 string | LlmContentPart[]
          expect(msg.content).toBeDefined();
          break;
        case 'assistant':
          // assistant 的 content 可为 null
          expect('content' in msg).toBe(true);
          break;
        case 'tool':
          expect(typeof msg.toolCallId).toBe('string');
          break;
        default: {
          // 穷举检查：若新增角色，这里会编译报错
          const never: never = msg;
          throw new Error(`未处理的消息角色: ${JSON.stringify(never)}`);
        }
      }
    }
    expect(msgs).toHaveLength(4);
  });

  it('LlmStreamEvent 五态可判别且 done 携带完整响应', () => {
    const events: LlmStreamEvent[] = [
      { type: 'text-delta', delta: 'a' },
      { type: 'tool-call-start', index: 0, id: 't', name: 'f' },
      { type: 'tool-call-delta', index: 0, argumentsDelta: '{}' },
      { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
      {
        type: 'done',
        response: { content: 'x', finishReason: 'stop', model: 'm' },
      },
    ];

    for (const e of events) {
      switch (e.type) {
        case 'text-delta':
          expect(typeof e.delta).toBe('string');
          break;
        case 'tool-call-start':
          expect(typeof e.index).toBe('number');
          break;
        case 'tool-call-delta':
          expect(typeof e.argumentsDelta).toBe('string');
          break;
        case 'usage':
          expect(e.usage.totalTokens).toBe(3);
          break;
        case 'done':
          expect(e.response.model).toBe('m');
          break;
        default: {
          const never: never = e;
          throw new Error(`未处理的流式事件: ${JSON.stringify(never)}`);
        }
      }
    }
  });

  it('LlmContentPart 两态可判别', () => {
    const parts: LlmContentPart[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
    ];
    expect(parts.map((p) => p.type)).toEqual(['text', 'image']);
  });

  it('LlmToolCall.arguments 是字符串（不做二次序列化）', () => {
    const call: LlmToolCall = { id: 't', name: 'f', arguments: '{"a":1}' };
    expect(typeof call.arguments).toBe('string');
    expect(JSON.parse(call.arguments)).toEqual({ a: 1 });
  });

  it('LlmResponse.usage 可缺省（记未知而非 0）', () => {
    const noUsage: LlmResponse = { content: 'x', finishReason: 'stop', model: 'm' };
    expect(noUsage.usage).toBeUndefined();
  });

  it('LlmFinishReason 保留开放字符串尾部', () => {
    const custom: LlmResponse = {
      content: '',
      finishReason: 'some_vendor_reason',
      model: 'm',
    };
    expect(custom.finishReason).toBe('some_vendor_reason');
  });

  it('LlmRequest.metadata 只收 string 值', () => {
    const req: LlmRequest = {
      model: 'm',
      messages: [],
      metadata: { sessionId: 's1' },
    };
    expect(req.metadata?.sessionId).toBe('s1');
  });

  it('LlmEvents 的键与载荷类型可用', () => {
    // 只做类型级引用，运行期断言事件名清单稳定
    const names: Array<keyof LlmEvents & string> = [
      'llm/registered',
      'llm/unregistered',
      'llm/request',
      'llm/response',
      'llm/error',
    ];
    expect(names).toHaveLength(5);
  });

  it('usage 字段确实为 camelCase（不是 snake_case）', () => {
    const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    expect(Object.keys(usage)).toEqual(['promptTokens', 'completionTokens', 'totalTokens']);
    expect('prompt_tokens' in usage).toBe(false);
  });
});

/** 编译期断言：确认关键等价关系（不在运行期执行任何逻辑） */
export type _TypeAssertions = [
  Expect<Equal<LlmResponse['finishReason'] extends string ? true : false, true>>,
  Expect<Equal<LlmStreamEvent['type'], 'text-delta' | 'tool-call-start' | 'tool-call-delta' | 'usage' | 'done'>>,
  Expect<Equal<LlmMessage['role'], 'system' | 'user' | 'assistant' | 'tool'>>,
];
