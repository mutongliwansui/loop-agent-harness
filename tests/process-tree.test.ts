/**
 * 进程树终止测试（Task-20261021-002-01 P1）
 *
 * 覆盖：
 * - 参数防御：pid 缺失/非法时 no-op 不抛错
 * - win32 分支：真实 taskkill（错误 pid 静默 + 冒烟杀真实子进程）
 * - posix 分支：负 pid 进程组 + 单 pid 退化（process.platform 调用时可替换，spy process.kill）
 *
 * 注：不使用 vi.doMock 动态重载模块（vitest 4 下会挂死 worker）；
 * process-tree.js 在每次调用时读取 process.platform，直接替换属性即可测平台分支。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { killProcessTree } from '../src/tools/process-tree.js';

const realPlatform = process.platform;

/** 替换 process.platform（vitest 4 无 vi.replaceProperty；该属性 configurable） */
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', {
    value: p, configurable: true, writable: false, enumerable: true,
  });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('killProcessTree 参数防御', () => {
  it('pid 缺失/0/负数：不抛错、不调用任何 kill', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    await expect(killProcessTree(undefined)).resolves.toBeUndefined();
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-5)).resolves.toBeUndefined();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('killProcessTree win32 分支（当前平台真实执行）', () => {
  it('错误 pid：taskkill 非零退出被静默吞掉，不抛出', async () => {
    // 仅在真实 Windows 上执行（CI/Linux 下平台判定不走此分支）
    if (realPlatform !== 'win32') return;
    await expect(killProcessTree(999_999_999)).resolves.toBeUndefined();
  });

  it('冒烟：杀长驻子进程后进程退出', async () => {
    if (realPlatform !== 'win32') return;
    const child = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' });
    // 等子进程起来；exit 监听必须先挂（taskkill 完成时子进程可能已退出，事后监听会错过事件）
    await new Promise((r) => setTimeout(r, 300));
    expect(child.pid).toBeDefined();
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      child.once('exit', () => { clearTimeout(t); resolve(true); });
      void killProcessTree(child.pid);
    });
    expect(exited).toBe(true);
  });
});

describe('killProcessTree posix 分支（mock platform + spy process.kill）', () => {
  it('优先负 pid 杀进程组，成功后不退化', async () => {
    setPlatform('linux');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    await killProcessTree(1234, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');
  });

  it('负 pid 失败（ESRCH 等）退化单 pid', async () => {
    setPlatform('linux');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number): boolean => {
      if (pid < 0) throw new Error('ESRCH');
      return true;
    }) as typeof process.kill);
    await killProcessTree(1234, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(1, -1234, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 1234, 'SIGTERM');
  });

  it('两级都失败（进程已退出）：静默不抛出', async () => {
    setPlatform('linux');
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
    }) as typeof process.kill);
    await expect(killProcessTree(1234)).resolves.toBeUndefined();
  });
});
