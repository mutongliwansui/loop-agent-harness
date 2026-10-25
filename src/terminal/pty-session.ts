// 单个 PTY 会话封装（Task-20261027-001 D2 / D8 / D9）
//
// 设计要点：
// - **lazy 加载** `@lydell/node-pty`：它是原生模块且当前仅 beta 版，缺失/加载失败时
//   必须能让主程序继续跑（降级为 pty_missing），不能让整个服务起不来
// - **输出合帧**：16ms（≈1 帧）内的多次 onData 合并成一次回调，避免 `npm run build`
//   这类高频输出打出上千个小 WS 帧把前端主线程打满
// - **环形回放缓冲**：保留最近 256KB，重连后先回放再续流（断连不丢画面）
// - **kill 走进程树**：Windows 上 ConPTY 会附带 conhost.exe，pty.kill() 未必连根拔起，
//   故额外用 taskkill /T /F 兜底
import { createRequire } from 'node:module';
import { spawn as nodeSpawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import type { ShellInfo } from './shells.js';
import { ensureEmbeddedPty, lastEmbeddedPtyError, embeddedPtyRoot } from './pty-embed.js';

// 解析基准 2：exe 所在目录（SEA 打包后 exe 与 node_modules 同目录部署）。
// 注意这里刻意**不用 process.cwd()**：项目有 process.cwd() 白名单红线（tests/no-chdir.test.ts），
// 依赖解析不应绑定启动目录；exe 目录在 SEA 场景下语义更准确。
const requireFromExecDir = createRequire(join(dirname(process.execPath), '__pty_resolve__.js'));

/** PTY 包名（集中一处，便于错误提示与解析复用） */
const PTY_PKG = '@lydell/node-pty';

/** 缺少 PTY 原生依赖（前端据此显示「交互式终端不可用」并给安装命令） */
export class PtyUnavailableError extends Error {
  readonly code = 'pty_missing';
  constructor(reason: string) {
    super(`交互式终端不可用：${reason}`);
    this.name = 'PtyUnavailableError';
  }
}

/** 输出合帧窗口（毫秒） */
const FLUSH_MS = 16;
/** 回放缓冲上限（字节，按 UTF-16 码元近似计） */
const REPLAY_LIMIT = 256 * 1024;

/** @lydell/node-pty 的最小结构面（只声明用到的成员，避免依赖其类型声明） */
interface PtyLike {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike;
}

let ptyModule: PtyModule | null | undefined;

/**
 * 判断 `process.argv[1]` 是否是真实脚本路径。
 *
 * 必须判：SEA 产物里 `argv[1]` 是**用户命令行参数**（如 `--serve`），不是脚本路径。
 * 若直接拿它做 `createRequire` 基准，Node 会按 cwd 解析，导致「PTY 是否可用」随启动目录
 * 漂移（工作空间里恰好有 node_modules 就能用，否则不能），属于隐形的路径依赖。
 */
export function looksLikeScriptPath(p: string | undefined): boolean {
  if (!p) return false;
  if (p.startsWith('-')) return false; // CLI 标志
  return /\.(c|m)?[jt]s$/.test(p); // 源码或 CJS/ESM 产物
}

/**
 * 实际会查找 `node_modules` 的目录（排查「为什么找不到 PTY」用）。
 * 仅用于提示文案，不影响解析逻辑。
 */
export function describePtySearchPaths(): string {
  const dirs: string[] = [];
  const entry = process.argv[1];
  if (looksLikeScriptPath(entry)) dirs.push(join(dirname(entry as string), 'node_modules'));
  dirs.push(join(dirname(process.execPath), 'node_modules'));
  return [...new Set(dirs)].join('、');
}

/**
 * 内嵌 release 目录（仅当 exe 内嵌了原生模块时非空）。
 * 单独暴露给文案层：单文件分发场景下真正可用的路径是它，而不是磁盘 node_modules。
 */
export function describeEmbeddedPtyPath(): string | null {
  const info = ensureEmbeddedPty();
  return info ? info.root : null;
}

/**
 * 加载 PTY 原生模块（失败缓存为 null，避免每次 spawn 都重试昂贵的 require）。
 * 导出供单测替换/复位。
 *
 * 解析基准需要多级回退（这是踩过的真实坑）：
 * - `createRequire(process.argv[1])`：以入口脚本为基准（源码/tsx：`src/index.ts`，
 *   CJS 产物：`dist-sea/index.cjs`），正常构建最准确。
 *   刻意**不用** `import.meta.url`：esbuild 打 CJS 时会告警且替换为空对象，
 *   `createRequire(undefined)` 直接抛 TypeError。
 *   注意 SEA 下必须先用 `looksLikeScriptPath` 过滤掉 CLI 参数，见该函数注释。
 * - `createRequire(<exeDir>/x.js)`：SEA 产物（exe 与 node_modules 同目录部署）。
 * - `createRequire(process.execPath)` + 显式 paths：全局安装等边缘场景。
 *   注意**其基准是 node.exe 所在目录**，只适用于 Node **内置**模块
 *   （故 src/memory/fts.ts 的 node:sqlite 可用）；对 npm 包必须配 paths 才能兜底。
 */
export function loadPtyModule(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;

  const attempts: Array<() => unknown> = [
    // 1) 入口脚本位置（源码/tsx：src/index.ts；CJS 产物：dist-sea/index.cjs）
    () =>
      looksLikeScriptPath(process.argv[1])
        ? createRequire(process.argv[1] as string)(PTY_PKG)
        : undefined, // SEA 下 argv[1] 为用户参数，交由下一基准
    // 2) exe 所在目录（SEA 打包产物）
    () => requireFromExecDir(PTY_PKG),
    // 3) execPath 基准 + 显式 paths（全局安装等边缘场景）
    () => {
      const req = createRequire(process.execPath);
      return req(req.resolve(PTY_PKG, { paths: [dirname(process.execPath)] }));
    },
    // 4) SEA 内嵌释放目录（单文件分发：exe 自带原生模块，Task-20261027-002）
    //    放在最后是刻意的（D6）：本地开发与「exe + node_modules」老形态继续走
    //    零开销的磁盘路径，只有真正单文件分发时才付出释放 1.59MB 的成本。
    () => {
      const info = ensureEmbeddedPty();
      if (!info) return undefined;
      return createRequire(info.anchor)(PTY_PKG);
    },
  ];

  for (const attempt of attempts) {
    try {
      const mod = attempt() as PtyModule & { default?: PtyModule };
      const resolved = typeof mod?.spawn === 'function' ? mod : (mod?.default ?? null);
      if (resolved) {
        ptyModule = resolved;
        return ptyModule;
      }
    } catch {
      // 该基准解析失败，换下一个
    }
  }

  ptyModule = null;
  return null;
}

/** 复位加载缓存（仅单测用） */
export function resetPtyModuleCache(): void {
  ptyModule = undefined;
}

export interface PtySessionOptions {
  shell: ShellInfo;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export class PtySession {
  readonly id: string;
  readonly shell: ShellInfo;
  private readonly pty: PtyLike;
  private buffer = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly outputCbs = new Set<(chunk: string) => void>();
  private readonly exitCbs = new Set<(code: number) => void>();
  /** 环形回放缓冲（用数组按块保存，超限从头裁切） */
  private replayChunks: string[] = [];
  private replaySize = 0;
  private exited = false;
  private killed = false;

  constructor(id: string, pty: PtyLike, shell: ShellInfo) {
    this.id = id;
    this.pty = pty;
    this.shell = shell;

    this.pty.onData((d) => this.pushOutput(d));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      // 退出前排空剩余输出，避免最后一行丢失
      this.flush();
      for (const cb of this.exitCbs) cb(exitCode);
      this.exitCbs.clear();
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  /**
   * 等待 pid 就绪。
   *
   * **实测坑（Windows ConPTY + @lydell/node-pty）**：`spawn()` 返回时 `pty.pid` 仍为 0，
   * 约 100ms 后才被填充（本机采样：0ms/12ms/51ms 为 0，117ms 起有效）。
   * 若握手时立即读 pid，前端状态条会永远显示 "PID 0"。
   *
   * @param timeoutMs 最长等待；超时返回当前值（可能仍为 0，前端按 "—" 处理）
   */
  async waitPid(timeoutMs = 1000): Promise<number> {
    if (this.pty.pid > 0) return this.pty.pid;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited || this.killed) break;
      // 20ms 轮询：足够快（远小于可感知延迟），又不会忙等
      await new Promise((r) => setTimeout(r, 20));
      if (this.pty.pid > 0) return this.pty.pid;
    }
    return this.pty.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  onOutput(cb: (chunk: string) => void): void {
    this.outputCbs.add(cb);
  }

  /**
   * 注销输出订阅。
   * 必须成对调用：WS 断开后若不注销，旧回调会一直挂在会话上（重连场景下逐个累积），
   * 造成内存泄漏与无用的 send 尝试。
   */
  offOutput(cb: (chunk: string) => void): void {
    this.outputCbs.delete(cb);
  }

  onExit(cb: (code: number) => void): void {
    if (this.exited) {
      cb(-1);
      return;
    }
    this.exitCbs.add(cb);
  }

  write(data: string): void {
    if (this.exited || this.killed) return;
    try {
      this.pty.write(data);
    } catch {
      // PTY 已关闭时的写入竞态：静默丢弃（前端会收到 exit 事件）
    }
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.killed) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    try {
      this.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // 尺寸竞态失败不影响会话存活
    }
  }

  /** 回放缓冲快照（重连时先发这个，再续流） */
  replay(): string {
    return this.replayChunks.join('');
  }

  /** 结束会话并清理进程树 */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.pty.kill();
    } catch {
      /* 已退出 */
    }
    // ConPTY 的子进程（conhost.exe 等）不一定随 kill 消失：按 PID 清整棵树
    if (process.platform === 'win32' && this.pty.pid) {
      try {
        // 不等待、不关心结果；失败说明进程已不存在
        nodeSpawn('taskkill', ['/T', '/F', '/PID', String(this.pty.pid)], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => {});
      } catch {
        /* 忽略 */
      }
    }
  }

  /* --------------------------- 内部：合帧与缓冲 --------------------------- */

  private pushOutput(d: string): void {
    if (!d) return;
    this.buffer += d;
    this.appendReplay(d);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, FLUSH_MS);
      // 合帧定时器不应阻止进程退出
      this.flushTimer.unref?.();
    }
  }

  private flush(): void {
    if (!this.buffer) return;
    const chunk = this.buffer;
    this.buffer = '';
    for (const cb of this.outputCbs) {
      try {
        cb(chunk);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }

  private appendReplay(d: string): void {
    this.replayChunks.push(d);
    this.replaySize += d.length;
    while (this.replaySize > REPLAY_LIMIT && this.replayChunks.length > 1) {
      const dropped = this.replayChunks.shift();
      this.replaySize -= dropped?.length ?? 0;
    }
    // 单块就超限时保留尾部
    if (this.replaySize > REPLAY_LIMIT * 2) {
      const joined = this.replayChunks.join('');
      this.replayChunks = [joined.slice(-REPLAY_LIMIT)];
      this.replaySize = this.replayChunks[0].length;
    }
  }
}

let seq = 0;
export function nextSessionId(): string {
  seq += 1;
  return `term_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * 缺 PTY 时的可操作指引。错误信息与 `/terminal/info` 的 `ptyHint` 共用同一份文案，
 * 避免「前端自己写一句 npm i」与服务端真实原因漂移（SEA 部署照做无效，已踩过）。
 *
 * 文案三段式（Task-20261027-002 D8）：已查找路径 → 单文件 exe 补救 → 开发环境补救。
 * 只有把「单文件 exe」摆在前面，用户才不会对着 exe 目录去执行 npm i。
 */
export function ptyUnavailableHint(): string {
  const embedded = describeEmbeddedPtyPath();
  const embedReason = lastEmbeddedPtyError();

  // 单文件 exe：exe 内嵌了原生模块但释放失败 → 说明失败原因，给出可执行动作
  const exePart = embedded
    ? `内嵌模块已释放到 ${embedded} 但仍加载失败，可删除该目录后重启（下次启动会重新释放）`
    : embedReason
      ? `单文件 exe 内嵌模块释放失败（${embedReason}），可删除 %TEMP% 下的 loop-agent-pty-* 目录后重启`
      : '单文件 exe 部署应自带原生模块；若这是自行裁剪的产物，请重新执行 npm run build:sea 打包';

  return (
    `未找到 ${PTY_PKG}（已查找：${describePtySearchPaths()}）。` +
    `${exePart}；` +
    '开发环境执行 npm i @lydell/node-pty 后重启服务；' +
    '旧的「exe + 同级 node_modules」形态仍受支持，把 node_modules/@lydell 放在 exe 同目录即可'
  );
}

/**
 * 创建 PTY 会话。
 * @throws PtyUnavailableError 原生模块不可用
 * @throws Error spawn 失败（shell 路径无效等）
 */
export function createPtySession(opts: PtySessionOptions): PtySession {
  const mod = loadPtyModule();
  if (!mod) {
    throw new PtyUnavailableError(ptyUnavailableHint());
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? (process.env as Record<string, string>))) {
    if (typeof v === 'string') env[k] = v;
  }
  // D4：不注入 chcp 65001 / OutputEncoding——实测 ConPTY 内部走 UTF-16，
  // Node 侧拿到的已是 UTF-8，中文与符号回显正确，注入反而污染用户终端输出
  env.TERM = 'xterm-256color';

  const pty = mod.spawn(opts.shell.file, opts.shell.args, {
    name: 'xterm-256color',
    cols: Math.max(1, Math.floor(opts.cols)),
    rows: Math.max(1, Math.floor(opts.rows)),
    cwd: opts.cwd,
    env,
    // ConPTY 下 windowsHide 对 conhost 无效（它不经 child_process），仍设以防其他平台
    windowsHide: true,
  });
  return new PtySession(nextSessionId(), pty, opts.shell);
}
