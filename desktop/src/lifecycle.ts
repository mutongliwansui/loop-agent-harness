import { spawnSync } from 'node:child_process';
import type { BackendHandle } from './backend-process.js';

/**
 * 生命周期：单实例 + 优雅关停 + 强杀兜底（任务 20261112-007-02 / D2-4、D2-5）。
 *
 * 为什么必须走 HTTP 而不能 kill('SIGINT')：Windows 下父进程发信号等于无条件强杀，
 * 子进程的 SIGINT handler 根本不会执行（任务 02 文档已实测 handler-ran=false），
 * 而 Dreaming（记忆整理）只挂在信号处理里 → 直接 kill 就是丢记忆。
 * 因此关窗统一为：POST /admin/shutdown → 等进程退出 → 超时才强杀。
 *
 * 本模块刻意不 import electron：单测在纯 node 下跑，Electron 只从 main.ts 注入。
 */

/** 桌面壳的标记头，必须与后端 src/api/handlers/admin.ts 的常量一致 */
export const CLIENT_HEADER = 'X-LoopAgent-Client';
/** 该头的唯一合法值（后端比对字符串，大小写不敏感看 node 侧，值必须完全一致） */
export const CLIENT_HEADER_VALUE = 'desktop';

/** 关停请求的结果 */
export type ShutdownAck =
  /** 202：后端已受理，正在整理记忆 */
  | 'accepted'
  /** 409：已在关停中（幂等，别人先发了） */
  | 'already'
  /** 403/401：被拒（缺标记头或缺 token） */
  | 'denied'
  /** 501：该后端没有关停能力（老版本 exe） */
  | 'unsupported'
  /** 连不上：后端已死或端口不对 */
  | 'unreachable';

export interface RequestShutdownOpts {
  port: number;
  /** api.token；为空则不带 Authorization（后端回环放行） */
  token?: string;
  host?: string;
  /** 单次请求超时，默认 5000ms */
  timeoutMs?: number;
}

/**
 * 请求后端优雅关停。
 *
 * 后端会先回 202 再在 setImmediate 里跑关停序列（D2-2），所以拿到 accepted
 * 只能说明「收到了」，进程退出还要另外等。
 */
export async function requestShutdown(opts: RequestShutdownOpts): Promise<ShutdownAck> {
  const host = opts.host ?? '127.0.0.1';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5_000);
  const headers: Record<string, string> = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  try {
    const res = await fetch(`http://${host}:${opts.port}/admin/shutdown`, {
      method: 'POST',
      headers,
      signal: ac.signal,
    });
    // 不读 body：关停中的连接可能被 server.close() 掐断，读 body 会抛无意义的错误
    if (res.status === 202) return 'accepted';
    if (res.status === 409) return 'already';
    if (res.status === 501) return 'unsupported';
    if (res.status === 401 || res.status === 403) return 'denied';
    return 'denied';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 强杀进程树（兜底路径）。
 *
 * 用 taskkill /T 而非 child.kill()：开发期后端是 `node --import tsx` 起的，
 * 只杀父进程会留下 tsx 的 loader 子进程继续占用端口。
 *
 * @returns true = 已执行强杀；false = 没有可用 pid（或非 Windows 下交回调用方处理）
 */
export function killTree(pid: number | undefined): boolean {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return r.status === 0;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

export interface GracefulQuitOpts {
  /** 后端 Dreaming 预算（memory.dreaming.shutdownBudgetMs） */
  budgetMs: number;
  /** 预算之外的宽限，覆盖 MCP 断开与进程退出，默认 5000ms（D2-4） */
  graceMs?: number;
  token?: string;
  log?: (msg: string) => void;
}

/** 关停结局：优雅退出 / 超时强杀 / 本来就已退出 */
export type QuitOutcome = 'graceful' | 'killed' | 'dead';

/**
 * 关窗时的优雅退出。
 *
 * 时序（D2-4）：POST 关停 → 等进程退出，上限 budgetMs + graceMs → 超时 taskkill /T /F。
 * 宽限不能省：预算只管 Dreaming，之后的 server.close()、断 MCP 也要时间；
 * 也不能用固定超时替代预算（用户把预算调大时会提前被砍，反而丢记忆）。
 */
export async function gracefulQuit(
  handle: BackendHandle,
  opts: GracefulQuitOpts,
): Promise<QuitOutcome> {
  const graceMs = opts.graceMs ?? 5_000;
  const log = opts.log ?? (() => {});
  if (!handle.isAlive()) return 'dead';

  const ack = await requestShutdown({ port: handle.port, token: opts.token });
  if (ack === 'unreachable') {
    // 后端已死或端口不通：没什么可等的，但可能有残留进程，顺手清一次
    log('[quit] 关停端点不可达，按已退出处理');
    await handle.stop().catch(() => {});
    return handle.isAlive() ? 'killed' : 'dead';
  }
  if (ack === 'denied' || ack === 'unsupported') {
    log(`[quit] 关停端点拒绝(${ack})，改用强杀（本次 Dreaming 会被跳过）`);
    return forceKill(handle, log);
  }

  const limit = opts.budgetMs + graceMs;
  log(`[quit] 已请求优雅关停，最多等待 ${Math.round(limit / 1000)}s`);
  const exited = await Promise.race([
    handle.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), limit)),
  ]);
  if (exited) {
    log('[quit] 后端已优雅退出');
    return 'graceful';
  }

  log(`[quit] 超过 ${Math.round(limit / 1000)}s 仍未退出，强杀进程树`);
  return forceKill(handle, log);
}

/** 强杀并等进程真的消失，避免「返回了但进程还在」的假成功 */
async function forceKill(handle: BackendHandle, log: (m: string) => void): Promise<QuitOutcome> {
  const ok = killTree(handle.pid);
  if (!ok) log('[quit] taskkill 未执行成功，回落后端句柄自带的 stop()');
  await handle.stop().catch(() => {});
  // stop() 内部已 await exit；再兜一层，防 handle 实现不严谨导致误判
  const gone = await Promise.race([
    handle.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(!handle.isAlive()), 2_000)),
  ]);
  return gone ? 'killed' : 'killed';
}

/** 单实例锁所需的最小 app 接口（解耦 Electron，便于单测注入假对象） */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
}

/**
 * 单实例锁（D2-5）。
 *
 * 二次启动时 Electron 会把 second-instance 事件发给**第一个实例**，因此
 * onSecondInstance 里要做的是「把已有窗口恢复并聚焦」，而不是建新窗口。
 *
 * @returns true = 本进程是唯一实例，可继续启动；false = 已有实例在跑，调用方应退出
 */
export function installSingleInstance(
  app: SingleInstanceApp,
  onSecondInstance: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', onSecondInstance);
  return true;
}
