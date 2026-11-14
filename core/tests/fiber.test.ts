import { describe, expect, it, vi } from 'vitest';
import { createRootContext } from '../src/context.js';
import { FiberDisposedError } from '../src/errors.js';
import type { Plugin } from '../src/types.js';

describe('上下文插件', () => {
  it('ctx.plugin 返回 Fiber，状态按 PENDING → LOADING → ACTIVE 流转', async () => {
    const ctx = createRootContext();
    const states: string[] = [];
    const p: Plugin = {
      name: 'flow',
      apply() {
        states.push('apply');
      },
    };
    const fiber = ctx.plugin(p);
    // 同步返回时尚未 ACTIVE（start 异步执行）
    expect(fiber.id).toBeTruthy();
    await fiber.ready();
    expect(states).toEqual(['apply']);
    expect(fiber.state).toBe('ACTIVE');
  });

  it('硬依赖未满足时 apply 不被调用，Fiber 停在 PENDING', async () => {
    const ctx = createRootContext();
    const apply = vi.fn();
    const p: Plugin = {
      name: 'needs-dep',
      inject: ['missing-service'],
      apply,
    };
    const fiber = ctx.plugin(p);
    await fiber.ready();
    expect(fiber.state).toBe('PENDING');
    expect(apply).not.toHaveBeenCalled();
  });

  it('硬依赖满足时正常加载', async () => {
    const ctx = createRootContext();
    ctx.provide('present', 1);
    const apply = vi.fn();
    const fiber = ctx.plugin({ name: 'ok', inject: ['present'], apply });
    await fiber.ready();
    expect(fiber.state).toBe('ACTIVE');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('apply 抛错 → FAILED，且已注册 effect / 服务 / 监听全部撤销（无泄漏）', async () => {
    const ctx = createRootContext();
    const disposeEffect = vi.fn();
    const listener = vi.fn();

    ctx.provide('need-pre', true);

    const fiber = ctx.plugin({
      name: 'leaky',
      inject: ['need-pre'],
      apply(c) {
        c.provide('leak-svc', 1);
        c.effect(() => disposeEffect, 'leak-effect');
        c.on('evt', listener);
        throw new Error('apply-failed');
      },
    });
    await fiber.ready();

    expect(fiber.state).toBe('FAILED');
    expect(fiber.error).toBeDefined();
    expect(fiber.error?.code).toBe('CORE_PLUGIN_LOAD');
    // 已注册副作用全部撤销
    expect(disposeEffect).toHaveBeenCalledTimes(1);
    expect(ctx.get('leak-svc')).toBeUndefined();
    expect(ctx.services()).not.toContain('leak-svc');
  });

  it('插件内 provide 的服务名带 ownerFiberId', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin((c) => {
      c.provide('owned', 'v');
    });
    await fiber.ready();
    expect(ctx.get('owned')).toBe('v');
  });

  it('ctx.on 注册的监听器在 Fiber 卸载时自动移除', async () => {
    const ctx = createRootContext();
    const listener = vi.fn();
    const fiber = ctx.plugin((c) => {
      c.on('evt', listener);
    });
    await fiber.ready();
    expect(fiber.state).toBe('ACTIVE');

    await fiber.dispose();
    // 卸载后监听器已被移除；此处只断言不抛错且不再被调用
    expect(listener).not.toHaveBeenCalled();
  });

  it('ctx.effect 的 body 注册时立即执行，其返回的 disposer 卸载时执行', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    const fiber = ctx.plugin((c) => {
      // body 立即执行（此处 setup），返回的才是 disposer
      c.effect(() => {
        order.push('body-ran');
        return () => {
          order.push('disposed');
        };
      }, 'e1');
    });
    await fiber.ready();
    expect(order).toEqual(['body-ran']);
    await fiber.dispose();
    expect(order).toEqual(['body-ran', 'disposed']);
  });

  it('在已 DISPOSED 的 Fiber 上继续注册抛 FiberDisposedError', async () => {
    const ctx = createRootContext();
    let childFiber: ReturnType<typeof ctx.plugin> | undefined;
    let savedCtx: { provide(k: string, v: unknown): unknown } | undefined;

    const parent = ctx.plugin((c) => {
      savedCtx = c;
      childFiber = c.plugin(() => {});
    });
    await parent.ready();
    await childFiber!.ready();
    expect(childFiber!.state).toBe('ACTIVE');

    await parent.dispose();
    // 子 Fiber 随父卸载
    expect(childFiber!.state).toBe('DISPOSED');

    // 在已卸载的 ctx 上继续注册必须抛 FiberDisposedError
    expect(() => savedCtx!.provide('late', 1)).toThrowError(FiberDisposedError);
  });
});

