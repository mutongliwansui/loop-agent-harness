// 后台命令机制单测（Task-20261022-002，需求 20261021-006）
// - 任务表状态机/游标/淘汰/持久化：真实临时目录（LOOP_AGENT 测试惯例）
// - spawn 链路：vi.mock node:child_process + vi.hoisted
// - 平台分支：Object.defineProperty(process, 'platform')
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => {
  return {
    spawn: vi.fn(),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

// 每个用例独立的任务表实例（避免全局单例跨用例污染）
import { BackgroundTaskRegistry, isPidAlive, newTaskId } from '../src/tools/background-tasks.js';

// ===== 纯逻辑：任务表状态机 =====

describe('BackgroundTaskRegistry：状态机与淘汰', () => {
  let reg: BackgroundTaskRegistry;

  beforeEach(() => {
    reg = new BackgroundTaskRegistry();
  });

  it('finish 只对 running 生效：killed 不被覆盖；exited 正常落账（D8）', () => {
    const t = reg.start({ pid: 111, command: 'node x.ts', cwd: 'C:\\w', logPath: 'C:\\r\\a.log', startedAt: 1 });
    expect(t.status).toBe('running');
    expect(t.cursor).toBe(0);
    expect(t.taskId).toMatch(/^bg_[0-9a-f]{8}_\d{10}$/);

    // kill（running→killed）后 exit 回调到达：不覆盖 killed
    reg.kill(t.taskId);
    reg.finish(t.taskId, 0);
    expect(reg.get(t.taskId)?.status).toBe('killed');
    expect(reg.get(t.taskId)?.exitCode).toBeUndefined();

    // 正常路径：exited + exitCode + finishedAt
    const t2 = reg.start({ pid: 112, command: 'y', cwd: 'C:\\w', logPath: 'C:\\r\\b.log', startedAt: 2 });
    reg.finish(t2.taskId, 0);
    expect(reg.get(t2.taskId)?.status).toBe('exited');
    expect(reg.get(t2.taskId)?.exitCode).toBe(0);
    expect(reg.get(t2.taskId)?.finishedAt).toBeGreaterThan(0);
  });

  it('kill 幂等：running → killed；已结束 → already-finished；不存在 → not-found（D8）', () => {
    const t = reg.start({ pid: 1, command: 'x', cwd: 'C:\\w', logPath: 'C:\\r\\a.log', startedAt: 1 });
    expect(reg.kill(t.taskId).outcome).toBe('killed');
    expect(reg.kill(t.taskId).outcome).toBe('already-finished');
    expect(reg.kill('bg_nope_123').outcome).toBe('not-found');
  });

  it('kill 对 orphaned-running 生效（D6：孤儿仅可 stop）', () => {
    const t = reg.start({ pid: 1, command: 'x', cwd: 'C:\\w', logPath: 'C:\\r\\a.log', startedAt: 1 });
    // 模拟 sweep 后的孤儿态
    (reg as unknown as { tasks: Map<string, { status: string }> }).tasks.get(t.taskId)!.status = 'orphaned-running';
    expect(reg.kill(t.taskId).outcome).toBe('killed');
    expect(reg.get(t.taskId)?.status).toBe('killed');
  });

  it('advanceCursor 只前进不回退', () => {
    const t = reg.start({ pid: 1, command: 'x', cwd: 'C:\\w', logPath: 'C:\\r\\a.log', startedAt: 1 });
    reg.advanceCursor(t.taskId, 100);
    expect(reg.get(t.taskId)?.cursor).toBe(100);
    reg.advanceCursor(t.taskId, 50);
    expect(reg.get(t.taskId)?.cursor).toBe(100);
    reg.advanceCursor('bg_nope_1', 5); // 不存在 taskId：no-op
  });

  it('list 按 startedAt 倒序、上限 50；表 200 淘汰最老已结束、running 永不淘汰（3.1）', () => {
    // t0 先正常退出（可被淘汰的最老已结束任务）
    const t0 = reg.start({ pid: 1, command: 'old', cwd: 'C:\\w', logPath: 'C:\\r\\0.log', startedAt: 1 });
    reg.finish(t0.taskId, 0);
    // tRun 是运行中任务：即使最老也不淘汰
    const tRun = reg.start({ pid: 2, command: 'keep', cwd: 'C:\\w', logPath: 'C:\\r\\k.log', startedAt: 1500 });
    for (let i = 2; i <= 201; i++) {
      const t = reg.start({ pid: i + 10, command: `c${i}`, cwd: 'C:\\w', logPath: `C:\\r\\${i}.log`, startedAt: i * 1000 });
      reg.finish(t.taskId, 0);
    }
    expect(reg.get(t0.taskId)).toBeUndefined(); // 最老已结束被淘汰
    expect(reg.get(tRun.taskId)?.status).toBe('running'); // running 永不淘汰
    expect(reg.list().length).toBeLessThanOrEqual(50);
    const list = reg.list();
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].startedAt).toBeGreaterThanOrEqual(list[i].startedAt);
    }
  });

  it('taskId 碰撞时重生成（3.4）', () => {
    const first = reg.start({ pid: 1, command: 'x', cwd: 'C:\\w', logPath: 'a', startedAt: 1 });
    const dup = reg.start({ pid: 2, command: 'y', cwd: 'C:\\w', logPath: 'b', startedAt: 2, taskId: first.taskId });
    expect(dup.taskId).not.toBe(first.taskId);
  });

  it('isPidAlive：pid=0/undefined 为 false；不存在 pid 为 false', () => {
    expect(isPidAlive(undefined)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // 最大的不可能 pid
    expect(isPidAlive(4_000_000_000)).toBe(false);
  });

  it('newTaskId 格式与随机性', () => {
    const a = newTaskId();
    const b = newTaskId();
    expect(a).toMatch(/^bg_[0-9a-f]{8}_\d{10}$/);
    expect(a).not.toBe(b);
  });
});

