/**
 * 终端会话表单测（Task-20261027-001 / D8 / D10）
 *
 * PTY 由 vi.mock 替身提供：本文件的关注点是「会话管理策略」而非真实进程，
 * 这样并发上限、空闲回收、审计、拒绝名单都能在毫秒级确定性验证。
 * 真实 PTY 的联通性由 tests/integration/terminal-pty.test.ts 覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShellInfo } from '../src/terminal/shells.js';

/** 替身会话：记录写入内容与 kill 调用 */
class FakeSession {
  static seq = 0;
  readonly id: string;
  readonly shell: ShellInfo;
  readonly pid: number;
  written: string[] = [];
  killed = false;
  private outputCbs = new Set<(d: string) => void>();
  private exitCbs = new Set<(c: number) => void>();

  constructor(shell: ShellInfo) {
    FakeSession.seq += 1;
    this.id = `fake_${FakeSession.seq}`;
    this.shell = shell;
    this.pid = 1000 + FakeSession.seq;
  }
  onOutput(cb: (d: string) => void): void {
    this.outputCbs.add(cb);
  }
  offOutput(cb: (d: string) => void): void {
    this.outputCbs.delete(cb);
  }
  onExit(cb: (c: number) => void): void {
    this.exitCbs.add(cb);
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(): void {
    /* noop */
  }
  replay(): string {
    return '';
  }
  kill(): void {
    this.killed = true;
  }
  /** 测试辅助：模拟输出 */
  emit(d: string): void {
    for (const cb of this.outputCbs) cb(d);
  }
}

vi.mock('../src/terminal/pty-session.js', () => ({
  PtyUnavailableError: class extends Error {},
  createPtySession: (opts: { shell: ShellInfo }) => new FakeSession(opts.shell),
}));

const { TerminalManager, TooManySessionsError, REATTACH_GRACE_MS } = await import(
  '../src/terminal/manager.js'
);

const SHELL: ShellInfo = { id: 'cmd', label: '命令提示符', file: 'cmd.exe', args: [] };
const openOpts = { shell: SHELL, cwd: 'C:\\tmp', cols: 80, rows: 24 };

let mgr: InstanceType<typeof TerminalManager>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  mgr?.disposeAll();
  vi.useRealTimers();
});

describe('并发上限', () => {
  it('达到 maxSessions 后拒绝新建并抛 too_many', () => {
    mgr = new TerminalManager({ maxSessions: 2, idleMs: 60_000 });
    mgr.open(openOpts);
    mgr.open(openOpts);
    expect(mgr.size).toBe(2);
    expect(() => mgr.open(openOpts)).toThrow(TooManySessionsError);
    // 拒绝时不应把半成品计入表内
    expect(mgr.size).toBe(2);
  });

  it('关闭一个后可再开（名额回收）', () => {
    mgr = new TerminalManager({ maxSessions: 1, idleMs: 60_000 });
    const s = mgr.open(openOpts);
    expect(() => mgr.open(openOpts)).toThrow(TooManySessionsError);
    mgr.close(s.id);
    expect(mgr.size).toBe(0);
    expect(() => mgr.open(openOpts)).not.toThrow();
  });
});

/**
 * 回归：反复开关终端后「并发终端数已达上限，界面上却一个终端都没有」。
 *
 * 成因：前端关页签时只断 WS 不发 close，服务端会话 detach 后仍占名额，
 * 要等 60s 宽限期 + 30s 一次的 sweep 才回收；用户几秒内开关 4 次即占满。
 * 修复：前端关页签改发 close（主修），服务端 open() 前回收/顶掉 detached（兜底）。
 */
describe('detached 会话占用名额（回归：假性达上限）', () => {
  it('活跃会话达上限时仍然拒绝，绝不抢活跃会话', () => {
    mgr = new TerminalManager({ maxSessions: 2, idleMs: 60_000 });
    const a = mgr.open(openOpts);
    const b = mgr.open(openOpts);
    expect(() => mgr.open(openOpts)).toThrow(TooManySessionsError);
    // 两个活跃会话都必须还在
    expect(mgr.has(a.id)).toBe(true);
    expect(mgr.has(b.id)).toBe(true);
  });

  it('名额被 detached 会话占满时，顶掉最老的 detached 而不是报错', () => {
    mgr = new TerminalManager({ maxSessions: 2, idleMs: 10 * 60_000 });
    const a = mgr.open(openOpts);
    const b = mgr.open(openOpts);
    // 模拟「前端只断开、没发 close」：会话转入宽限期但仍占名额
    mgr.detach(a.id);
    mgr.detach(b.id);
    expect(mgr.size).toBe(2);

    const c = mgr.open(openOpts); // 修复前：抛 TooManySessionsError
    expect(mgr.size).toBe(2);
    expect(mgr.has(a.id)).toBe(false); // 最老的被顶掉
    expect(mgr.has(b.id)).toBe(true);
    expect(mgr.has(c.id)).toBe(true);
    // 被顶掉的会话必须真的 kill，否则 conhost 泄漏
    expect((a as unknown as FakeSession).killed).toBe(true);
  });

  it('活跃会话与 detached 混合：只顶 detached，活跃的不动', () => {
    mgr = new TerminalManager({ maxSessions: 2, idleMs: 10 * 60_000 });
    const live = mgr.open(openOpts);
    const dead = mgr.open(openOpts);
    mgr.detach(dead.id);

    const c = mgr.open(openOpts);
    expect(mgr.has(live.id)).toBe(true);
    expect(mgr.has(dead.id)).toBe(false);
    expect(mgr.size).toBe(2);
    expect(mgr.has(c.id)).toBe(true);
  });

  it('open 前会回收已过宽限期的 detached（不依赖 sweep 定时器）', () => {
    mgr = new TerminalManager({ maxSessions: 1, idleMs: 10 * 60_000 });
    const a = mgr.open(openOpts);
    mgr.detach(a.id);
    // 只改系统时间、不推进定时器：sweep 不会跑，验证 open() 内部的主动清理
    vi.setSystemTime(Date.now() + REATTACH_GRACE_MS + 1000);
    expect(mgr.size).toBe(1);
    expect(() => mgr.open(openOpts)).not.toThrow(); // 修复前：抛 TooManySessionsError
    expect(mgr.has(a.id)).toBe(false);
  });
});

