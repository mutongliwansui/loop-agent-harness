import { describe, expect, it } from 'vitest';

import {
  createLlmRegistry,
  LlmCapabilityError,
  LlmError,
  LlmProviderConflictError,
  LlmProviderNotFoundError,
  LlmRequestError,
  type LlmRegistry,
} from '../src/index.js';
import { FakeProvider, makeRequest } from './helpers.js';

describe('LlmRegistry 基本行为', () => {
  it('注册后 get/require 可取到', () => {
    const registry = createLlmRegistry();
    const p = new FakeProvider('a');
    registry.register(p);

    expect(registry.get('a')).toBe(p);
    expect(registry.require('a')).toBe(p);
  });

  it('未注册时 get 返回 undefined，require 抛 LlmProviderNotFoundError', () => {
    const registry = createLlmRegistry();
    expect(registry.get('nope')).toBeUndefined();
    expect(() => registry.require('nope')).toThrow(LlmProviderNotFoundError);
  });

  it('list() 按注册序返回摘要，含能力与 isDefault', () => {
    const registry = createLlmRegistry();
    registry.register(new FakeProvider('a'));
    registry.register(new FakeProvider('b'));

    const list = registry.list();
    expect(list.map((i) => i.id)).toEqual(['a', 'b']);
    expect(list[0]?.displayName).toBe('a');
    expect(list[0]?.capabilities.toolCalling).toBe(true);
  });

  it('重复 id 注册抛 LlmProviderConflictError', () => {
    const registry = createLlmRegistry();
    registry.register(new FakeProvider('dup'));
    expect(() => registry.register(new FakeProvider('dup'))).toThrow(LlmProviderConflictError);
  });

  it('注销后 get 返回 undefined，且注销幂等', () => {
    const registry = createLlmRegistry();
    const dispose = registry.register(new FakeProvider('x'));
    dispose();
    expect(registry.get('x')).toBeUndefined();
    // 再次调用不抛错
    expect(() => dispose()).not.toThrow();
  });
});

describe('缺省 provider', () => {
  it('无显式缺省时回落到首个注册者', () => {
    const registry = createLlmRegistry();
    const a = new FakeProvider('a');
    registry.register(a);
    registry.register(new FakeProvider('b'));

    expect(registry.defaultProvider()).toBe(a);
    expect(registry.list()[0]?.isDefault).toBe(true);
    expect(registry.list()[1]?.isDefault).toBe(false);
  });

  it('isDefault:true 显式指定者胜出', () => {
    const registry = createLlmRegistry();
    registry.register(new FakeProvider('a'));
    const b = new FakeProvider('b');
    registry.register(b, { isDefault: true });

    expect(registry.defaultProvider()).toBe(b);
  });

  it('setDefault 可改缺省；目标不存在抛错', () => {
    const registry = createLlmRegistry();
    const a = new FakeProvider('a');
    const b = new FakeProvider('b');
    registry.register(a);
    registry.register(b);

    registry.setDefault('b');
    expect(registry.defaultProvider()).toBe(b);
    expect(() => registry.setDefault('missing')).toThrow(LlmProviderNotFoundError);
  });

  it('缺省 provider 被注销后回落到剩余首个', () => {
    const registry = createLlmRegistry();
    const a = new FakeProvider('a');
    const b = new FakeProvider('b');
    const disposeA = registry.register(a);
    registry.register(b);

    disposeA();
    expect(registry.defaultProvider()).toBe(b);
  });

  it('空目录的 defaultProvider 为 undefined', () => {
    expect(createLlmRegistry().defaultProvider()).toBeUndefined();
  });
});

describe('LlmRegistry.complete 流水线', () => {
  it('调用成功返回响应并透传请求', async () => {
    const registry = createLlmRegistry();
    const p = new FakeProvider('a');
    registry.register(p);

    const req = makeRequest();
    const res = await registry.complete('a', req);

    expect(res.content).toBe('ok');
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]).toEqual(req);
  });

  it('未注册 id → LlmProviderNotFoundError', async () => {
    const registry = createLlmRegistry();
    await expect(registry.complete('nope', makeRequest())).rejects.toThrow(
      LlmProviderNotFoundError,
    );
  });

  it('provider 抛非 LlmError → 归一为 LlmError，保留 cause', async () => {
    const registry = createLlmRegistry();
    const boom = new Error('network down');
    registry.register(
      new FakeProvider('a', () => {
        throw boom;
      }),
    );

    const err = await registry.complete('a', makeRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).cause).toBe(boom);
  });

  it('provider 抛已是 LlmError 的 → 原样透传（保留精确 code）', async () => {
    const registry = createLlmRegistry();
    const original = new LlmRequestError('upstream 500', { status: 500 });
    registry.register(
      new FakeProvider('a', () => {
        throw original;
      }),
    );

    const err = await registry.complete('a', makeRequest()).catch((e) => e);
    expect(err).toBe(original);
    expect((err as LlmRequestError).status).toBe(500);
  });
});

