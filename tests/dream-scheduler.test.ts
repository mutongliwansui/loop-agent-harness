/**
 * Task-20261026-002 单测：记忆晋升（Dreaming）调度器
 *
 * 覆盖任务文档 6.3 清单：
 * - 单飞锁：并发两次 runFor → 第二次 already-running，dream.run 只调一次
 * - 配置关闭：dreaming.enabled=false / schedule.enabled=false 两条跳过路径
 * - D3 窗口放大：lastProcessedDay 为 3/7/40 天前 → daysBack 取 4/8/30
 * - D8 让位：hasInFlight() 为真时 schedule 跳过，shutdown 不跳过
 * - 关停预算：dream 永不 resolve → runAllForShutdown 在预算内返回且不挂
 * - 错误隔离：第一个空间抛错，第二个仍执行
 * - 状态回写：recordRun 后 getState 能读到；旧格式状态文件读取不炸
 * - 定时器：start 后 stop 无残留；schedule.enabled=false 不注册
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DreamScheduler, computeEffectiveDaysBack, type DreamTimer } from '../src/api/dream-scheduler.js';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../src/memory/types.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { WorkspaceRuntime, WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import type { MemoryKit } from '../src/api/memory-kit.js';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { CuratedMemory } from '../src/memory/curated.js';
import { PromotionGate } from '../src/memory/gate.js';
import { DreamingPipeline } from '../src/memory/dreaming.js';
import type { ILLMClient } from '../src/memory/types.js';

const TMP_ROOT = join(tmpdir(), 'loop-agent-tests', 'test-dream-scheduler');

/** 已打开的 EpisodicMemory（SQLite 索引句柄需显式关闭，否则 Windows 上删目录会 EPERM） */
const openedEpisodics: EpisodicMemory[] = [];

afterAll(() => {
  for (const e of openedEpisodics) {
    try {
      e.closeIndex();
    } catch {
      // 忽略：未建索引时无可关闭句柄
    }
  }
  rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------- 测试夹具 ----------

/** 构造进程级配置（只关心 memory 段） */
function makeAgentConfig(dreaming: Partial<MemoryConfig['dreaming']> = {}): AgentConfig {
  return {
    memory: {
      ...DEFAULT_MEMORY_CONFIG,
      dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, ...dreaming },
    },
  } as unknown as AgentConfig;
}

/** 空 DreamingResult */
function emptyResult(): { promoted: unknown[]; skipped: unknown[]; errors: string[] } {
  return { promoted: [], skipped: [], errors: [] };
}

interface FakeRuntimeOptions {
  root: string;
  id: string;
  dreaming?: Partial<MemoryConfig['dreaming']>;
  memoryEnabled?: boolean;
  busy?: boolean;
  lastProcessedDay?: string;
  run?: (daysBack: number) => Promise<{ promoted: unknown[]; skipped: unknown[]; errors: string[] }>;
}

/** 假 runtime：只实现调度器实际消费的 5 个成员 */
function makeRuntime(opts: FakeRuntimeOptions): {
  rt: WorkspaceRuntime;
  recorder: { daysBack: number; options: unknown }[];
  state: { lastProcessedDay?: string; lastRunAt?: string; lastSummary?: unknown };
} {
  const recorder: { daysBack: number; options: unknown }[] = [];
  const state: { lastProcessedDay?: string; lastRunAt?: string; lastSummary?: unknown } = {
    lastProcessedDay: opts.lastProcessedDay ?? '',
  };
  const memory: MemoryConfig = {
    ...DEFAULT_MEMORY_CONFIG,
    enabled: opts.memoryEnabled ?? true,
    dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, ...(opts.dreaming ?? {}) },
  };
  const kit = {
    dream: {
      async getState() {
        return { ...state };
      },
      async run(daysBack: number, _onProgress: unknown, options: unknown) {
        recorder.push({ daysBack, options });
        return await (opts.run ?? (async () => emptyResult()))(daysBack);
      },
      async recordRun(rec: { reason: string; promoted: number; skipped: number; errors: number; ok: boolean }) {
        state.lastRunAt = new Date().toISOString();
        state.lastSummary = { ...rec };
      },
    },
  } as unknown as MemoryKit;

  const rt = {
    root: opts.root,
    id: opts.id,
    configLoader: { load: () => ({ config: { memory } }) },
    sessions: { hasInFlight: () => opts.busy === true },
    getMemoryKit: async () => kit,
  } as unknown as WorkspaceRuntime;

  return { rt, recorder, state };
}

function makeRegistry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return {
    peek: (root: string) => runtimes.find((r) => r.root === root),
    list: () => runtimes,
  } as unknown as WorkspaceRegistry;
}