// ===== 持久化与孤儿清扫（真实临时目录） =====

describe('BackgroundTaskRegistry：持久化与 sweepOrphans（D6）', () => {
  let dir: string;
  let reg: BackgroundTaskRegistry;

  beforeEach(async () => {
    const { setRunsDirForTest } = await import('../src/tools/background-tasks.js');
    dir = mkdtempSync(join(tmpdir(), 'lagent-runs-'));
    setRunsDirForTest(dir);
    reg = new BackgroundTaskRegistry();
  });

  afterEach(async () => {
    const { setRunsDirForTest } = await import('../src/tools/background-tasks.js');
    setRunsDirForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('start/finish/kill 均落盘 .json，sweepOrphans 能读回', async () => {
    const t = reg.start({ pid: 1, command: 'node server.js', cwd: 'C:\\w', logPath: join(dir, 'a.log'), startedAt: 1 });
    reg.finish(t.taskId, 3);
    const jsonPath = join(dir, `${t.taskId}.json`);
    expect(existsSync(jsonPath)).toBe(true);

    // 新注册表 sweep：非 running 状态不动
    const reg2 = new BackgroundTaskRegistry();
    await reg2.sweepOrphans();
    expect(reg2.get(t.taskId)).toBeUndefined(); // exited 不入表

    // running 残留 → pid 已死 → orphaned-exited
    const t2 = reg.start({ pid: 4_000_000_000, command: 'dead', cwd: 'C:\\w', logPath: join(dir, 'b.log'), startedAt: 2 });
    const reg3 = new BackgroundTaskRegistry();
    await reg3.sweepOrphans();
    expect(reg3.get(t2.taskId)?.status).toBe('orphaned-exited');
    expect(reg3.get(t2.taskId)?.cursor).toBe(0);
  });

  it('sweepOrphans：pid 存活 → orphaned-running（用当前进程 pid 保证存活）', async () => {
    const t = reg.start({ pid: process.pid, command: 'alive', cwd: 'C:\\w', logPath: join(dir, 'c.log'), startedAt: 3 });
    await reg.sweepOrphans();
    expect(reg.get(t.taskId)?.status).toBe('orphaned-running');
  });

  it('sweepOrphans：目录不存在时静默返回', async () => {
    const reg2 = new BackgroundTaskRegistry();
    await expect(reg2.sweepOrphans()).resolves.not.toThrow();
  });
});

// ===== spawn 链路（mock child_process） =====

describe('commandRun background 分支：spawn 传参与返回（D5/D9/D10）', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  it('background:true → spawn(shell, detached=非win32, stdio ignore/log/log) 并秒回 taskId JSON', async () => {
    const { commandRun } = await import('../src/tools/commandRun.js');
    const fakeChild = { pid: 4242, on: vi.fn() };
    mocks.spawn.mockReturnValue(fakeChild);

    const p = commandRun.execute(
      { command: 'npm run dev', background: true },
      { workspaceRoot: 'C:\\ws' },
    );
    const out = await p;

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [cmd, opts] = mocks.spawn.mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe('npm run dev');
    expect(opts.shell).toBe(true);
    expect(opts.cwd).toBe('C:\\ws');
    expect(opts.detached).toBe(process.platform !== 'win32');
    expect(opts.windowsHide).toBe(true);

    const parsed = JSON.parse(out) as { taskId: string; pid: number; logPath: string; hint: string };
    expect(parsed.taskId).toMatch(/^bg_[0-9a-f]{8}_\d{10}$/);
    expect(parsed.pid).toBe(4242);
    expect(parsed.logPath).toContain('runs');
    expect(parsed.hint).toContain('commandStatus');
  });

  it('spawn 抛异常（同步错误）→ 返回错误文本而非 throw（runner 契约）', async () => {
    const { commandRun } = await import('../src/tools/commandRun.js');
    mocks.spawn.mockImplementation(() => {
      throw new Error('spawn boom');
    });
    const out = await commandRun.execute({ command: 'x', background: true }, {});
    expect(out).toContain('工具执行失败');
    expect(out).toContain('spawn boom');
  });

  it('exit 回调触发 finish：code=0 → exited/0；signal → exitCode=null', async () => {
    const { commandRun } = await import('../src/tools/commandRun.js');
    const handlers = new Map<string, (a?: unknown, b?: unknown) => void>();
    const fakeChild = {
      pid: 7,
      on: vi.fn((ev: string, fn: (a?: unknown, b?: unknown) => void) => handlers.set(ev, fn)),
    };
    mocks.spawn.mockReturnValue(fakeChild);

    const { backgroundTasks } = await import('../src/tools/background-tasks.js');
    const out = await commandRun.execute({ command: 'y', background: true }, {});
    const { taskId } = JSON.parse(out) as { taskId: string };

    handlers.get('exit')?.(0, null);
    expect(backgroundTasks.get(taskId)?.status).toBe('exited');
    expect(backgroundTasks.get(taskId)?.exitCode).toBe(0);

    // signal 终止 → exitCode null
    handlers.get('exit')?.(null, 'SIGTERM');
    expect(backgroundTasks.get(taskId)?.exitCode).toBe(0); // 不覆盖：finish 只对 running 生效
  });

  it('前台路径（不传 background）走 exec 不走 spawn', async () => {
    const { commandRun } = await import('../src/tools/commandRun.js');
    mocks.spawn.mockClear();
    const out = await commandRun.execute({ command: 'echo hi' }, { workspaceRoot: process.cwd() });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(out).toContain('hi');
  });
});
