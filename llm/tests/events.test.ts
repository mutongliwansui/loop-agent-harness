import { describe, expect, it } from 'vitest';

import {
  createLlmRegistry,
  type LlmRequestPayload,
  type LlmResponsePayload,
  type LlmErrorPayload,
  type LlmProviderRegisteredPayload,
  type LlmProviderUnregisteredPayload,
} from '../src/index.js';
import { FakeProvider, makeRequest } from './helpers.js';

describe('llm 事件', () => {
  it('llm/registered 在注册时触发一次', () => {
    const registry = createLlmRegistry();
    const got: LlmProviderRegisteredPayload[] = [];
    registry.on('llm/registered', (p) => got.push(p));

    registry.register(new FakeProvider('a'));

    expect(got).toHaveLength(1);
    expect(got[0]?.providerId).toBe('a');
    expect(got[0]?.displayName).toBe('a');
  });

  it('llm/unregistered 在注销时触发一次', () => {
    const registry = createLlmRegistry();
    const got: LlmProviderUnregisteredPayload[] = [];
    registry.on('llm/unregistered', (p) => got.push(p));

    const dispose = registry.register(new FakeProvider('a'));
    dispose();

    expect(got).toHaveLength(1);
    expect(got[0]?.providerId).toBe('a');
  });

  it('注销幂等：重复调用 dispose 只触发一次 unregistered', () => {
    const registry = createLlmRegistry();
    let count = 0;
    registry.on('llm/unregistered', () => count++);

    const dispose = registry.register(new FakeProvider('a'));
    dispose();
    dispose();
    dispose();

    expect(count).toBe(1);
  });

  it('llm/request 与 llm/response 在成功调用时各触发一次', async () => {
    const registry = createLlmRegistry();
    const requests: LlmRequestPayload[] = [];
    const responses: LlmResponsePayload[] = [];
    registry.on('llm/request', (p) => requests.push(p));
    registry.on('llm/response', (p) => responses.push(p));

    registry.register(new FakeProvider('a'));
    await registry.complete('a', makeRequest());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.providerId).toBe('a');
    expect(requests[0]?.request.model).toBe('test-model');

    expect(responses).toHaveLength(1);
    expect(responses[0]?.providerId).toBe('a');
    expect(responses[0]?.response.content).toBe('ok');
    expect(typeof responses[0]?.elapsedMs).toBe('number');
    expect(responses[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('llm/error 在调用抛错时触发一次', async () => {
    const registry = createLlmRegistry();
    const errors: LlmErrorPayload[] = [];
    registry.on('llm/error', (p) => errors.push(p));

    registry.register(
      new FakeProvider('bad', () => {
        throw new Error('boom');
      }),
    );

    await registry.complete('bad', makeRequest()).catch(() => undefined);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.providerId).toBe('bad');
    expect(errors[0]?.error.code).toBe('LLM_ERROR');
  });

  it('调用失败时不发 llm/response', async () => {
    const registry = createLlmRegistry();
    let responses = 0;
    registry.on('llm/response', () => responses++);

    registry.register(
      new FakeProvider('bad', () => {
        throw new Error('boom');
      }),
    );
    await registry.complete('bad', makeRequest()).catch(() => undefined);

    expect(responses).toBe(0);
  });

  it('能力拒绝发生在 llm/request 之前（不发请求也不发 request 事件）', async () => {
    const registry = createLlmRegistry();
    let requests = 0;
    registry.on('llm/request', () => requests++);

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

    await registry
      .complete('cap', makeRequest({ tools: [{ name: 'f', description: '', parameters: {} }] }))
      .catch(() => undefined);

    expect(requests).toBe(0);
  });
});

describe('监听器隔离', () => {
  it('监听器抛错不中断调用链（事件是只读观测）', async () => {
    const registry = createLlmRegistry();
    registry.on('llm/request', () => {
      throw new Error('listener bug');
    });

    registry.register(new FakeProvider('a'));
    // 调用仍应成功
    const res = await registry.complete('a', makeRequest());
    expect(res.content).toBe('ok');
  });

  it('一个监听器抛错不影响其他监听器收到事件', () => {
    const registry = createLlmRegistry();
    const seen: string[] = [];
    registry.on('llm/registered', () => {
      throw new Error('first fails');
    });
    registry.on('llm/registered', (p) => seen.push(p.providerId));

    registry.register(new FakeProvider('a'));
    expect(seen).toEqual(['a']);
  });

  it('off 后不再收到事件', () => {
    const registry = createLlmRegistry();
    let count = 0;
    const off = registry.on('llm/registered', () => count++);

    registry.register(new FakeProvider('a'));
    off();
    registry.register(new FakeProvider('b'));

    expect(count).toBe(1);
  });

  it('多个监听器按注册序全部收到', () => {
    const registry = createLlmRegistry();
    const order: number[] = [];
    registry.on('llm/registered', () => order.push(1));
    registry.on('llm/registered', () => order.push(2));
    registry.on('llm/registered', () => order.push(3));

    registry.register(new FakeProvider('a'));
    expect(order).toEqual([1, 2, 3]);
  });
});
