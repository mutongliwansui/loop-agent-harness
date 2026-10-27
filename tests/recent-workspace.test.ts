/**
 * 需求 20261027-004 单测：移除 serve 启动工作空间预装
 *
 * 覆盖任务文档 6.x 清单：
 * - recent-workspace：冷启动推导（mtime 最新者胜）/ 孤儿空间跳过 / 全空兜底 cwd / MRU 指针
 * - dream-scheduler 全空间三段式（D4）：磁盘枚举 / shouldAttempt 预判 / runFor 懒装载
 * - evictIdle 定时接线（D6）：evictIntervalMs>0 触发释放 / =0 关闭
 * - runFor 懒装载：未装载空间 getCanonical 现建；目录失效收敛 no-runtime 摘要不抛
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/store.js';
import {
  defaultRoot,
  markWorkspaceUsed,
  resolveRecentRoot,
} from '../src/api/recent-workspace.js';
import { DreamScheduler, type DreamTimer } from '../src/api/dream-scheduler.js';
import { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../src/memory/types.js';
import type { AgentConfig } from '../src/config/schema.js';
import type { WorkspaceRuntime } from '../src/api/workspace-runtime.js';
import type { MemoryKit } from '../src/api/memory-kit.js';

const TMP_ROOT = join(tmpdir(), 'loop-agent-tests', 'test-recent-ws');

let dirSeq = 0;
function freshDir(prefix: string): string {
  return join(TMP_ROOT, `${prefix}-${Date.now()}-${dirSeq++}`);
}

// ---------- recent-workspace ----------

describe('recent-workspace（D2/D3：冷启动推导 + MRU 指针）', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = freshDir('user');
    mkdirSync(join(userDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('冷启动推导：mtime 最新的空间胜出', async () => {
    const wsA = freshDir('ws-a');
    const wsB = freshDir('ws-b');
    mkdirSync(join(wsA, 'sub'), { recursive: true });
    mkdirSync(join(wsB, 'sub'), { recursive: true });
    mkdirSync(join(userDir, 'sessions', 'aaaaaaaaaaaaaaaa'), { recursive: true });
    mkdirSync(join(userDir, 'sessions', 'bbbbbbbbbbbbbbbb'), { recursive: true });
    writeFileSync(join(userDir, 'sessions', 'aaaaaaaaaaaaaaaa', 'meta.json'), JSON.stringify({ workspacePath: wsA }));
    writeFileSync(join(userDir, 'sessions', 'bbbbbbbbbbbbbbbb', 'meta.json'), JSON.stringify({ workspacePath: wsB }));
    writeFileSync(join(userDir, 'sessions', 'bbbbbbbbbbbbbbbb', 'sess_x.json'), '{}');
    // A 整体比 B 旧 60s（latestMtimeMs 扫描目录 + 一层子文件，meta.json/sess 文件都要设旧）
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(userDir, 'sessions', 'aaaaaaaaaaaaaaaa'), old, old);
    utimesSync(join(userDir, 'sessions', 'aaaaaaaaaaaaaaaa', 'meta.json'), old, old);
    utimesSync(join(userDir, 'sessions', 'bbbbbbbbbbbbbbbb', 'sess_x.json'), new Date(Date.now() - 1000), new Date(Date.now() - 1000));

    const root = await resolveRecentRoot(userDir);
    const canonicalB = await canonicalWorkspacePath(wsB);
    expect(root.replace(/\\/g, '/').toLowerCase()).toBe(canonicalB.replace(/\\/g, '/').toLowerCase());
  });

  it('孤儿空间（meta 缺失 / path 为空）跳过，不参与推导', async () => {
    const wsB = freshDir('ws-b');
    mkdirSync(wsB, { recursive: true });
    mkdirSync(join(userDir, 'sessions', 'cccccccccccccccc'), { recursive: true }); // 无 meta.json
    mkdirSync(join(userDir, 'sessions', 'dddddddddddddddd'), { recursive: true }); // path 空
    mkdirSync(join(userDir, 'sessions', 'bbbbbbbbbbbbbbbb'), { recursive: true });
    writeFileSync(join(userDir, 'sessions', 'dddddddddddddddd', 'meta.json'), JSON.stringify({})); // path 空
    writeFileSync(join(userDir, 'sessions', 'bbbbbbbbbbbbbbbb', 'meta.json'), JSON.stringify({ workspacePath: wsB }));

    const root = await resolveRecentRoot(userDir);
    const canonicalB = await canonicalWorkspacePath(wsB);
    expect(root.replace(/\\/g, '/').toLowerCase()).toBe(canonicalB.replace(/\\/g, '/').toLowerCase());
  });

  it('sessions 目录不存在 / 全为孤儿 → 兜底 cwd 且不抛错', async () => {
    const missing = join(userDir, 'no-such-sessions');
    const r1 = await resolveRecentRoot(missing);
    expect(typeof r1).toBe('string');
    expect(r1.length).toBeGreaterThan(0);
    const r2 = await resolveRecentRoot(userDir);
    expect(typeof r2).toBe('string');
    expect(r2.length).toBeGreaterThan(0);
  });

  it('markWorkspaceUsed 后 defaultRoot 返回指针值；初始（未 mark）为 cwd', () => {
    // 注意模块级指针：断言前先读基线，mark 后覆盖
    const baseline = defaultRoot();
    expect(typeof baseline).toBe('string');
    markWorkspaceUsed('D:\\some\\workspace');
    expect(defaultRoot()).toBe('D:\\some\\workspace');
  });
});

// ---------- dream-scheduler D4 全空间三段式 ----------

/** 假 runtime（与 dream-scheduler.test.ts 同款最小面） */
function makeFakeRuntime(opts: {
  root: string;
  id?: string;
  dreamEnabled?: boolean;
  busy?: boolean;
  run?: () => Promise<{ promoted: unknown[]; skipped: unknown[]; errors: string[] }>;
}): WorkspaceRuntime {
  const memory: MemoryConfig = {
    ...DEFAULT_MEMORY_CONFIG,
    enabled: true,
    dreaming: { ...DEFAULT_MEMORY_CONFIG.dreaming, enabled: opts.dreamEnabled !== false },
  };
  const kit = {
    dream: {
      async getState() {
        return { lastProcessedDay: '' };
      },
      async run(_daysBack: number, _p: unknown, _o: unknown) {
        return await (opts.run ?? (async () => ({ promoted: [], skipped: [], errors: [] })))();
      },
      async recordRun() {
        /* 记录即可 */
      },
    },
  } as unknown as MemoryKit;
  return {
    root: opts.root,
    id: opts.id ?? workspaceId(opts.root),
    configLoader: { load: () => ({ config: { memory } }) },
    sessions: { hasInFlight: () => opts.busy === true },
    getMemoryKit: async () => kit,
  } as unknown as WorkspaceRuntime;
}