/** 记录型日志，便于断言跳过原因出现在日志里 */
function makeLog(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

/** 手动可控定时器（测试 start/stop 行为） */
function makeTimerSpy(): { create: (fn: () => void, ms: number) => DreamTimer; created: number[]; cancelled: number[] } {
  const created: number[] = [];
  const cancelled: number[] = [];
  return {
    created,
    cancelled,
    create: (_fn: () => void, ms: number): DreamTimer => {
      created.push(ms);
      const idx = created.length - 1;
      return { cancel: () => cancelled.push(idx) };
    },
  };
}

// ---------- D3：读取窗口放大 ----------

describe('computeEffectiveDaysBack（D3 补齐停机漏数）', () => {
  // 固定「今天」= 2026-10-26T12:00Z，避免测试跨日漂移
  const NOW = Date.UTC(2026, 9, 26, 12);
  const dayBefore = (offset: number): string => new Date(NOW - offset * 86_400_000).toISOString().slice(0, 10);

  it('无历史状态时取配置下限 daysBack', () => {
    expect(computeEffectiveDaysBack('', NOW, { daysBack: 3, maxDaysBack: 30 })).toBe(3);
  });

  it('3 天前处理过 → 窗口放大到 4 天', () => {
    expect(computeEffectiveDaysBack(dayBefore(3), NOW, { daysBack: 3, maxDaysBack: 30 })).toBe(4);
  });

  it('7 天前处理过（停机一周）→ 窗口放大到 8 天', () => {
    expect(computeEffectiveDaysBack(dayBefore(7), NOW, { daysBack: 3, maxDaysBack: 30 })).toBe(8);
  });

  it('40 天前处理过 → 受 maxDaysBack 上限约束取 30', () => {
    expect(computeEffectiveDaysBack(dayBefore(40), NOW, { daysBack: 3, maxDaysBack: 30 })).toBe(30);
  });

  it('昨天处理过 → 回落 daysBack 下限（不做负向放大）', () => {
    expect(computeEffectiveDaysBack(dayBefore(1), NOW, { daysBack: 3, maxDaysBack: 30 })).toBe(3);
  });

  it('未来日期（时钟回拨）→ 回落 daysBack 下限', () => {
    expect(computeEffectiveDaysBack(dayBefore(-2), NOW, { daysBack: 3, maxDaysBack: 30 })).toBe(3);
  });

  it('非法日期字符串 → 回落 daysBack 下限，不抛错', () => {
    expect(computeEffectiveDaysBack('not-a-date', NOW, { daysBack: 3 })).toBe(3);
  });
});

// ---------- 单飞锁 / 跳过路径 ----------

describe('DreamScheduler.runFor（D7 单飞锁 / D8 让位 / 配置关闭）', () => {
  let log: ReturnType<typeof makeLog>;
  beforeEach(() => {
    log = makeLog();
  });

  it('并发两次 runFor：第二次 skippedBecause=already-running，dream.run 只调一次', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { rt, recorder } = makeRuntime({
      root: '/ws/a',
      id: 'ws-a',
      run: async () => {
        await gate;
        return { promoted: [{}, {}], skipped: [{}], errors: [] };
      },
    });
    const sched = new DreamScheduler({ registry: makeRegistry([rt]), getConfig: () => makeAgentConfig(), log: log.log });

    const first = sched.runFor('/ws/a', 'manual');
    const second = await sched.runFor('/ws/a', 'manual');

    expect(second.skippedBecause).toBe('already-running');
    expect(sched.isRunning('/ws/a')).toBe(true);

    release!();
    const done = await first;
    // 真正执行过且只执行过一次（若单飞锁失效，这里会是 2）
    expect(recorder).toHaveLength(1);
    expect(done.skippedBecause).toBeUndefined();
    expect(done.promoted).toBe(2);
    expect(done.skipped).toBe(1);
    expect(sched.isRunning('/ws/a')).toBe(false);
    expect(log.lines.some((l) => l.includes('跳过（already-running）'))).toBe(true);
  });

  it('dreaming.enabled=false → skippedBecause=disabled，不做任何 LLM 调用', async () => {
    // 需求 20261112-008：Dreaming 全空间参与，配置取进程级（getConfig），不再读各空间 runtime 配置
    const { rt, recorder } = makeRuntime({ root: '/ws/a', id: 'ws-a' });
    const sched = new DreamScheduler({
      registry: makeRegistry([rt]),
      getConfig: () => makeAgentConfig({ enabled: false }),
      log: log.log,
    });
    const r = await sched.runFor('/ws/a', 'schedule');
    expect(r.skippedBecause).toBe('disabled');
    expect(recorder).toHaveLength(0);
  });

  it('memory.enabled=false（进程级）→ skippedBecause=disabled', async () => {
    const { rt, recorder } = makeRuntime({ root: '/ws/a', id: 'ws-a' });
    const cfg = makeAgentConfig();
    (cfg.memory as { enabled: boolean }).enabled = false;
    const sched = new DreamScheduler({ registry: makeRegistry([rt]), getConfig: () => cfg, log: log.log });
    const r = await sched.runFor('/ws/a', 'schedule');
    expect(r.skippedBecause).toBe('disabled');
    expect(recorder).toHaveLength(0);
  });

  it('runtime 未装载 → skippedBecause=no-runtime', async () => {
    const sched = new DreamScheduler({ registry: makeRegistry([]), getConfig: () => makeAgentConfig(), log: log.log });
    const r = await sched.runFor('/ws/none', 'schedule');
    expect(r.skippedBecause).toBe('no-runtime');
  });

  it('D8：同空间有 in-flight run 时 schedule 跳过，shutdown 不跳过', async () => {
    const { rt, recorder } = makeRuntime({ root: '/ws/busy', id: 'ws-busy', busy: true });
    const sched = new DreamScheduler({ registry: makeRegistry([rt]), getConfig: () => makeAgentConfig(), log: log.log });

    const schedRun = await sched.runFor('/ws/busy', 'schedule');
    expect(schedRun.skippedBecause).toBe('busy');
    expect(recorder).toHaveLength(0);

    const shutRun = await sched.runFor('/ws/busy', 'shutdown');
    expect(shutRun.skippedBecause).toBeUndefined();
    expect(recorder).toHaveLength(1);
  });
});

