import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import type { BackendTarget } from './backend-path.js';

/** 日志环形缓冲上限：只保留最近 8KB 供错误窗展示尾部 */
const TAIL_LIMIT = 8 * 1024;

export interface BackendHandle {
  pid: number | undefined;
  readonly port: number;
  /** 最近 8KB stdout+stderr 合并文本 */
  tail(): string;
  /** 进程退出（含主动 stop）时 resolve */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 是否仍在运行 */
  isAlive(): boolean;
  /** 停止后端。本任务为强杀；任务 02 改为先 POST /admin/shutdown */
  stop(): Promise<void>;
}

export interface StartBackendOpts {
  /** 后端工作目录，默认用户主目录（D1-8） */
  cwd?: string;
  /** 额外环境变量 */
  env?: Record<string, string>;
}

/** 简易环形日志缓冲：超出上限时丢弃最旧内容，始终保持可读的尾部 */
class TailBuffer {
  private chunks: string[] = [];
  private size = 0;

  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > TAIL_LIMIT && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
    }
    // 单个超大块也截断，避免一次输出把 buffer 撑爆
    if (this.chunks.length === 1 && this.size > TAIL_LIMIT) {
      const only = this.chunks[0];
      this.chunks[0] = only.slice(only.length - TAIL_LIMIT);
      this.size = this.chunks[0].length;
    }
  }

  text(): string {
    return this.chunks.join('');
  }
}

/**
 * 组装后端启动参数。
 *
 * `--web-root` 默认不传：最终安装布局（resources/loop-agent-core.exe）下不存在
 * webui/dist，前端由 SEA 内嵌资源提供（static.ts:210-215 三级兜底）。
 * 仅在显式需要时才传绝对路径（应急手段，见任务 01 D1-8 / 风险表）。
 */
export function buildBackendArgs(port: number, webRoot?: string): string[] {
  const args = ['--serve', `--port=${port}`];
  if (webRoot) args.push(`--web-root=${webRoot}`);
  return args;
}

/** 启动后端进程并返回句柄 */
export function startBackend(
  target: BackendTarget,
  port: number,
  opts: StartBackendOpts = {},
): BackendHandle {
  const cwd = opts.cwd ?? homedir();
  const buf = new TailBuffer();

  let child: ChildProcess;
  if (target.kind === 'exe') {
    child = spawn(target.exePath, buildBackendArgs(port), {
      cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    // 开发期回落 tsx：用 node + tsx 直接跑 TS 入口，免去每次 build:sea
    child = spawn(process.execPath, ['--import', 'tsx', target.entryPath, ...buildBackendArgs(port)], {
      cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  child.stdout?.on('data', (d: Buffer) => buf.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => buf.push(d.toString()));

  let alive = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      alive = false;
      resolve({ code, signal });
    });
  });

  // spawn 失败（如文件不可执行）时 error 事件不会触发 exit，需单独兜住
  child.once('error', (err) => {
    buf.push(`\n[spawn error] ${err.message}\n`);
    alive = false;
  });

  return {
    pid: child.pid,
    port,
    tail: () => buf.text(),
    exited,
    isAlive: () => alive,
    async stop() {
      if (!alive) return;
      // 本任务先强杀；任务 02 改为发 /admin/shutdown 并等预算超时
      child.kill();
      await exited;
    },
  };
}
