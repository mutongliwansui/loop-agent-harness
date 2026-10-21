/**
 * commandRun 取消测试（Task-20261021-002-01 P1）
 *
 * 覆盖：
 * - 已 aborted 的 signal：立即收尾，不悬挂到超时
 * - 运行中 abort：回调被触发（进程被杀），Promise 收敛
 * - ctx.workspaceRoot 本期不被消费（2b 接口位，行为不变）
 */
import { describe, it, expect } from 'vitest';
import { commandRun } from '../src/tools/commandRun.js';

const isWin = process.platform === 'win32';

describe('commandRun 取消', () => {
  it('不传 ctx：行为与现状完全一致（快速命令正常返回）', async () => {
    const out = await commandRun.execute(
      { command: isWin ? 'echo hello' : 'echo hello' },
    );
    expect(out).toContain('hello');
  }, 15000);

  it('signal 已 aborted：快速收敛（不悬挂 30s 超时）', async () => {
    const c = new AbortController();
    c.abort();
    const p = commandRun.execute(
      { command: isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30' },
      { signal: c.signal },
    );
    // exec 在调用前 signal 已 aborted 时会立即回调（AbortError），Promise 应很快 resolve
    const res = await Promise.race([
      p,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('悬挂：3s 内未收敛')), 3000)),
    ]);
    expect(typeof res).toBe('string');
  }, 10000);

  it('运行中 abort：Promise 在 2s 内收敛（进程被杀，不等命令自然结束）', async () => {
    const c = new AbortController();
    const long = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
    const p = commandRun.execute({ command: long }, { signal: c.signal });
    // 等命令真正跑起来
    await new Promise((r) => setTimeout(r, 500));
    c.abort();
    const res = await Promise.race([
      p,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('悬挂：abort 后 2s 内未收敛')), 2000)),
    ]);
    // 收敛即可（exec 回调把 abort 错误汇编为 [exit=...] 文本，内容不敏感——
    // 该返回值在真实链路中会被 ToolRunner.raceAbort 的 reject 丢弃）
    expect(typeof res).toBe('string');
  }, 15000);

  it('ctx.workspaceRoot 传入不被消费（2b 接口位，不改变 cwd 语义）', async () => {
    const out = await commandRun.execute(
      { command: isWin ? 'echo x' : 'echo x' },
      { workspaceRoot: 'D:/definitely/not/used' },
    );
    expect(out).toContain('x');
  }, 15000);
});
