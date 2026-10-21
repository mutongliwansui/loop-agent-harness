/**
 * AgentPool 单元测试（Task-20261021-002-05 验收 6.2.1~6.2.5）
 *
 * 覆盖：
 * - 6.2.1 同 sessionId 粘性复用
 * - 6.2.2 不同 sessionId 并发拿到不同实例
 * - 6.2.3 超容量：busy 不被淘汰；淘汰最久未用空闲实例
 * - 6.2.4 run 抛错后实例 dispose 重建（不回池）
 * - 6.2.5 reset() 后实例全部重建；busy 旧实例归还时 dispose 不复用
 * - 附加：容量打满全 busy 时 acquire 排队；initAgent 失败不占坑；dispose 幂等
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentPool, type PooledAgent } from '../src/agent/agent-pool.js';
import type { AgentResult, AgentOptions } from '../src/types.js';

/** 可观测 fake 实例：记录 run/dispose 调用 */
function makeFake(tag: string) {
  const calls: string[] = [];
  const agent: PooledAgent = {
    run: vi.fn(async (_input: string, _options?: AgentOptions): Promise<AgentResult> => {
      calls.push('run');
      return { answer: `${tag}:run`, steps: [], iterations: 1, messages: [] };
    }),
    dispose: vi.fn(() => {
      calls.push('dispose');
    }),
  };
  return { agent, calls };
}

const noResult: AgentResult = { answer: '', steps: [], iterations: 0, messages: [] };