describe('空闲回收', () => {
  it('超过 idleMs 空闲的会话被回收并 kill', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 1000 });
    const s = mgr.open(openOpts) as unknown as FakeSession;
    mgr.sweep(Date.now() + 1500);
    expect(mgr.size).toBe(0);
    expect(s.killed).toBe(true);
  });

  it('未到 idleMs 的会话保留', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 1000 });
    mgr.open(openOpts);
    mgr.sweep(Date.now() + 500);
    expect(mgr.size).toBe(1);
  });

  it('touch 可刷新活跃时间从而延长存活', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 1000 });
    const s = mgr.open(openOpts);
    vi.advanceTimersByTime(800);
    mgr.touch(s.id);
    mgr.sweep(Date.now());
    expect(mgr.size).toBe(1);
  });
});

describe('断连宽限（重连复用）', () => {
  it('detach 后宽限期内不被回收，便于重连回放', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 10 * 60_000 });
    const s = mgr.open(openOpts);
    mgr.detach(s.id);
    // 宽限期内
    mgr.sweep(Date.now() + 1000);
    expect(mgr.size).toBe(1);
    // 仍可重新 attach 复用同一会话
    expect(mgr.attach(s.id)?.id).toBe(s.id);
  });

  it('超过宽限期后回收', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 10 * 60_000 });
    const s = mgr.open(openOpts);
    mgr.detach(s.id);
    mgr.sweep(Date.now() + REATTACH_GRACE_MS + 1000);
    expect(mgr.size).toBe(0);
  });

  it('attach 不存在的会话返回 undefined', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 1000 });
    expect(mgr.attach('nope')).toBeUndefined();
  });
});

describe('命令审计与拒绝名单（服务端生效，D10）', () => {
  it('回车提交的命令被审计记录', () => {
    const audit = vi.fn();
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 60_000, audit });
    const s = mgr.open(openOpts) as unknown as FakeSession;
    mgr.input(s.id, 'dir\r');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'dir', denied: false, sessionId: s.id }),
    );
  });

  it('命中拒绝名单时不写入 PTY，且审计标记 denied', () => {
    const audit = vi.fn();
    mgr = new TerminalManager({
      maxSessions: 4,
      idleMs: 60_000,
      deny: ['shutdown'],
      audit,
    });
    const s = mgr.open(openOpts) as unknown as FakeSession;
    const accepted = mgr.input(s.id, 'shutdown /s\r');
    expect(accepted).toBe(false);
    expect(s.written).toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ denied: true }));
  });

  it('拒绝名单大小写不敏感', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 60_000, deny: ['format'] });
    const s = mgr.open(openOpts) as unknown as FakeSession;
    expect(mgr.input(s.id, 'FORMAT C:\r')).toBe(false);
    expect(s.written).toEqual([]);
  });

  it('未命中名单的命令正常写入 PTY', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 60_000, deny: ['shutdown'] });
    const s = mgr.open(openOpts) as unknown as FakeSession;
    expect(mgr.input(s.id, 'dir\r')).toBe(true);
    expect(s.written).toEqual(['dir\r']);
  });

  it('退格键会从审计缓冲里回删字符', () => {
    const audit = vi.fn();
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 60_000, audit });
    const s = mgr.open(openOpts) as unknown as FakeSession;
    // 输入 "dix" 再退格成 "di"
    mgr.input(s.id, 'dix\x7f\r');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ command: 'di' }));
  });

  it('不存在的会话 input 返回 false 且不抛错', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 60_000 });
    expect(mgr.input('nope', 'dir\r')).toBe(false);
  });
});

describe('disposeAll', () => {
  it('清理全部会话并 kill', () => {
    mgr = new TerminalManager({ maxSessions: 4, idleMs: 60_000 });
    const a = mgr.open(openOpts) as unknown as FakeSession;
    const b = mgr.open(openOpts) as unknown as FakeSession;
    mgr.disposeAll();
    expect(mgr.size).toBe(0);
    expect(a.killed && b.killed).toBe(true);
  });
});
