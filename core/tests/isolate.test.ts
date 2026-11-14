import { describe, expect, it } from 'vitest';
import { createHost, createRootContext } from '../src/context.js';
import type { EventMapBase } from '../src/types.js';

interface AppEvents extends EventMapBase {
  'app/notice': (msg: string) => void;
}

describe('isolate：服务隔离域', () => {
  it('子树内 provide 与外层同名 key 互不覆盖（D18 前置场景）', async () => {
    const ctx = createRootContext();
    ctx.provide('store', 'root-store');

    const iso = ctx.isolate(['store']);
    // 隔离域内提供同名 key：不与根冲突
    iso.provide('store', 'iso-store');

    expect(iso.get('store')).toBe('iso-store');
    // 外层不受影响
    expect(ctx.get('store')).toBe('root-store');
  });

  it('子树内 get 不回退外层（隔离即遮蔽，不是覆盖）', async () => {
    const ctx = createRootContext();
    ctx.provide('only-root', 'v');

    // 声明隔离 only-root，但域内没提供 → 取到 undefined，**不回退**根 store
    const iso = ctx.isolate(['only-root']);
    expect(iso.get('only-root')).toBeUndefined();

    // 未声明的 key 照常可见
    expect(iso.get('other')).toBeUndefined();
    ctx.provide('other', 'seen');
    expect(iso.get('other')).toBe('seen');
  });

  it('嵌套隔离域按最内层胜出', async () => {
    const ctx = createRootContext();
    ctx.provide('k', 'root');

    const outer = ctx.isolate(['k']);
    outer.provide('k', 'outer');

    const inner = outer.isolate(['k']);
    inner.provide('k', 'inner');

    expect(inner.get('k')).toBe('inner');
    expect(outer.get('k')).toBe('outer');
    expect(ctx.get('k')).toBe('root');
  });

  it('隔离域内 Fiber 卸载后其隔离服务消失', async () => {
    const ctx = createRootContext();
    const iso = ctx.isolate(['svc']);

    const fiber = iso.plugin((c) => {
      c.provide('svc', 'from-plugin');
    });
    await fiber.ready();
    expect(iso.get('svc')).toBe('from-plugin');

    await fiber.dispose();
    expect(iso.get('svc')).toBeUndefined();
    // 根始终看不到
    expect(ctx.get('svc')).toBeUndefined();
  });

  it('隔离域内的插件依赖判定用隔离域可见性', async () => {
    const ctx = createRootContext();
    // 根有 svc，但隔离域声明了 svc 且尚未提供
    ctx.provide('svc', 'root-svc');
    const iso = ctx.isolate(['svc']);

    let applied = false;
    const fiber = iso.plugin({
      name: 'needs-iso-svc',
      inject: ['svc'],
      apply: () => {
        applied = true;
      },
    });
    await fiber.ready();

    // 隔离域内看不到 svc → 停在 PENDING，apply 不被调用
    expect(fiber.state).toBe('PENDING');
    expect(applied).toBe(false);

    // 域内提供后才就绪
    iso.provide('svc', 'iso-svc');
    await fiber.ready();
    await new Promise((r) => setTimeout(r, 0));
    expect(fiber.state).toBe('ACTIVE');
    expect(applied).toBe(true);
  });

  it('事件总线不隔离：隔离域内注册的监听器照常被全局事件命中', async () => {
    const host = createHost<AppEvents>();
    const ctx = createRootContext<AppEvents>(host);
    const iso = ctx.isolate(['store']);

    const got: string[] = [];
    const fiber = iso.plugin((c) => {
      c.on('app/notice', (msg) => {
        got.push(msg);
      });
    });
    await fiber.ready();

    // 从根侧发事件，隔离域内的监听器仍被调用（D12：跨域通知必须全局）
    host.bus.emit('app/notice', 'hello');
    expect(got).toEqual(['hello']);
  });

  it('services() 扣除被遮蔽的 key，并并上域内实际提供的', async () => {
    const ctx = createRootContext();
    ctx.provide('hidden', 1);
    ctx.provide('visible', 2);

    const iso = ctx.isolate(['hidden']);
    iso.provide('inner-only', 3);

    const list = iso.services();
    expect(list).not.toContain('hidden');
    expect(list).toContain('visible');
    expect(list).toContain('inner-only');
  });

  it('隔离域的 provide 返回 disposer 可手动撤销', () => {
    const ctx = createRootContext();
    const iso = ctx.isolate(['x']);
    const off = iso.provide('x', 1);
    expect(iso.get('x')).toBe(1);
    off();
    expect(iso.get('x')).toBeUndefined();
  });
});
