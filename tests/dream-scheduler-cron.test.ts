/**
 * Task-20261026-003-01 单测：cron 模式调度器（方案 D4/D5/D10 + 历史集成）
 *
 * 覆盖任务文档 6.2 清单：
 * - cron 模式：默认 `0 3 * * *` 的 nextRunAt 落在本地 03:00
 * - 分片等待（D4）：等待间隔大于 6h 时按 6h 分片，nextRunAt 仍是真实触发点
 * - 分片到点未到期 → 不触发，仅重排
 * - 正常到点 → 触发一次，摘要进入历史
 * - 补跑（D5）：迟到 5 分钟（≤ 宽限）→ 执行且 catchup=true
 * - 错过（D5）：迟到 120 分钟（> 宽限 60）→ 不执行，历史里一条 skippedBecause='missed'
 * - DST 去重（D4 坑 3）：同一本地墙钟分钟第二次到达 → 跳过
 * - 热重排（D10）：改 cron → nextRunAt 变化；enabled=false → 定时器清空
 * - cron 被改坏 → 回落间隔模式，status.cronError 有值
 * - 历史：historyFor / clearHistory / historyLimit=0
 * - statusFor：cron / describe / nextRunTimes / intervalMode / timezoneOffsetMin
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DreamScheduler, type DreamTimer } from '../src/api/dream-scheduler.js';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../src/memory/types.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { WorkspaceRuntime, WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import type { MemoryKit } from '../src/api/memory-kit.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-dream-scheduler-cron');

// ---------- 夹具 ----------

function makeAgentConfig(dreaming: Partial<MemoryConfig['dreaming']> = {}): AgentConfig {
  return {
    memory: {
      ...DEFAULT_MEMORY_CONFIG,
      dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, ...dreaming },
    },
  } as unknown as AgentConfig;
}

interface Fixture {
  rt: WorkspaceRuntime;
  /** dream.run 调用次数 */
  runs: () => number;
  /** 该空间运行历史文件目录 */
  memoryDir: string;
  /** 生效中的记忆配置（调度器 getConfig 与 runtime configLoader 共用同一份，便于模拟改配置） */
  memory: { value: MemoryConfig };
}

function makeRuntime(
  opts: {
    root: string;
    id: string;
    memoryDir: string;
    dreaming?: Partial<MemoryConfig['dreaming']>;
    fail?: boolean;
    memory?: { value: MemoryConfig };
  },
): Fixture {
  mkdirSync(opts.memoryDir, { recursive: true });
  let runCount = 0;
  const dream = {
    async getState() {
      return { lastProcessedDay: '' };
    },
    async run() {
      runCount++;
      if (opts.fail) throw new Error('429 限流');
      return { promoted: [{}, {}], skipped: [{}], errors: [] };
    },
    async recordRun() {},
  };
  const kit = {
    dream,
    episodic: { getMemoryDir: () => opts.memoryDir },
  } as unknown as MemoryKit;
  const memory: { value: MemoryConfig } = opts.memory ?? {
    value: {
      ...DEFAULT_MEMORY_CONFIG,
      enabled: true,
      dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, ...(opts.dreaming ?? {}) },
    },
  };
  const rt = {
    root: opts.root,
    id: opts.id,
    configLoader: { load: () => ({ config: { memory: memory.value } }) },
    sessions: { hasInFlight: () => false },
    getMemoryKit: async () => kit,
  } as unknown as WorkspaceRuntime;
  return { rt, runs: () => runCount, memoryDir: opts.memoryDir, memory };
}

function makeRegistry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return {
    peek: (root: string) => runtimes.find((r) => r.root === root),
    list: () => runtimes,
  } as unknown as WorkspaceRegistry;
}

/** 可控定时器：记录每次注册的延迟与回调，可手动 fire */
function makeTimerSpy(): {
  create: (fn: () => void, ms: number) => DreamTimer;
  created: { ms: number; fn: () => void }[];
  cancelled: number[];
} {
  const created: { ms: number; fn: () => void }[] = [];
  const cancelled: number[] = [];
  return {
    created,
    cancelled,
    create: (fn: () => void, ms: number): DreamTimer => {
      created.push({ ms, fn });
      const idx = created.length - 1;
      return { cancel: () => cancelled.push(idx) };
    },
  };
}

