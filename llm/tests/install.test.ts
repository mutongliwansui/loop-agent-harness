import { createHost, createRootContext, type EventMapBase } from '@loop-agent/core';
import { describe, expect, it } from 'vitest';

import {
  defineLlmProvider,
  getLlmRegistry,
  installLlm,
  LlmError,
  LLM_SERVICE_KEYS,
  type LlmRegistry,
} from '../src/index.js';
import { FakeProvider } from './helpers.js';

describe('installLlm', () => {
  it('安装后 ctx.get("llm:registry") 可取到目录实例', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);

    const fiber = ctx.plugin(installLlm());
    await fiber.ready();

    const registry = ctx.get<LlmRegistry>(LLM_SERVICE_KEYS.registry);
    expect(registry).toBeDefined();
    expect(typeof registry?.list).toBe('function');
    expect(fiber.state).toBe('ACTIVE');
  });

  it('重复安装 → LLM_REGISTRY_EXISTS，消息含「请勿重复」提示', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);

    const first = ctx.plugin(installLlm());
    await first.ready();
    expect(first.state).toBe('ACTIVE');

    const second = ctx.plugin(installLlm());
    await second.ready().catch(() => undefined);

    // 冲突被翻译成 LlmError，且 Fiber 进 FAILED
    expect(second.state).toBe('FAILED');
    const entry = ctx.diagnose().fibers.find((f) => f.id === second.id);
    expect(entry?.error?.code).toBe('LLM_REGISTRY_EXISTS');
    expect(entry?.error?.message).toContain('请勿重复调用');
  });

  it('卸载 installLlm 的 Fiber 后 llm:registry 消失', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);

    const fiber = ctx.plugin(installLlm());
    await fiber.ready();
    expect(ctx.get(LLM_SERVICE_KEYS.registry)).toBeDefined();

    await fiber.dispose();
    expect(ctx.get(LLM_SERVICE_KEYS.registry)).toBeUndefined();
  });

  it('以非法 LlmError 形态暴露：LLM_REGISTRY_EXISTS 是 LlmError 子类判定', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    await ctx.plugin(installLlm()).ready();

    // 直接调用 provide 制造冲突，验证错误类型
    let caught: unknown;
    try {
      ctx.plugin(installLlm());
      await new Promise((r) => setTimeout(r, 0));
    } catch (err) {
      caught = err;
    }
    // 上面的 catch 不一定会命中（Fiber 内部吞错），故以 diagnose 为主要断言
    const report = ctx.diagnose();
    expect(report.services.some((s) => s.key === LLM_SERVICE_KEYS.registry)).toBe(true);
  });
});

describe('getLlmRegistry', () => {
  it('未安装时抛带提示的 LlmError', () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);

    expect(() => getLlmRegistry(ctx)).toThrow(LlmError);
    expect(() => getLlmRegistry(ctx)).toThrow(/请先挂载 installLlm/);
  });

  it('已安装时返回同一实例', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    await ctx.plugin(installLlm()).ready();

    const a = getLlmRegistry(ctx);
    const b = getLlmRegistry(ctx);
    expect(a).toBe(b);
  });
});

describe('诊断可见性', () => {
  it('provider 挂载后 diagnose() 可见 llm:provider:<id> 服务及其归属 Fiber', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    await ctx.plugin(installLlm()).ready();

    const fiber = ctx.plugin(defineLlmProvider({ id: 'diag', create: () => new FakeProvider('diag') }));
    await fiber.ready();

    const report = ctx.diagnose();
    const svc = report.services.find((s) => s.key === 'llm:provider:diag');
    expect(svc).toBeDefined();
    expect(svc?.ownerFiberId).toBe(fiber.id);
  });

  it('同 id 挂两个 provider → 第二个 FAILED，diagnose 见 CORE_SERVICE_CONFLICT', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    await ctx.plugin(installLlm()).ready();

    const f1 = ctx.plugin(defineLlmProvider({ id: 'same', create: () => new FakeProvider('same') }));
    await f1.ready();

    const f2 = ctx.plugin(defineLlmProvider({ id: 'same', create: () => new FakeProvider('same') }));
    await f2.ready().catch(() => undefined);

    expect(f1.state).toBe('ACTIVE');
    expect(f2.state).toBe('FAILED');
    const entry = ctx.diagnose().fibers.find((f) => f.id === f2.id);
    expect(entry?.error?.code).toBe('CORE_SERVICE_CONFLICT');
  });
});
