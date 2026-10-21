// 跨平台进程树终止（Task-20261021-002-01）
//
// 设计要点（对应任务文档 3.4 / D6 / D7）：
// - Windows：child.kill() 只能杀直接子进程，孙进程会残留（cmd.exe 包一层 shell），
//   必须用系统 taskkill /T（树） /F（强制）——execa/pnpm 同款做法；
//   Node 官方未内置 killTree（nodejs/node#64406 仍 open）。
// - POSIX：优先 process.kill(-pid) 杀整个进程组（要求 spawn 时 detached: true），
//   失败（非进程组长/已退出）退化单 pid。
// - 全部失败静默（D7）：取消路径的清理失败不应改变用户可见结果，
//   残留进程由系统/工具超时兜底，仅记 debug 日志便于诊断。
import { execFile } from 'node:child_process';
import { debug } from '../debug.js';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 尽力终止 pid 所在的进程树（失败静默）
 *
 * @param pid 目标进程 id；缺失/非法时为 no-op
 * @param signal POSIX 分支使用的信号，默认 SIGKILL
 */
export async function killProcessTree(
  pid?: number,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<void> {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      // /T 连同子进程、/F 强制终止；趁树完整时执行（先杀直接子进程会让后代孤儿化）
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch (e) {
      // 进程已退出等场景 taskkill 返回非零，属正常，静默
      debug.log(`taskkill 失败（pid=${pid}）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  // POSIX：优先负 pid 杀进程组（需 spawn 时 detached: true 才有独立进程组）
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已退出，静默
    }
  }
}