/** 让 fire-and-forget 的 async 链路（onTimer / appendHistory）跑完 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** 本地时间构造 */
function local(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo, d, h, mi, 0, 0).getTime();
}

const WS_ROOT = join(ROOT, 'ws-a');

interface Built {
  sched: DreamScheduler;
  fx: Fixture;
  spy: ReturnType<typeof makeTimerSpy>;
  setNow: (ms: number) => void;
  now: () => number;
  /** 改生效配置（模拟 PUT /memory/dream/schedule 落盘后重读） */
  setMemory: (patch: Partial<MemoryConfig['dreaming']> & { enabled?: boolean }) => void;
}

/** 构造一个带单空间 runtime 的调度器（时钟、定时器、配置均受控） */
function build(opts: {
  nowMs: number;
  dreaming?: Partial<MemoryConfig['dreaming']>;
  fail?: boolean;
}): Built {
  const memory: { value: MemoryConfig } = {
    value: {
      ...DEFAULT_MEMORY_CONFIG,
      enabled: true,
      dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, ...(opts.dreaming ?? {}) },
    },
  };
  const fx = makeRuntime({
    root: WS_ROOT,
    id: 'ws-a',
    memoryDir: join(ROOT, 'memory-a'),
    fail: opts.fail,
    memory,
  });
  const spy = makeTimerSpy();
  let nowMs = opts.nowMs;
  // 调度器的进程级 getConfig 与 runtime 的 configLoader 共用同一份 memory 配置
  const getConfig = (): AgentConfig => ({ memory: memory.value }) as unknown as AgentConfig;
  const sched = new DreamScheduler({
    registry: makeRegistry([fx.rt]),
    getConfig,
    log: () => {},
    now: () => nowMs,
    createTimer: spy.create,
  });
  return {
    sched,
    fx,
    spy,
    now: () => nowMs,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setMemory: (patch) => {
      memory.value = {
        ...memory.value,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        dreaming: { ...memory.value.dreaming, ...patch },
      };
    },
  };
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// ---------- 排期 ----------