// ---------- 定时轮 ----------

describe('DreamScheduler 定时轮（start/stop/tick）', () => {
  it('schedule.enabled=false 时不注册任何定时器', () => {
    const spy = makeTimerSpy();
    const sched = new DreamScheduler({
      registry: makeRegistry([]),
      getConfig: () => makeAgentConfig({ schedule: { enabled: false, intervalHours: 24, startupDelayMin: 5 } }),
      log: () => {},
      createTimer: spy.create,
    });
    sched.start();
    expect(spy.created).toHaveLength(0);
  });

  it('cron 为空时回落间隔模式，按 startupDelayMin 注册首轮定时器，stop 后无残留', () => {
    const spy = makeTimerSpy();
    const sched = new DreamScheduler({
      registry: makeRegistry([]),
      getConfig: () => makeAgentConfig({ schedule: { enabled: true, cron: '', intervalHours: 24, startupDelayMin: 5 } }),
      log: () => {},
      createTimer: spy.create,
    });
    sched.start();
    expect(spy.created).toEqual([5 * 60_000]); // 5 分钟
    sched.stop();
    expect(spy.cancelled).toEqual([0]);
  });

  it('默认配置按 cron（每天 03:00）注册，单次等待不超过 6h 分片（Task-20261026-003 D4）', () => {
    const spy = makeTimerSpy();
    const sched = new DreamScheduler({
      registry: makeRegistry([]),
      getConfig: () => makeAgentConfig(),
      log: () => {},
      createTimer: spy.create,
    });
    sched.start();
    expect(spy.created).toHaveLength(1);
    // 单次等待上限 6h：超过 24.8 天的 setTimeout 会立即触发，故必须分片
    expect(spy.created[0]).toBeGreaterThan(0);
    expect(spy.created[0]).toBeLessThanOrEqual(6 * 60 * 60_000);
    sched.stop();
    expect(spy.cancelled).toEqual([0]);
  });

  it('tick 遍历全部已装载空间，逐个记录摘要', async () => {
    const a = makeRuntime({ root: '/ws/a', id: 'ws-a' });
    const b = makeRuntime({ root: '/ws/b', id: 'ws-b' });
    const sched = new DreamScheduler({
      registry: makeRegistry([a.rt, b.rt]),
      getConfig: () => makeAgentConfig(),
      log: () => {},
    });
    const out = await sched.tick();
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.root)).toEqual(['/ws/a', '/ws/b']);
    expect(a.recorder).toHaveLength(1);
    expect(b.recorder).toHaveLength(1);
  });

  it('进程级 dreaming.enabled=false 时 tick 直接返回空（不遍历空间）', async () => {
    const a = makeRuntime({ root: '/ws/a', id: 'ws-a' });
    const sched = new DreamScheduler({
      registry: makeRegistry([a.rt]),
      getConfig: () => makeAgentConfig({ enabled: false }),
      log: () => {},
    });
    expect(await sched.tick()).toEqual([]);
    expect(a.recorder).toHaveLength(0);
  });
});

// ---------- 关停兜底 ----------