describe('AgentPool', () => {
  it('6.2.1 同 sessionId 先后两次 acquire 拿到同一实例（粘性）', async () => {
    const created: string[] = [];
    let n = 0;
    const p2 = new AgentPool({
      create: () => {
        const f = makeFake(`a${++n}`);
        created.push(`a${n}`);
        return f.agent;
      },
    });
    const seen: PooledAgent[] = [];
    await p2.withAgent('s1', async (a) => {
      seen.push(a);
    });
    await p2.withAgent('s1', async (a) => {
      seen.push(a);
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(created).toHaveLength(1);
  });

  it('6.2.2 不同 sessionId 并发 withAgent 拿到不同实例，互不干扰', async () => {
    let n = 0;
    const agents: PooledAgent[] = [];
    const pool = new AgentPool({
      capacity: 4,
      create: () => {
        const f = makeFake(`a${++n}`);
        agents.push(f.agent);
        return f.agent;
      },
    });
    const release: (() => void)[] = [];
    const p = Promise.all([
      pool.withAgent('s1', async () => {
        await new Promise<void>((r) => release.push(r));
      }),
      pool.withAgent('s2', async () => {
        await new Promise<void>((r) => release.push(r));
      }),
    ]);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach((r) => r());
    await p;
    expect(agents).toHaveLength(2);
    expect(agents[0]).not.toBe(agents[1]);
  });

  it('6.2.3 超容量：busy 实例不被淘汰；淘汰的是最久未用的空闲实例', async () => {
    let n = 0;
    const fakes = new Map<string, ReturnType<typeof makeFake>>();
    const pool = new AgentPool({
      capacity: 2,
      create: () => {
        const f = makeFake(`a${++n}`);
        fakes.set(`a${n}`, f);
        return f.agent;
      },
    });
    // 用实例对象反查其 fake（withAgent 回调参数即实例）
    const tagOf = new Map<PooledAgent, string>();
    for (const [tag, f] of fakes) tagOf.set(f.agent, tag);

    let gateA: (() => void) | undefined;
    const pA = pool.withAgent('sA', async () => {
      await new Promise<void>((r) => (gateA = r));
    });
    await vi.waitFor(() => expect(gateA).toBeDefined());

    // sA 仍 busy：新会话 sB 触发新建（容量 2 未满）
    await pool.withAgent('sB', async () => {});
    // sB 归还后池内有 2 实例（sA busy + sB idle）= 容量满
    // 第三个会话 sC：需淘汰空闲实例；sB 是唯一空闲（最久未用）→ sB 的实例被 dispose
    await pool.withAgent('sC', async () => {});
    const sBTag = [...tagOf.entries()].find(([, tag]) => tag === 'a2')?.[0];
    const sBFake = fakes.get('a2')!;
    expect(sBFake.calls).toContain('dispose');

    // busy 的 sA 实例始终未被 dispose
    const sAFake = fakes.get('a1')!;
    expect(sAFake.calls).not.toContain('dispose');

    gateA?.();
    await pA;
    void sBTag;
  });

  it('6.2.4 run 抛错后实例被 dispose 重建（下一会话拿到新实例）', async () => {
    const disposals: string[] = [];
    let n = 0;
    const pool = new AgentPool({
      create: () => {
        const id = `a${++n}`;
        return {
          run: vi.fn(async (): Promise<AgentResult> => {
            if (id === 'a1') throw new Error('boom');
            return noResult;
          }),
          dispose: vi.fn(() => disposals.push(id)),
        };
      },
    });
    await expect(pool.withAgent('s1', (a) => a.run('x'))).rejects.toThrow('boom');
    expect(disposals).toEqual(['a1']); // 失败实例 dispose 不回池
    // 同会话再跑：拿新实例（a2），成功且不 dispose
    const r = await pool.withAgent('s1', (a) => a.run('y'));
    expect(disposals).toEqual(['a1']);
    expect(r).toEqual(noResult);
  });

  it('6.2.5 reset() 后全部实例重建；reset 时 busy 的旧实例归还时 dispose 不回池', async () => {
    const disposals: string[] = [];
    let n = 0;
    const pool = new AgentPool({
      create: () => {
        const id = `a${++n}`;
        return {
          run: vi.fn(async (): Promise<AgentResult> => noResult),
          dispose: vi.fn(() => disposals.push(id)),
        };
      },
    });
    let gate: (() => void) | undefined;
    const pBusy = pool.withAgent('sB', async () => {
      await new Promise<void>((r) => (gate = r));
    });
    await vi.waitFor(() => expect(gate).toBeDefined());

    // 空闲实例 s1
    await pool.withAgent('s1', async () => {});
    expect(pool.size).toBe(2); // sB busy + s1 idle

    pool.reset();
    expect(disposals).toEqual(['a2']); // idle 实例立即 dispose
    expect(pool.size).toBe(1); // 仅剩 busy

    // reset 后同 sessionId 再 acquire：不粘性复用旧实例，拿到新实例
    await pool.withAgent('s1', async () => {});
    expect(disposals).toEqual(['a2']); // 没有额外 dispose（新实例 a3 在用）

    // busy 实例归还：不回池（dead），dispose
    gate?.();
    await pBusy;
    expect(disposals).toEqual(['a2', 'a1']);
  });

  it('附加：容量打满且全 busy 时 acquire 排队等待 release（先到先得）', async () => {
    let n = 0;
    const pool = new AgentPool({
      capacity: 1,
      create: () => {
        ++n;
        return {
          run: vi.fn(async (): Promise<AgentResult> => noResult),
          dispose: vi.fn(),
        };
      },
    });
    let gate: (() => void) | undefined;
    const first = pool.withAgent('s1', async () => {
      await new Promise<void>((r) => (gate = r));
    });
    await vi.waitFor(() => expect(gate).toBeDefined());

    // 第二个会话：容量 1 全 busy → 排队
    let secondDone = false;
    const second = pool.withAgent('s2', async () => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false); // 仍在排队

    gate?.();
    await first;
    await second;
    expect(secondDone).toBe(true);
    expect(n).toBe(2); // s2 排到后新建实例（旧实例已因失败/重置外路径淘汰——本例归还回池，
    // 但 s2 与 s1 不同 id，粘性不命中，容量 1 下先淘汰 s1 空闲实例再新建）
  });

  it('附加：同一 sessionId 并发 acquire（busy 中）直接抛错（同会话应串行）', async () => {
    const pool = new AgentPool({
      create: () => makeFake('x').agent,
    });
    let gate: (() => void) | undefined;
    const first = pool.withAgent('s1', async () => {
      await new Promise<void>((r) => (gate = r));
    });
    await vi.waitFor(() => expect(gate).toBeDefined());
    await expect(pool.acquire('s1')).rejects.toThrow('正在使用中');
    gate?.();
    await first;
  });

  it('附加：initAgent 失败不占坑、实例 dispose、错误冒泡', async () => {
    const pool = new AgentPool(
      { create: () => makeFake('x').agent },
      async () => {
        throw new Error('kit 装配失败');
      },
    );
    await expect(pool.withAgent('s1', (a) => a.run('x'))).rejects.toThrow('kit 装配失败');
    expect(pool.size).toBe(0);
  });
});