describe('cron 模式排期（D4）', () => {
  it('默认 `0 3 * * *`：22:13 启动 → nextRunAt 落在次日本地 03:00', () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    expect(b.spy.created).toHaveLength(1);
    const expectNext = local(2026, 9, 27, 3, 0);
    expect(b.spy.created[0].ms).toBe(expectNext - b.now());
  });

  it('间隔超过 6h 时按 6h 分片，nextRunAt 仍是真实触发点（不是 6h 后）', async () => {
    // `0 3 1 1 *`：每年 1 月 1 日 03:00 → 距 2026-10-26 66 天，远超 6h
    const b = build({ nowMs: local(2026, 9, 26, 22, 13), dreaming: { schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, cron: '0 3 1 1 *' } } });
    b.sched.start();
    expect(b.spy.created[0].ms).toBe(6 * 3_600_000); // 分片上限
    const st = await b.sched.statusFor(WS_ROOT);
    expect(st?.nextRunAt).toBe(new Date(local(2027, 0, 1, 3, 0)).toISOString());
    expect(st?.intervalMode).toBe('cron');
  });

  it('分片到点但真实触发时刻未到 → 不跑 Dreaming，只重排下一片', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13), dreaming: { schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, cron: '0 3 1 1 *' } } });
    b.sched.start();
    b.spy.created[0].fn(); // 6h 后分片到点
    await flush();
    expect(b.fx.runs()).toBe(0);
    expect(b.spy.created.length).toBe(2); // 又排了一片
    expect(b.spy.created[1].ms).toBe(6 * 3_600_000);
  });

  it('正常到点 → 执行一次，摘要进入运行历史', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 3, 0));
    b.spy.created[0].fn();
    await flush();
    expect(b.fx.runs()).toBe(1);
    const runs = await b.sched.historyFor(WS_ROOT);
    expect(runs).toHaveLength(1);
    expect(runs?.[0]).toMatchObject({ reason: 'schedule', ok: true, promoted: 2, skipped: 1, errors: 0 });
    expect(runs?.[0].catchup).toBeUndefined(); // 准时，不算补跑
  });

  it('迟到 5 分钟（≤ 宽限 60）→ 补跑并标 catchup', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 3, 5));
    b.spy.created[0].fn();
    await flush();
    expect(b.fx.runs()).toBe(1);
    const runs = await b.sched.historyFor(WS_ROOT);
    expect(runs?.[0].catchup).toBe(true);
  });

  it('迟到 120 分钟（> 宽限 60）→ 不执行，历史记一条「错过」', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 5, 0));
    b.spy.created[0].fn();
    await flush();
    expect(b.fx.runs()).toBe(0);
    const runs = await b.sched.historyFor(WS_ROOT);
    expect(runs).toHaveLength(1);
    expect(runs?.[0].skippedBecause).toBe('missed');
    expect(runs?.[0].errorMessage).toContain('错失触发点');
  });

  it('宽限设为 0 → 迟到 1 分钟即算错过', async () => {
    const b = build({
      nowMs: local(2026, 9, 26, 22, 13),
      dreaming: { schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, cron: '0 3 * * *', misfireGraceMin: 0 } },
    });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 3, 1));
    b.spy.created[0].fn();
    await flush();
    expect(b.fx.runs()).toBe(0);
    expect((await b.sched.historyFor(WS_ROOT))?.[0].skippedBecause).toBe('missed');
  });

  it('DST 回拨去重：同一本地墙钟分钟第二次到达不重复触发', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    // 第一次：正常到点触发
    b.setNow(local(2026, 9, 27, 3, 0));
    b.spy.created[0].fn();
    await flush();
    expect(b.fx.runs()).toBe(1);
    // 时钟回拨到同日 02:59:30，重新排期又指向同一天 03:00
    b.setNow(local(2026, 9, 27, 2, 59) + 30_000);
    b.sched.reschedule();
    const last = b.spy.created[b.spy.created.length - 1];
    b.setNow(local(2026, 9, 27, 3, 0));
    last.fn();
    await flush();
    expect(b.fx.runs()).toBe(1); // 未重复触发
  });
});

// ---------- 热重排 ----------

describe('reschedule 热重排（D10）', () => {
  it('改 cron 后 reschedule → nextRunAt 立即变化（免重启）', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    expect((await b.sched.statusFor(WS_ROOT))?.nextRunAt).toBe(new Date(local(2026, 9, 27, 3, 0)).toISOString());

    // 模拟 PUT /memory/dream/schedule 写盘后配置生效
    b.setMemory({ schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, cron: '30 4 * * *' } });
    b.sched.reschedule();
    expect((await b.sched.statusFor(WS_ROOT))?.nextRunAt).toBe(new Date(local(2026, 9, 27, 4, 30)).toISOString());
    expect(b.spy.cancelled.length).toBeGreaterThanOrEqual(1); // 旧定时器被取消
  });

  it('schedule.enabled=false → 清定时器且 nextRunAt 置空', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    b.setMemory({ schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, enabled: false } });
    b.sched.reschedule();
    const st = await b.sched.statusFor(WS_ROOT);
    expect(st?.scheduleEnabled).toBe(false);
    expect(st?.nextRunAt).toBeUndefined();
  });

  it('stop 后的 reschedule 不再注册定时器（关停优先）', () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    const before = b.spy.created.length;
    b.sched.stop();
    b.sched.reschedule();
    expect(b.spy.created.length).toBe(before);
  });

  it('cron 被改坏 → 回落间隔模式，status.cronError 暴露原因', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    b.setMemory({ schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, cron: '0 25 * * *' } });
    b.sched.reschedule();
    const st = await b.sched.statusFor(WS_ROOT);
    expect(st?.intervalMode).toBe('interval');
    expect(st?.cronValid).toBe(false);
    expect(st?.cronError).toContain('0-23');
    expect(st?.nextRunTimes).toEqual([]);
    // 间隔模式仍排了定时器（不永久失灵）
    expect(b.spy.created.length).toBeGreaterThan(1);
  });
});

// ---------- statusFor ----------