describe('能力协商在调用前拒绝', () => {
  it('带 tools 但 toolCalling:false → 抛 LlmCapabilityError 且未调用 complete()', async () => {
    const registry = createLlmRegistry();
    const p = new FakeProvider('a');
    // 覆写成不支持工具调用
    p.capabilities = () => ({
      streaming: false,
      toolCalling: false,
      vision: false,
      jsonMode: false,
      usageReporting: false,
      cacheReporting: false,
    });
    registry.register(p);

    const req = makeRequest({
      tools: [{ name: 'fn', description: 'd', parameters: {} }],
    });

    await expect(registry.complete('a', req)).rejects.toThrow(LlmCapabilityError);
    // 关键断言：拒绝发生在调用之前，绝不能发出请求
    expect(p.calls).toHaveLength(0);
  });

  it('LlmCapabilityError 带 providerId 与 capability', async () => {
    const registry = createLlmRegistry();
    const p = new FakeProvider('cap');
    p.capabilities = () => ({
      streaming: false,
      toolCalling: false,
      vision: false,
      jsonMode: false,
      usageReporting: false,
      cacheReporting: false,
    });
    registry.register(p);

    const err = await registry
      .complete('cap', makeRequest({ tools: [{ name: 'f', description: '', parameters: {} }] }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(LlmCapabilityError);
    expect((err as LlmCapabilityError).providerId).toBe('cap');
    expect((err as LlmCapabilityError).capability).toBe('toolCalling');
  });

  it('stream 同样在调用前拒绝超能力请求', async () => {
    const registry = createLlmRegistry();
    const p = new FakeProvider('s');
    p.capabilities = () => ({
      streaming: false,
      toolCalling: false,
      vision: false,
      jsonMode: false,
      usageReporting: false,
      cacheReporting: false,
    });
    registry.register(p);

    const drain = async () => {
      for await (const _ of registry.stream(
        's',
        makeRequest({ tools: [{ name: 'f', description: '', parameters: {} }] }),
      )) {
        // 不应产出任何事件
      }
    };
    await expect(drain()).rejects.toThrow(LlmCapabilityError);
    expect(p.calls).toHaveLength(0);
  });
});

describe('LlmRegistry.stream', () => {
  it('基类降级流式可正常消费', async () => {
    const registry = createLlmRegistry();
    registry.register(new FakeProvider('a'));

    const types: string[] = [];
    for await (const e of registry.stream('a', makeRequest())) types.push(e.type);
    expect(types).toEqual(['text-delta', 'usage', 'done']);
  });

  it('实现漏发 done 时自动补齐，且不视为错误', async () => {
    class NoDone extends FakeProvider {
      override async *stream(): AsyncIterable<{ type: 'text-delta'; delta: string }> {
        yield { type: 'text-delta', delta: 'abc' };
      }
    }
    const registry = createLlmRegistry();
    registry.register(new NoDone('nodone'));

    const events = [];
    for await (const e of registry.stream('nodone', makeRequest())) events.push(e);

    expect(events.map((e) => e.type)).toEqual(['text-delta', 'done']);
    const done = events.at(-1);
    if (done?.type === 'done') {
      // 用已累积分片尽力构造
      expect(done.response.content).toBe('abc');
    }
  });

  it('流式抛错 → 归一为 LlmError 并发出 llm/error', async () => {
    class Failing extends FakeProvider {
      override async *stream(): AsyncIterable<never> {
        throw new Error('stream broke');
      }
    }
    const registry = createLlmRegistry();
    registry.register(new Failing('fail'));

    const errors: string[] = [];
    registry.on('llm/error', (p) => errors.push(p.error.code));

    const drain = async () => {
      for await (const _ of registry.stream('fail', makeRequest())) {
        /* 不应到这里 */
      }
    };
    await expect(drain()).rejects.toThrow(LlmError);
    expect(errors).toEqual(['LLM_ERROR']);
  });
});

describe('createLlmRegistry 每次都是新实例', () => {
  it('两个 registry 互不影响', () => {
    const a: LlmRegistry = createLlmRegistry();
    const b: LlmRegistry = createLlmRegistry();
    a.register(new FakeProvider('x'));

    expect(a.get('x')).toBeDefined();
    expect(b.get('x')).toBeUndefined();
  });
});
