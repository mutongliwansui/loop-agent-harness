import { describe, expect, it } from 'vitest';
import { createHost, createRootContext } from '../src/context.js';
import type { EventMapBase } from '../src/types.js';

interface AppEvents extends EventMapBase {
  'agent/tool-start': (tool: string) => void;
  'agent/tool-end': (tool: string, result: string) => Promise<void> | void;
}

describe('Context 事件与泛型事件表', () => {
  it('业务侧可声明自己的事件表并强类型监听', async () => {
    const host = createHost<AppEvents>();
    const ctx = createRootContext<AppEvents>(host);
    const got: string[] = [];

    const fiber = ctx.plugin((c) => {
      c.on('agent/tool-start', (tool) => {
        got.push(tool);
      });
    });
    await fiber.ready();

    host.bus.emit('agent/tool-start', 'bash');
    expect(got).toEqual(['bash']);
  });

  it('ctx.on 注册的监听器在 Fiber 卸载时自动移除', async () => {
    const host = createHost<AppEvents>();
    const ctx = createRootContext<AppEvents>(host);
    let calls = 0;

    const fiber = ctx.plugin((c) => {
      c.on('agent/tool-start', () => {
        calls++;
      });
    });
    await fiber.ready();
    expect(host.bus.listenerCount('agent/tool-start')).toBe(1);

    host.bus.emit('agent/tool-start', 'bash');
    expect(calls).toBe(1);

    await fiber.dispose();
    // 卸载后监听器已被自动移除，再发事件不再命中
    expect(host.bus.listenerCount('agent/tool-start')).toBe(0);
    host.bus.emit('agent/tool-start', 'bash');
    expect(calls).toBe(1);
  });

  it('Context 的 on 返回 disposer，可手动移除', async () => {
    const host = createHost<AppEvents>();
    const ctx = createRootContext<AppEvents>(host);
    let calls = 0;

    const fiber = ctx.plugin((c) => {
      const off = c.on('agent/tool-end', () => {
        calls++;
      });
      off();
    });
    await fiber.ready();

    expect(host.bus.listenerCount('agent/tool-end')).toBe(0);
    host.bus.emit('agent/tool-end', 'bash', 'ok');
    expect(calls).toBe(0);
  });

  it('services() 反映当前可见 key', async () => {
    const ctx = createRootContext();
    expect(ctx.services()).toEqual([]);
    const fiberA = ctx.plugin((c) => {
      c.provide('a', 1);
    });
    await fiberA.ready();
    expect(ctx.services()).toEqual(['a']);
    const fiberB = ctx.plugin((c) => {
      c.provide('b', 2);
    });
    await fiberB.ready();
    expect(ctx.services()).toEqual(['a', 'b']);
  });

  it('服务冲突：同一 key 被两个 Fiber 提供时，后者 FAILED', async () => {
    const ctx = createRootContext();
    const a = ctx.plugin((c) => {
      c.provide('dup', 'from-a');
    });
    await a.ready();
    expect(a.state).toBe('ACTIVE');

    const b = ctx.plugin((c) => {
      c.provide('dup', 'from-b');
    });
    await b.ready();
    expect(b.state).toBe('FAILED');
    expect(b.error?.code).toBe('CORE_SERVICE_CONFLICT');
    // 先提供者不受影响
    expect(ctx.get('dup')).toBe('from-a');
    expect(a.state).toBe('ACTIVE');
  });
});

describe('host 隔离', () => {
  it('不同 host 的服务表与事件总线互相独立', async () => {
    const ctx1 = createRootContext();
    const ctx2 = createRootContext();

    const f1 = ctx1.plugin((c) => {
      c.provide('only-in-1', 'v');
    });
    await f1.ready();

    expect(ctx1.get('only-in-1')).toBe('v');
    expect(ctx2.get('only-in-1')).toBeUndefined();
    expect(ctx2.services()).toEqual([]);
  });

  it('createHost 可显式构造，Fiber id 不重复', () => {
    const host = createHost();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add(host.nextId());
    expect(ids.size).toBe(5);
  });

  it('createRootContext 可接收自定义 host', () => {
    const host = createHost();
    const ctx = createRootContext(host);
    ctx.provide('shared', 1);
    // 同一 host 上再建 Context，服务可见（共享是刻意设计，D10）
    const ctx2 = createRootContext(host);
    expect(ctx2.get('shared')).toBe(1);
  });
});

describe('effect 参数校验', () => {
  it('body 未返回函数时抛 TypeError', async () => {
    const ctx = createRootContext();
    let caught: unknown;
    const fiber = ctx.plugin((c) => {
      try {
        // 故意返回非函数
        c.effect(() => 'not-a-function' as unknown as () => void, 'bad');
      } catch (e) {
        caught = e;
      }
      c.provide('after-error', true);
    });
    await fiber.ready();
    expect(caught).toBeInstanceOf(TypeError);
    // 校验失败不阻断插件其余部分
    expect(fiber.state).toBe('ACTIVE');
    expect(ctx.get('after-error')).toBe(true);
  });
});