describe('DreamScheduler.runAllForShutdown（D4/D5 串行 + 预算）', () => {
  it('超预算时不再等待：dream 永不 resolve 也能在预算内返回', async () => {
    const { rt } = makeRuntime({
      root: '/ws/hang',
      id: 'ws-hang',
      run: () => new Promise(() => {}), // 永不 resolve
    });
    const log = makeLog();
    const sched = new DreamScheduler({ registry: makeRegistry([rt]), getConfig: () => makeAgentConfig(), log: log.log });

    const started = Date.now();
    const out = await sched.runAllForShutdown(30);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(out).toEqual([]); // 未完成的空间不产出摘要
    expect(log.lines.some((l) => l.includes('超出预算'))).toBe(true);
  });

  it('错误隔离：第一个空间抛错不影响第二个，进程不中断', async () => {
    const first = makeRuntime({
      root: '/ws/bad',
      id: 'ws-bad',
      run: async () => {
        throw new Error('mock 晋升失败');
      },
    });
    const second = makeRuntime({ root: '/ws/ok', id: 'ws-ok' });
    const sched = new DreamScheduler({
      registry: makeRegistry([first.rt, second.rt]),
      getConfig: () => makeAgentConfig(),
      log: () => {},
    });

    const out = await sched.runAllForShutdown(5000);
    expect(out).toHaveLength(2);
    expect(out[0].ok).toBe(false);
    expect(out[0].errors).toBe(1);
    expect(out[1].ok).toBe(true);
    expect(second.recorder).toHaveLength(1);
  });

  it('onExit=false 时关停不做晋升', async () => {
    const { rt, recorder } = makeRuntime({ root: '/ws/a', id: 'ws-a' });
    const sched = new DreamScheduler({
      registry: makeRegistry([rt]),
      getConfig: () => makeAgentConfig({ onExit: false }),
      log: () => {},
    });
    expect(await sched.runAllForShutdown(5000)).toEqual([]);
    expect(recorder).toHaveLength(0);
  });

  it('关停后拒绝新的定时轮（stopped）', async () => {
    const a = makeRuntime({ root: '/ws/a', id: 'ws-a' });
    const sched = new DreamScheduler({ registry: makeRegistry([a.rt]), getConfig: () => makeAgentConfig(), log: () => {} });
    await sched.runAllForShutdown(5000);
    expect(await sched.tick()).toEqual([]);
  });
});

// ---------- 状态回写与可观测 ----------

describe('DreamingPipeline 状态扩展（D9 可观测）', () => {
  let dir: string;
  let pipeline: DreamingPipeline;

  beforeEach(async () => {
    dir = join(TMP_ROOT, `case-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const episodic = new EpisodicMemory(join(dir, 'episodic'));
    openedEpisodics.push(episodic);
    await episodic.init();
    const curated = new CuratedMemory(join(dir, 'ws'), { maxLines: 0, compress: async () => null }, join(dir, 'curated'));
    await curated.init();
    const gate = new PromotionGate();
    await gate.loadState(join(dir, 'ws'));
    const llm: ILLMClient = { chat: async () => ({ content: '[]' }) };
    pipeline = new DreamingPipeline(episodic, gate, curated, llm);
  });

  it('recordRun 后 getState 能读到 lastRunAt / lastSummary', async () => {
    await pipeline.recordRun({ reason: 'schedule', promoted: 3, skipped: 1, errors: 0, ok: true });
    const state = await pipeline.getState();
    expect(state.lastRunAt).toBeTruthy();
    expect(state.lastSummary).toEqual({ reason: 'schedule', promoted: 3, skipped: 1, errors: 0, ok: true });
  });

  it('旧格式状态文件（只有 lastProcessedDay）读取不炸', async () => {
    mkdirSync(join(dir, 'episodic'), { recursive: true });
    writeFileSync(join(dir, 'episodic', '.dreaming-state.json'), JSON.stringify({ lastProcessedDay: '2026-10-20' }));
    const state = await pipeline.getState();
    expect(state.lastProcessedDay).toBe('2026-10-20');
    expect(state.lastRunAt).toBeUndefined();
    expect(state.lastSummary).toBeUndefined();
  });

  it('recordRun 不抹掉已有的 lastProcessedDay（合并写入）', async () => {
    mkdirSync(join(dir, 'episodic'), { recursive: true });
    writeFileSync(join(dir, 'episodic', '.dreaming-state.json'), JSON.stringify({ lastProcessedDay: '2026-10-20' }));
    await pipeline.recordRun({ reason: 'shutdown', promoted: 0, skipped: 0, errors: 0, ok: true });
    const state = await pipeline.getState();
    expect(state.lastProcessedDay).toBe('2026-10-20');
    expect(state.lastSummary?.reason).toBe('shutdown');
  });

  it('损坏的状态文件回落默认值，不抛错', async () => {
    mkdirSync(join(dir, 'episodic'), { recursive: true });
    writeFileSync(join(dir, 'episodic', '.dreaming-state.json'), '{ 这不是 JSON');
    const state = await pipeline.getState();
    expect(state.lastProcessedDay).toBe('');
  });
});
