import { describe, expect, it } from 'vitest';
import { createHost, createRootContext } from '../src/context.js';
import { ServiceConflictError } from '../src/errors.js';

describe('diagnose：把「我的插件为什么没生效」变成一次调用', () => {
  it('返回全部 Fiber 的 id / name / state', async () => {
    const ctx = createRootContext();
    const f1 = ctx.plugin({ name: 'first', apply: () => {} });
    const f2 = ctx.plugin({ name: 'second', apply: () => {} });
    await Promise.all([f1.ready(), f2.ready()]);

    const report = ctx.diagnose();
    expect(report.fibers).toHaveLength(2);
    expect(report.fibers.map((f) => f.name)).toEqual(['first', 'second']);
    expect(report.fibers.every((f) => f.state === 'ACTIVE')).toBe(true);
    expect(report.fibers[0].id).toBe(f1.id);
  });

  it('含已卸载 Fiber（历史可追溯，不只是当前活着的）', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin({ name: 'short-lived', apply: () => {} });
    await fiber.ready();
    await fiber.dispose();

    const report = ctx.diagnose();
    const target = report.fibers.find((f) => f.name === 'short-lived');
    expect(target?.state).toBe('DISPOSED');
  });

  it('PENDING Fiber 的 missing 精确列出未满足硬依赖', async () => {
    const ctx = createRootContext();
    ctx.plugin({
      name: 'needy',
      inject: { required: ['a', 'b'], optional: ['opt'] },
      apply: () => {},
    });
    ctx.provide('a', 1);
    await createHostSettle(ctx);

    const target = ctx.diagnose().fibers.find((f) => f.name === 'needy');
    expect(target?.state).toBe('PENDING');
    // 只列硬依赖里缺的，软依赖不影响加载
    expect(target?.missing).toEqual(['b']);
  });

  it('ACTIVE 与 FAILED 的 missing 恒为空数组（不误导）', async () => {
    const ctx = createRootContext();
    const ok = ctx.plugin({ name: 'ok', apply: () => {} });
    const bad = ctx.plugin({
      name: 'bad',
      apply: () => {
        throw new Error('boom');
      },
    });
    await Promise.all([ok.ready(), bad.ready()]);

    const report = ctx.diagnose();
    expect(report.fibers.find((f) => f.name === 'ok')?.missing).toEqual([]);
    expect(report.fibers.find((f) => f.name === 'bad')?.missing).toEqual([]);
  });

  it('FAILED Fiber 的 error 含 code 与 message', async () => {
    const ctx = createRootContext();
    const bad = ctx.plugin({
      name: 'bad',
      apply: () => {
        throw new Error('炸了');
      },
    });
    await bad.ready();

    const target = ctx.diagnose().fibers.find((f) => f.name === 'bad');
    expect(target?.state).toBe('FAILED');
    expect(target?.error?.code).toBe('CORE_PLUGIN_LOAD');
    expect(target?.error?.message).toContain('炸了');
  });

  it('services 标注 ownerFiberId', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin({
      name: 'provider',
      apply: (c) => {
        c.provide('svc', 'v');
      },
    });
    await fiber.ready();

    const entry = ctx.diagnose().services.find((s) => s.key === 'svc');
    expect(entry?.ownerFiberId).toBe(fiber.id);
    expect(entry?.isolated).toBe(false);
  });

  it('services 标注 isolated 真伪（隔离域内提供的为 true）', async () => {
    const ctx = createRootContext();
    ctx.provide('root-svc', 1);

    const iso = ctx.isolate(['iso-svc']);
    iso.provide('iso-svc', 2);

    const report = ctx.diagnose();
    expect(report.services.find((s) => s.key === 'root-svc')?.isolated).toBe(false);
    expect(report.services.find((s) => s.key === 'iso-svc')?.isolated).toBe(true);
  });

  it('disposeErrors 反映撤销期抛错（不变量 3 可诊断）', async () => {
    const ctx = createRootContext();
    const fiber = ctx.plugin({
      name: 'bad-cleanup',
      apply: (c) => {
        c.effect(
          () => () => {
            throw new Error('disposer 炸了');
          },
          'bad-disposer',
        );
      },
    });
    await fiber.ready();
    await fiber.dispose();

    const target = ctx.diagnose().fibers.find((f) => f.name === 'bad-cleanup');
    expect(target?.disposeErrors?.length).toBe(1);
    expect(target?.disposeErrors?.[0]).toContain('disposer 炸了');
  });

  it('诊断出「两个插件抢同一 key」的现场', async () => {
    const ctx = createRootContext();
    const a = ctx.plugin({
      name: 'A',
      apply: (c) => {
        c.provide('dup', 'a');
      },
    });
    await a.ready();
    const b = ctx.plugin({
      name: 'B',
      apply: (c) => {
        c.provide('dup', 'b');
      },
    });
    await b.ready();

    const report = ctx.diagnose();
    expect(report.fibers.find((f) => f.name === 'B')?.error?.code).toBe(
      new ServiceConflictError('dup').code,
    );
    // 先从者仍在，且服务归属清楚
    expect(report.services.filter((s) => s.key === 'dup')).toHaveLength(1);
    expect(report.services.find((s) => s.key === 'dup')?.ownerFiberId).toBe(a.id);
  });
});

describe('根 Context 的清单式挂载（内核视角，任务 01 D13）', () => {
  it('链式依赖可收敛到全 ACTIVE（等价于按清单顺序挂载）', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    // C 依赖 B 提供的服务，B 依赖 A 提供的服务：三者顺序打乱也能收敛
    ctx.plugin({ name: 'C', inject: ['b-svc'], apply: () => {} });
    ctx.plugin({
      name: 'B',
      inject: ['a-svc'],
      apply: (c) => {
        c.provide('b-svc', 'b');
      },
    });
    ctx.plugin({
      name: 'A',
      apply: (c) => {
        c.provide('a-svc', 'a');
      },
    });
    await host.settle();

    expect(ctx.diagnose().fibers.map((f) => f.state)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
  });

  it('单个插件 FAILED 不中断其余', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    ctx.plugin({ name: 'good1', apply: () => {} });
    ctx.plugin({
      name: 'bad',
      apply: () => {
        throw new Error('boom');
      },
    });
    ctx.plugin({ name: 'good2', apply: () => {} });
    await host.settle();

    const states = ctx.diagnose().fibers.map((f) => [f.name, f.state]);
    expect(states).toEqual([
      ['good1', 'ACTIVE'],
      ['bad', 'FAILED'],
      ['good2', 'ACTIVE'],
    ]);
  });

  it('根 Context 上 provide 的服务对所有插件可见', async () => {
    const host = createHost();
    const ctx = createRootContext(host);
    ctx.provide('shared', 'v');
    let seen: unknown;
    ctx.plugin({
      name: 'reader',
      inject: ['shared'],
      apply: (c) => {
        seen = c.get('shared');
      },
    });
    await host.settle();

    expect(seen).toBe('v');
    expect(ctx.diagnose().fibers.find((f) => f.name === 'reader')?.state).toBe('ACTIVE');
  });
});

/** 借 root context 的 host 做一次收敛（Context 接口不暴露 host，故从 plugin 侧观察） */
async function createHostSettle(ctx: ReturnType<typeof createRootContext>): Promise<void> {
  // 通过再挂一个瞬时插件触发一轮收敛，等价于等待依赖重算完成
  const f = ctx.plugin({ name: '__settle_probe__', apply: () => {} });
  await f.ready();
  await f.dispose();
  // 再让微任务队列清空，覆盖收敛链的尾部
  await new Promise((r) => setTimeout(r, 0));
}