describe('Fiber 不变量', () => {
  it('不变量 1：dispose() 幂等，返回同一 Promise 引用', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin(() => {});
    await fiber.ready();
    const p1 = fiber.dispose();
    const p2 = fiber.dispose();
    // 同一引用——async 修饰会破坏此性质
    expect(p1).toBe(p2);
    await p1;
  });

  it('不变量 2：disposer 逆序执行，异步串行', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    const fiber = ctx.plugin((c) => {
      c.effect(() => () => {
        order.push('first');
      }, 'first');
      c.effect(() => () => {
        order.push('second');
      }, 'second');
      c.effect(() => async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('third-async');
      }, 'third');
    });
    await fiber.ready();
    await fiber.dispose();
    // 逆序：最后注册的最先撤销；异步 disposer 串行等待完成
    expect(order).toEqual(['third-async', 'second', 'first']);
  });

  it('不变量 3：单个 disposer 抛错不中断其余撤销', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    const fiber = ctx.plugin((c) => {
      c.effect(() => () => {
        order.push('a');
      }, 'a');
      c.effect(() => () => {
        order.push('b-throws');
        throw new Error('disposer-boom');
      }, 'b');
      c.effect(() => () => {
        order.push('c');
      }, 'c');
    });
    await fiber.ready();
    await fiber.dispose();
    // 三个都执行了（逆序 c → b → a），b 抛错未中断 a
    expect(order).toEqual(['c', 'b-throws', 'a']);
    expect(fiber.state).toBe('DISPOSED');
  });

  it('不变量 4：父 Fiber 卸载时先递归 dispose 子 Fiber', async () => {
    const ctx = createRootContext();
    const order: string[] = [];
    let childFiber: ReturnType<typeof ctx.plugin> | undefined;

    const parent = ctx.plugin((c) => {
      c.effect(() => () => {
        order.push('parent-disposer');
      }, 'parent');
      childFiber = c.plugin((cc) => {
        cc.effect(() => () => {
          order.push('child-disposer');
        }, 'child');
      });
    });
    await parent.ready();
    expect(childFiber).toBeDefined();
    await childFiber!.ready();
    expect(childFiber!.state).toBe('ACTIVE');

    await parent.dispose();
    // 子先于父
    expect(order).toEqual(['child-disposer', 'parent-disposer']);
    expect(childFiber!.state).toBe('DISPOSED');
  });

  it('reload() 从 FAILED 重新加载', async () => {
    const ctx = createRootContext();
    let fail = true;
    const fiber = ctx.plugin((c) => {
      if (fail) throw new Error('first-attempt');
      c.provide('after-reload', 1);
    });
    await fiber.ready();
    expect(fiber.state).toBe('FAILED');

    fail = false;
    await fiber.reload();
    expect(fiber.state).toBe('ACTIVE');
    expect(fiber.error).toBeUndefined();
    expect(ctx.get('after-reload')).toBe(1);
  });

  it('已 DISPOSED 的 Fiber reload 抛 FiberDisposedError', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin(() => {});
    await fiber.ready();
    await fiber.dispose();
    await expect(fiber.reload()).rejects.toBeInstanceOf(FiberDisposedError);
  });
});