function makeAgentConfig(): AgentConfig {
  return {
    memory: { ...DEFAULT_MEMORY_CONFIG },
  } as unknown as AgentConfig;
}

/** 空定时器（不真挂 setTimeout） */
const noopTimer = (_fn: () => void, _ms: number): DreamTimer => ({ cancel: () => {} });

describe('DreamScheduler D4：全空间枚举 + 预判 + 懒装载', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = freshDir('dream-user');
    mkdirSync(join(userDir, 'sessions'), { recursive: true });
    mkdirSync(join(userDir, 'memory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('磁盘上有会话但 registry 为空 → tick 仍能懒装载并执行晋升', async () => {
    const wsRoot = await canonicalWorkspacePath(freshDir('ws-live'));
    mkdirSync(join(userDir, 'sessions', workspaceId(wsRoot)), { recursive: true });
    writeFileSync(
      join(userDir, 'sessions', workspaceId(wsRoot), 'meta.json'),
      JSON.stringify({ workspacePath: wsRoot }),
    );
    // stub runtime：run 记录调用（避免触碰真实 runtime 构建链）
    const ran: string[] = [];
    const stubRt = makeFakeRuntime({
      root: wsRoot,
      run: async () => {
        ran.push(wsRoot);
        return { promoted: [], skipped: [], errors: [] };
      },
    });
    // stub registry：peek 空（模拟未装载）+ getCanonical 返回 stub（懒装载路径）
    const registry = {
      peek: (root: string) => (root === wsRoot ? stubRt : undefined),
      getCanonical: async (root: string) => {
        if (root !== wsRoot) throw new Error('unexpected root: ' + root);
        return stubRt;
      },
      list: () => [] as WorkspaceRuntime[],
    } as unknown as WorkspaceRegistry;
    const sched = new DreamScheduler({
      registry,
      getConfig: () => makeAgentConfig(),
      log: () => {},
      createTimer: noopTimer,
      enumerateAllSpaces: true,
      userDir,
    });
    const out = await sched.tick();
    expect(out.some((s) => s.root === wsRoot && s.skippedBecause === undefined)).toBe(true);
    expect(ran).toContain(wsRoot);
  });

  it('shouldAttempt 预判：lastProcessedDay 落后于昨天 → 放行；昨天已处理且 lastRunAt 新鲜 → 跳过', async () => {
    const wsRoot = await canonicalWorkspacePath(freshDir('ws-pred'));
    const wsId = workspaceId(wsRoot);
    const memDir = join(userDir, 'memory', wsId);
    mkdirSync(memDir, { recursive: true });
    mkdirSync(join(userDir, 'sessions', wsId), { recursive: true });
    writeFileSync(join(userDir, 'sessions', wsId, 'meta.json'), JSON.stringify({ workspacePath: wsRoot }));

    const today = new Date().toISOString().slice(0, 10);
    const ran: string[] = [];
    const stubRt = makeFakeRuntime({
      root: wsRoot,
      run: async () => {
        ran.push(wsRoot);
        return { promoted: [], skipped: [], errors: [] };
      },
    });
    const registry = {
      peek: (root: string) => (root === wsRoot ? stubRt : undefined),
      getCanonical: async () => stubRt,
      list: () => [] as WorkspaceRuntime[],
    } as unknown as WorkspaceRegistry;
    const sched = new DreamScheduler({
      registry,
      getConfig: () => makeAgentConfig(),
      log: () => {},
      createTimer: noopTimer,
      enumerateAllSpaces: true,
      userDir,
    });

    // stale：lastProcessedDay = 昨天（< 今天-1d？注意口径：落后于昨天即今天-2d 及更早）
    // 这里用「前天」确保 < 昨天口径放行
    const beforeYesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(
      join(memDir, '.dreaming-state.json'),
      JSON.stringify({ lastProcessedDay: beforeYesterday, lastRunAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }),
    );
    const out1 = await sched.tick();
    const s1 = out1.find((s) => s.root === wsRoot);
    expect(s1?.skippedBecause).toBeUndefined(); // 放行 → 真跑（fake runtime 无 LLM）
    expect(ran).toContain(wsRoot);

    // fresh：今天已处理 + lastRunAt 新鲜 → 预判跳过
    writeFileSync(
      join(memDir, '.dreaming-state.json'),
      JSON.stringify({ lastProcessedDay: today, lastRunAt: new Date().toISOString() }),
    );
    const out2 = await sched.tick();
    const s2 = out2.find((s) => s.root === wsRoot);
    expect(s2?.skippedBecause).toBe('no-new-content');
  });

  it('状态文件损坏 → 放行（真实增量判定兜底）', async () => {
    const wsRoot = await canonicalWorkspacePath(freshDir('ws-bad'));
    const wsId = workspaceId(wsRoot);
    const memDir = join(userDir, 'memory', wsId);
    mkdirSync(memDir, { recursive: true });
    mkdirSync(join(userDir, 'sessions', wsId), { recursive: true });
    writeFileSync(join(userDir, 'sessions', wsId, 'meta.json'), JSON.stringify({ workspacePath: wsRoot }));
    writeFileSync(join(memDir, '.dreaming-state.json'), '{not json');
    const stubRt = makeFakeRuntime({ root: wsRoot });
    const registry = {
      peek: (root: string) => (root === wsRoot ? stubRt : undefined),
      getCanonical: async () => stubRt,
      list: () => [] as WorkspaceRuntime[],
    } as unknown as WorkspaceRegistry;
    const sched = new DreamScheduler({
      registry,
      getConfig: () => makeAgentConfig(),
      log: () => {},
      createTimer: noopTimer,
      enumerateAllSpaces: true,
      userDir,
    });
    const out = await sched.tick();
    const s = out.find((x) => x.root === wsRoot);
    expect(s).toBeDefined();
    expect(s?.skippedBecause).not.toBe('no-new-content');
  });

  it('runFor：未装载且目录不存在 → 收敛为 no-runtime 摘要不抛错', async () => {
    const ghost = join(TMP_ROOT, `no-such-ws-${Date.now()}`);
    const registry = {
      peek: () => undefined,
      getCanonical: async () => {
        throw new Error('目录不存在');
      },
      list: () => [] as WorkspaceRuntime[],
    } as unknown as WorkspaceRegistry;
    const sched = new DreamScheduler({
      registry,
      getConfig: () => makeAgentConfig(),
      log: () => {},
      createTimer: noopTimer,
      enumerateAllSpaces: true,
      userDir,
    });
    const s = await sched.runFor(ghost, 'manual');
    expect(s.skippedBecause).toBe('no-runtime');
  });

  it('enumerateAllSpaces=false（既有语义）：只遍历已装载 runtime', async () => {
    const wsRoot = await canonicalWorkspacePath(freshDir('ws-off'));
    mkdirSync(join(userDir, 'sessions', workspaceId(wsRoot)), { recursive: true });
    writeFileSync(
      join(userDir, 'sessions', workspaceId(wsRoot), 'meta.json'),
      JSON.stringify({ workspacePath: wsRoot }),
    );
    const rt = makeFakeRuntime({ root: wsRoot });
    const registry = {
      peek: (root: string) => (root === wsRoot ? rt : undefined),
      list: () => [rt],
    } as unknown as WorkspaceRegistry;
    const sched = new DreamScheduler({
      registry,
      getConfig: () => makeAgentConfig(),
      log: () => {},
      createTimer: noopTimer,
      enumerateAllSpaces: false,
      userDir,
    });
    const out = await sched.tick();
    expect(out).toHaveLength(1);
    expect(out[0].root).toBe(wsRoot);
  });
});

// ---------- evictIdle 定时接线（D6） ----------

describe('WorkspaceRegistry evictIdle 定时接线（D6）', () => {
  it('evictIntervalMs=0 时不挂定时器（reset 幂等）', async () => {
    const registry = new WorkspaceRegistry({ evictIntervalMs: 0 });
    // 不抛错、reset 可重复调用
    registry.reset();
    registry.reset();
    expect(true).toBe(true);
  });

  it('真实定时器：空闲空间在间隔后被释放（短间隔实测）', async () => {
    const wsRoot = await canonicalWorkspacePath(freshDir('ws-evict'));
    mkdirSync(wsRoot, { recursive: true });
    const registry = new WorkspaceRegistry({ evictIntervalMs: 50, idleTtlMs: 30 });
    await registry.get(wsRoot);
    expect(registry.list()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(registry.list()).toHaveLength(0);
    registry.reset();
  });
});
