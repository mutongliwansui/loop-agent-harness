import { describe, expect, it } from 'vitest';
import { ServiceConflictError, ServiceNotFoundError } from '../src/errors.js';
import { ServiceRegistry } from '../src/service.js';
import { createRootContext } from '../src/context.js';
import type { Plugin } from '../src/types.js';

describe('ServiceRegistry', () => {
  it('provide / get 往返正确', () => {
    const reg = new ServiceRegistry();
    reg.provide('store', { value: 1 }, 'f1');
    expect(reg.get<{ value: number }>('store')).toEqual({ value: 1 });
  });

  it('未提供时 get 返回 undefined（软依赖用法）', () => {
    const reg = new ServiceRegistry();
    expect(reg.get('missing')).toBeUndefined();
  });

  it('has / keys / remove / clear 行为正确', () => {
    const reg = new ServiceRegistry();
    reg.provide('a', 1, 'f1');
    reg.provide('b', 2, 'f2');
    expect(reg.has('a')).toBe(true);
    expect(reg.keys()).toEqual(['a', 'b']);
    expect(reg.remove('a')).toBe(true);
    expect(reg.remove('a')).toBe(false);
    expect(reg.keys()).toEqual(['b']);
    reg.clear();
    expect(reg.keys()).toEqual([]);
  });

  it('同一 key 二次 provide 抛 ServiceConflictError 且带 code 与 key', () => {
    const reg = new ServiceRegistry();
    reg.provide('dup', 1, 'f1');
    let caught: unknown;
    try {
      reg.provide('dup', 2, 'f2');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceConflictError);
    const err = caught as ServiceConflictError;
    expect(err.code).toBe('CORE_SERVICE_CONFLICT');
    expect(err.key).toBe('dup');
    // 原值不被覆盖
    expect(reg.get('dup')).toBe(1);
  });

  it('entriesSnapshot 返回归属信息，且不暴露内部 Map', () => {
    const reg = new ServiceRegistry();
    reg.provide('x', 'v', 'f9');
    const snap = reg.entriesSnapshot();
    expect(snap).toEqual([{ key: 'x', impl: 'v', ownerFiberId: 'f9' }]);
    // 快照是数组副本，改它不影响内部
    (snap as unknown as unknown[]).length = 0;
    expect(reg.keys()).toEqual(['x']);
  });
});

describe('Context 服务往返与生命周期', () => {
  it('ctx.provide / ctx.get 往返正确，services() 反映可见 key', () => {
    const ctx = createRootContext();
    expect(ctx.get('svc')).toBeUndefined();
    ctx.provide('svc', { n: 42 });
    expect(ctx.get<{ n: number }>('svc')).toEqual({ n: 42 });
    expect(ctx.services()).toContain('svc');
  });

  it('Fiber 卸载后其提供的服务自动消失', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin((c) => {
      c.provide('temp', 'value');
    });
    await fiber.ready();
    expect(fiber.state).toBe('ACTIVE');
    expect(ctx.get('temp')).toBe('value');

    await fiber.dispose();
    expect(fiber.state).toBe('DISPOSED');
    expect(ctx.get('temp')).toBeUndefined();
  });

  it('根 Context 的 provide 不自动撤销，由调用方持有 disposer', () => {
    const ctx = createRootContext();
    const dispose = ctx.provide('root-svc', 1);
    expect(ctx.get('root-svc')).toBe(1);
    dispose();
    expect(ctx.get('root-svc')).toBeUndefined();
  });

  it('插件 seen 已提供服务的依赖判定：软依赖不阻塞加载', async () => {
    const ctx = createRootContext();
    const svc: Plugin = {
      name: 'soft',
      inject: { optional: ['nope'] },
      apply(c) {
        c.provide('soft-loaded', true);
      },
    };
    const fiber = ctx.plugin(svc);
    await fiber.ready();
    expect(fiber.state).toBe('ACTIVE');
    expect(ctx.get('soft-loaded')).toBe(true);
  });
});

describe('ServiceNotFoundError', () => {
  it('携带 key 与 code', () => {
    const err = new ServiceNotFoundError('db');
    expect(err.code).toBe('CORE_SERVICE_MISSING');
    expect(err.key).toBe('db');
    expect(err.name).toBe('ServiceNotFoundError');
  });
});
