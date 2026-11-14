import { describe, expect, it } from 'vitest';
import {
  CoreError,
  CircularDependencyError,
  ServiceNotFoundError,
  ServiceConflictError,
  PluginLoadError,
  FiberDisposedError,
} from '../src/errors.js';
import { createRootContext } from '../src/context.js';
import { TypedEventBus } from '../src/events.js';
import type { EventMapBase } from '../src/types.js';

describe('错误族：6 类均带稳定 code', () => {
  const cases: Array<[string, CoreError, string]> = [
    ['CoreError', new CoreError('base'), 'CORE_ERROR'],
    ['CircularDependencyError', new CircularDependencyError('循环依赖: a -> b'), 'CORE_CIRCULAR_DEP'],
    ['ServiceNotFoundError', new ServiceNotFoundError('svc'), 'CORE_SERVICE_MISSING'],
    ['ServiceConflictError', new ServiceConflictError('dup'), 'CORE_SERVICE_CONFLICT'],
    ['PluginLoadError', new PluginLoadError('load failed'), 'CORE_PLUGIN_LOAD'],
    ['FiberDisposedError', new FiberDisposedError('gone'), 'CORE_FIBER_DISPOSED'],
  ];

  it.each(cases)('%s 的 code 稳定且可 instanceof 区分', (_label, err, code) => {
    expect(err).toBeInstanceOf(CoreError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(typeof err.message).toBe('string');
  });

  it('各子类的 code 互不相同', () => {
    const codes = cases.map(([, err]) => err.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('CoreError 携带 pluginName / fiberId / cause', () => {
    const cause = new Error('root cause');
    const err = new CoreError('wrapped', {
      pluginName: 'my-plugin',
      fiberId: 'f-1',
      cause,
    });
    expect(err.pluginName).toBe('my-plugin');
    expect(err.fiberId).toBe('f-1');
    expect(err.cause).toBe(cause);
  });

  it('CircularDependencyError 在消息里列出环上的 key', () => {
    const err = new CircularDependencyError('循环依赖: a -> b -> c');
    expect(err.message).toMatch(/a/);
    expect(err.message).toMatch(/b/);
  });

  it('ServiceConflictError 的消息含冲突 key', () => {
    expect(new ServiceConflictError('store').message).toContain('store');
  });
});

describe('在已 DISPOSED 的 ctx 上注册 → FiberDisposedError', () => {
  it('provide / effect / on / plugin 均被拒绝', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin({
      name: 'holder',
      // 把 ctx 存出去，卸载后继续用它注册
      apply: (c) => {
        (globalThis as Record<string, unknown>).__heldCtx = c;
      },
    });
    await fiber.ready();
    const held = (globalThis as Record<string, unknown>).__heldCtx as typeof ctx;

    await fiber.dispose();

    expect(() => held.provide('x', 1)).toThrow(FiberDisposedError);
    expect(() => held.effect(() => () => {})).toThrow(FiberDisposedError);
    expect(() => held.plugin({ apply: () => {} })).toThrow(FiberDisposedError);
    delete (globalThis as Record<string, unknown>).__heldCtx;
  });

  it('已 DISPOSED 的 Fiber reload 抛 FiberDisposedError', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin({ name: 'p', apply: () => {} });
    await fiber.ready();
    await fiber.dispose();
    await expect(fiber.reload()).rejects.toBeInstanceOf(FiberDisposedError);
  });
});

describe('waterfall：拦截改写（事件第四模式）', () => {
  interface WfEvents extends EventMapBase {
    'chain/run': (input: string) => string;
  }

  type WfListener = (input: string, next: () => Promise<string>) => Promise<string> | string;

  it('无监听器 → 走 fallback', async () => {
    const bus = new TypedEventBus<WfEvents>();
    const result = await bus.waterfall('chain/run', (input) => `fb:${input}`, 'x');
    expect(result).toBe('fb:x');
  });

  it('单个监听器不调 next() → 短路，fallback 不执行', async () => {
    const bus = new TypedEventBus<WfEvents>();
    let fallbackCalled = false;
    bus.on('chain/run', ((input: string) => `hit:${input}`) as unknown as WfEvents['chain/run']);

    const result = await bus.waterfall(
      'chain/run',
      (input) => {
        fallbackCalled = true;
        return `fb:${input}`;
      },
      'x',
    );

    expect(result).toBe('hit:x');
    expect(fallbackCalled).toBe(false);
  });

  it('全链都委托 → 最终走 fallback', async () => {
    const bus = new TypedEventBus<WfEvents>();
    const order: string[] = [];

    bus.on('chain/run', (async (input: string, next: () => Promise<string>) => {
      order.push('first');
      return next();
    }) as unknown as WfEvents['chain/run']);
    bus.on('chain/run', (async (input: string, next: () => Promise<string>) => {
      order.push('second');
      return next();
    }) as unknown as WfEvents['chain/run']);

    const result = await bus.waterfall('chain/run', (input) => `fb:${input}`, 'x');

    expect(result).toBe('fb:x');
    expect(order).toEqual(['first', 'second']);
  });

  it('监听器可对 next() 的结果再加工（包装式中间件）', async () => {
    const bus = new TypedEventBus<WfEvents>();
    bus.on('chain/run', (async (input: string, next: () => Promise<string>) => {
      const inner = await next();
      return `[wrapped ${inner}]`;
    }) as unknown as WfEvents['chain/run']);

    const result = await bus.waterfall('chain/run', (input) => `fb:${input}`, 'x');
    expect(result).toBe('[wrapped fb:x]');
  });

  it('按注册序执行，靠前的不调 next 后面的就不跑', async () => {
    const bus = new TypedEventBus<WfEvents>();
    const order: string[] = [];
    bus.on('chain/run', ((input: string) => {
      order.push('first');
      return 'first-result';
    }) as unknown as WfEvents['chain/run']);
    bus.on('chain/run', ((input: string) => {
      order.push('second');
      return 'second-result';
    }) as unknown as WfEvents['chain/run']);

    const result = await bus.waterfall('chain/run', () => 'fb', 'x');
    expect(result).toBe('first-result');
    expect(order).toEqual(['first']);
  });

  it('监听器抛错 → 外抛（调用方在等值，不能吞）', async () => {
    const bus = new TypedEventBus<WfEvents>();
    bus.on('chain/run', (() => {
      throw new Error('listener boom');
    }) as unknown as WfEvents['chain/run']);

    await expect(bus.waterfall('chain/run', () => 'fb', 'x')).rejects.toThrow('listener boom');
  });

  it('fallback 支持异步', async () => {
    const bus = new TypedEventBus<WfEvents>();
    const result = await bus.waterfall(
      'chain/run',
      async (input) => {
        await Promise.resolve();
        return `async-fb:${input}`;
      },
      'x',
    );
    expect(result).toBe('async-fb:x');
  });
});
