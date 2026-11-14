import { describe, expect, it } from 'vitest';
import { createHost, createRootContext } from '../src/context.js';

/** 等收敛静止（host 的收敛是异步的） */
async function settle(host: ReturnType<typeof createHost>): Promise<void> {
  await host.settle();
}

describe('依赖动态重载（epoch 收敛）', () => {
  it('provider 卸载 → 依赖方由 ACTIVE 回滚到 PENDING，副作用撤销干净', async () => {
    const host = createHost();
    const ctx = createRootContext(host);

    const log: string[] = [];

    // provider
    const provider = ctx.plugin({
      name: 'provider',
      apply: (c) => {
        c.provide('svc', 'v');
      },
    });
    await provider.ready();

    // consumer
    const consumer = ctx.plugin({
      name: 'consumer',
      inject: ['svc'],
      apply: (c) => {
        log.push(`apply:${c.get('svc')}`);
        c.effect(() => () => {
          log.push('cleanup');
        }, 'demo');
      },
    });
    await consumer.ready();
    expect(consumer.state).toBe('ACTIVE');

    // provider 卸载 → 服务消失 → consumer 必须降级
    await provider.dispose();
    await settle(host);

    expect(ctx.get('svc')).toBeUndefined();
    expect(consumer.state).toBe('PENDING');
    // 副作用已撤销（不留悬空引用）
    expect(log).toContain('cleanup');
  });

  it('provider 重新提供 → 依赖方自动回 ACTIVE（D18 核心）', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    let applyCount = 0;

    const consumer = ctx.plugin({
      name: 'consumer',
      inject: ['svc'],
      apply: () => {
        applyCount++;
      },
    });
    await consumer.ready();
    expect(consumer.state).toBe('PENDING');
    expect(applyCount).toBe(0);

    // 由根 Context 提供（不挂在 Fiber 上，便于单独撤销）
    const off = ctx.provide('svc', 'v');
    await settle(host);

    expect(consumer.state).toBe('ACTIVE');
    expect(applyCount).toBe(1);

    // 再撤销 → 回到 PENDING
    off();
    await settle(host);
    expect(consumer.state).toBe('PENDING');

    // 再提供 → 再次 ACTIVE（证明可反复重载，不是一次性）
    ctx.provide('svc', 'v2');
    await settle(host);
    expect(consumer.state).toBe('ACTIVE');
    expect(applyCount).toBe(2);
  });

  it('重载后 consumer 的副作用只保留最新一份（不叠加）', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    let active = 0;

    const consumer = ctx.plugin({
      name: 'consumer',
      inject: ['svc'],
      apply: (c) => {
        active++;
        c.effect(() => () => {
          active--;
        }, 'count');
      },
    });
    await consumer.ready();
    expect(active).toBe(0);

    const off = ctx.provide('svc', 1);
    await settle(host);
    expect(active).toBe(1);

    off();
    await settle(host);
    // 撤销干净：active 回到 0，而不是负数或残留 1
    expect(active).toBe(0);

    ctx.provide('svc', 2);
    await settle(host);
    expect(active).toBe(1);
  });

  it('依赖图链路式收敛（A 提供 → B 依赖并再提供 → C 依赖 B）', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    const order: string[] = [];

    const c = ctx.plugin({
      name: 'C',
      inject: ['b-svc'],
      apply: () => {
        order.push('C');
      },
    });
    const b = ctx.plugin({
      name: 'B',
      inject: ['a-svc'],
      apply: (cc) => {
        order.push('B');
        cc.provide('b-svc', 'b');
      },
    });
    const a = ctx.plugin({
      name: 'A',
      apply: (cc) => {
        order.push('A');
        cc.provide('a-svc', 'a');
      },
    });

    await Promise.all([a.ready(), b.ready(), c.ready()]);
    await settle(host);

    // 链式依赖必须在同一轮 settle 内追平：A → B → C 全部 ACTIVE
    expect(order).toContain('A');
    expect(order).toContain('B');
    expect(order).toContain('C');
    expect(a.state).toBe('ACTIVE');
    expect(b.state).toBe('ACTIVE');
    expect(c.state).toBe('ACTIVE');
    // 顺序上 A 一定早于 C（依赖方向）
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
  });

  it('FAILED 不被收敛自动重试（D10 终态语义）', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    let attempts = 0;

    const bad = ctx.plugin({
      name: 'bad',
      inject: ['need'],
      apply: () => {
        attempts++;
        throw new Error('boom');
      },
    });
    await bad.ready();

    // 先让依赖满足，才可能进入 apply
    const off = ctx.provide('need', 1);
    await settle(host);

    expect(bad.state).toBe('FAILED');
    expect(attempts).toBe(1);

    // 再触发多轮收敛，不得重试
    off();
    await settle(host);
    ctx.provide('need', 2);
    await settle(host);

    expect(bad.state).toBe('FAILED');
    expect(attempts).toBe(1);
  });

  it('链路重载：A 撤销后 B、C 依次降级；恢复后依次回 ACTIVE', async () => {
    const host = createHost();
    const ctx = createRootContext(host);

    const c = ctx.plugin({
      name: 'C',
      inject: ['b-svc'],
      apply: () => {},
    });
    const b = ctx.plugin({
      name: 'B',
      inject: ['a-svc'],
      apply: (cc) => {
        cc.provide('b-svc', 'b');
      },
    });
    const a = ctx.plugin({
      name: 'A',
      apply: (cc) => {
        cc.provide('a-svc', 'a');
      },
    });

    await Promise.all([a.ready(), b.ready(), c.ready()]);
    await settle(host);
    expect([a.state, b.state, c.state]).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);

    await a.dispose();
    await settle(host);
    // A 消失 → a-svc 消失 → B 降级 → b-svc 消失 → C 降级
    expect(a.state).toBe('DISPOSED');
    expect(b.state).toBe('PENDING');
    expect(c.state).toBe('PENDING');

    // 重新挂一个等价的 A，链式恢复
    ctx.plugin({
      name: 'A2',
      apply: (cc) => {
        cc.provide('a-svc', 'a');
      },
    });
    await settle(host);
    expect(b.state).toBe('ACTIVE');
    expect(c.state).toBe('ACTIVE');
  });

  it('并发触发收敛不会把同一 Fiber 拉两次（单飞）', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    let applyCount = 0;

    const consumer = ctx.plugin({
      name: 'consumer',
      inject: ['svc'],
      apply: () => {
        applyCount++;
      },
    });
    await consumer.ready();

    // 连续多次 provide/撤销，制造并发触发
    const offs = [
      ctx.provide('svc', 1),
      ctx.provide('dup-a', 1),
      ctx.provide('dup-b', 1),
    ];
    await Promise.all([host.scheduleReconcile(), host.scheduleReconcile(), host.settle()]);
    await settle(host);

    expect(consumer.state).toBe('ACTIVE');
    // 只加载一次，不能因并发触发重复 apply
    expect(applyCount).toBe(1);
    offs.forEach((f) => f());
  });

  it('PENDING 期间的 diagnose 反映缺哪个 key', async () => {
    const host = createHost();
    const ctx = createRootContext(host);

    ctx.plugin({
      name: 'needs-two',
      inject: ['alpha', 'beta'],
      apply: () => {},
    });
    ctx.provide('alpha', 1);
    await settle(host);

    const report = ctx.diagnose();
    const target = report.fibers.find((f) => f.name === 'needs-two');
    expect(target?.state).toBe('PENDING');
    expect(target?.missing).toEqual(['beta']);
  });
});
