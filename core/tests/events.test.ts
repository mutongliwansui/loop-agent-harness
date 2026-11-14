import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../src/events.js';
import type { EventMapBase } from '../src/types.js';

interface TestEvents extends EventMapBase {
  ping: (n: number) => void;
  decide: (n: number) => number | undefined | Promise<number | undefined>;
  fan: (n: number) => void;
}

describe('TypedEventBus.emit', () => {
  it('同步、按注册序调用', () => {
    const bus = new TypedEventBus<TestEvents>();
    const order: string[] = [];
    bus.on('ping', () => order.push('a'));
    bus.on('ping', () => order.push('b'));
    bus.on('ping', () => order.push('c'));
    bus.emit('ping', 1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('无监听器时为空操作', () => {
    const bus = new TypedEventBus<TestEvents>();
    expect(() => bus.emit('ping', 1)).not.toThrow();
  });

  it('监听器抛错不外抛，但记录到 listenerErrors()', () => {
    const bus = new TypedEventBus<TestEvents>();
    const spy = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', spy);
    expect(() => bus.emit('ping', 1)).not.toThrow();
    // 前一个抛错不影响后一个执行
    expect(spy).toHaveBeenCalledTimes(1);
    const errs = bus.listenerErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0].event).toBe('ping');
    expect((errs[0].error as Error).message).toBe('boom');
  });

  it('监听器返回 rejected Promise 也被记录，不产生 unhandledRejection', async () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.on('ping', async () => {
      throw new Error('async-boom');
    });
    bus.emit('ping', 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.listenerErrors()).toHaveLength(1);
  });
});

describe('TypedEventBus.serial', () => {
  it('按注册序 await，首个非 undefined 胜出即停', async () => {
    const bus = new TypedEventBus<TestEvents>();
    const third = vi.fn(() => 3);
    bus.on('decide', () => undefined);
    bus.on('decide', () => 2);
    bus.on('decide', third);

    const result = await bus.serial('decide', 1);
    expect(result).toBe(2);
    // 胜出后停止，第三个不再执行
    expect(third).not.toHaveBeenCalled();
  });

  it('全部返回 undefined 时返回 undefined', async () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.on('decide', () => undefined);
    bus.on('decide', () => undefined);
    expect(await bus.serial('decide', 1)).toBeUndefined();
  });

  it('无监听器时返回 undefined', async () => {
    const bus = new TypedEventBus<TestEvents>();
    expect(await bus.serial('decide', 1)).toBeUndefined();
  });

  it('监听器抛错时外抛', async () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.on('decide', () => {
      throw new Error('serial-boom');
    });
    await expect(bus.serial('decide', 1)).rejects.toThrow('serial-boom');
  });

  it('异步监听器被正确等待', async () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.on('decide', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 7;
    });
    expect(await bus.serial('decide', 1)).toBe(7);
  });
});

describe('TypedEventBus.parallel', () => {
  it('全部并行执行（不按序等待）', async () => {
    const bus = new TypedEventBus<TestEvents>();
    const started: string[] = [];
    bus.on('fan', async () => {
      started.push('slow');
      await new Promise((r) => setTimeout(r, 20));
    });
    bus.on('fan', async () => {
      started.push('fast');
      await new Promise((r) => setTimeout(r, 1));
    });
    const t0 = Date.now();
    await bus.parallel('fan', 1);
    const elapsed = Date.now() - t0;
    // 两者几乎同时启动
    expect(started).toEqual(['slow', 'fast']);
    // 并行总耗时接近较慢者，而非两者之和
    expect(elapsed).toBeLessThan(38);
  });

  it('无监听器时为空操作', async () => {
    const bus = new TypedEventBus<TestEvents>();
    await expect(bus.parallel('fan', 1)).resolves.toBeUndefined();
  });

  it('异常不外抛，但全部记录', async () => {
    const bus = new TypedEventBus<TestEvents>();
    bus.on('fan', () => {
      throw new Error('p1');
    });
    bus.on('fan', () => {
      throw new Error('p2');
    });
    await expect(bus.parallel('fan', 1)).resolves.toBeUndefined();
    expect(bus.listenerErrors()).toHaveLength(2);
  });
});

describe('TypedEventBus.on 移除', () => {
  it('返回的 disposer 移除监听器，且重复调用安全', () => {
    const bus = new TypedEventBus<TestEvents>();
    const spy = vi.fn();
    const off = bus.on('ping', spy);
    expect(bus.listenerCount('ping')).toBe(1);
    off();
    off();
    expect(bus.listenerCount('ping')).toBe(0);
    bus.emit('ping', 1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('同一函数注册两次会被调用两次', () => {
    const bus = new TypedEventBus<TestEvents>();
    const spy = vi.fn();
    bus.on('ping', spy);
    bus.on('ping', spy);
    bus.emit('ping', 1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