describe('statusFor（GET /memory/status.dreaming 扩展）', () => {
  it('cron 模式下暴露 cron/describe/nextRunTimes/timezoneOffsetMin', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    const st = await b.sched.statusFor(WS_ROOT);
    expect(st).toMatchObject({ cron: '0 3 * * *', cronValid: true, describe: '每天 03:00', intervalMode: 'cron' });
    expect(st?.nextRunTimes).toHaveLength(3);
    expect(st?.timezoneOffsetMin).toBe(-new Date().getTimezoneOffset());
    expect(st?.misfireGraceMin).toBe(60);
    // deprecated 字段保留一版（D14）
    expect(st?.intervalHours).toBe(24);
    expect(st?.startupDelayMin).toBe(5);
  });

  it('intervalMode 在无 cron 时为 interval，cron 为空视为 cronValid=true', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13), dreaming: { schedule: { ...DEFAULT_MEMORY_CONFIG.dreaming.schedule, cron: '' } } });
    b.sched.start();
    const st = await b.sched.statusFor(WS_ROOT);
    expect(st?.intervalMode).toBe('interval');
    expect(st?.cronValid).toBe(true);
    expect(st?.nextRunTimes).toEqual([]);
  });

  it('未装载的 runtime → null', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    expect(await b.sched.statusFor('/not-loaded')).toBeNull();
    expect(await b.sched.historyFor('/not-loaded')).toBeNull();
    expect(await b.sched.clearHistory('/not-loaded')).toBeNull();
  });
});

// ---------- 历史读写 ----------

describe('运行历史（D7/D8）', () => {
  it('historyFor 返回新→旧；clearHistory 返回删除条数', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 3, 0));
    b.spy.created[0].fn();
    await flush();
    b.setNow(local(2026, 9, 28, 3, 0));
    b.spy.created[b.spy.created.length - 1].fn();
    await flush();

    const runs = await b.sched.historyFor(WS_ROOT);
    expect(runs).toHaveLength(2);
    expect(Date.parse(runs![0].startedAt)).toBeGreaterThan(Date.parse(runs![1].startedAt));

    expect(await b.sched.clearHistory(WS_ROOT)).toBe(2);
    expect(await b.sched.historyFor(WS_ROOT)).toEqual([]);
  });

  it('historyLimit=0 → 不落盘（historyFor 返回空）', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13), dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, historyLimit: 0 } });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 3, 0));
    b.spy.created[0].fn();
    await flush();
    expect(b.fx.runs()).toBe(1);
    expect(await b.sched.historyFor(WS_ROOT)).toEqual([]);
  });

  it('异常场景落 errorMessage（截断后）', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13), fail: true });
    b.sched.start();
    b.setNow(local(2026, 9, 27, 3, 0));
    b.spy.created[0].fn();
    await flush();
    const runs = await b.sched.historyFor(WS_ROOT);
    expect(runs?.[0]).toMatchObject({ ok: false, errors: 1, promoted: 0 });
    expect(runs?.[0].errorMessage).toBe('429 限流');
  });

  it('「disabled」不入历史（D8：配置关闭期间的每轮噪声无观测价值）', async () => {
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    b.setMemory({ enabled: false });
    await b.sched.runFor(WS_ROOT, 'manual');
    await flush();
    expect(await b.sched.historyFor(WS_ROOT)).toEqual([]);
  });

  it('「跳过（进行中）」入历史（同空间并发第二次让位）', async () => {
    // 让第一次 run 悬停，制造真实并发窗口
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const b = build({ nowMs: local(2026, 9, 26, 22, 13) });
    const kit = await b.fx.rt.getMemoryKit();
    const realRun = kit.dream.run.bind(kit.dream);
    kit.dream.run = async (...args: Parameters<typeof realRun>) => {
      await gate;
      return realRun(...args);
    };

    const first = b.sched.runFor(WS_ROOT, 'manual');
    const second = await b.sched.runFor(WS_ROOT, 'manual');
    expect(second.skippedBecause).toBe('already-running');
    release();
    await first;
    await flush();

    const runs = await b.sched.historyFor(WS_ROOT);
    expect(runs).toHaveLength(2);
    expect(runs?.map((r) => r.skippedBecause ?? null).sort()).toEqual([null, 'already-running'].sort());
  });
});
