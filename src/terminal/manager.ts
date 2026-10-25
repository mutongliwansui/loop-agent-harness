// 终端会话表（Task-20261027-001 D8 / D10）
//
// 职责：
// - 并发上限（默认 4）：超限拒绝，避免拖死机器
// - 断连宽限（60s）：WS 断开后不立即杀 PTY，留给重连回放
// - 空闲回收（默认 30min）：无人操作的会话自动清理
// - 命令审计 + 拒绝名单：**服务端生效**（前端确认框可被绕过，不算安全边界）
// - 退出时全量清理（进程树），防 conhost.exe 残留
import type { ShellInfo } from './shells.js';
import { PtySession, createPtySession, type PtySessionOptions } from './pty-session.js';

/** 并发超限 */
export class TooManySessionsError extends Error {
  readonly code = 'too_many';
  constructor(max: number) {
    super(`并发终端数已达上限 ${max} 个，请先关闭其他终端`);
    this.name = 'TooManySessionsError';
  }
}

/** 断连宽限期（毫秒）：超过则视为放弃，回收 PTY */
export const REATTACH_GRACE_MS = 60 * 1000;
/** 回收扫描间隔（毫秒） */
const SWEEP_MS = 30 * 1000;

export interface TerminalManagerOptions {
  /** 并发上限 */
  maxSessions: number;
  /** 空闲回收（毫秒） */
  idleMs: number;
  /** 拒绝执行的命令关键字（命中即拒，服务端生效） */
  deny?: string[];
  /** 审计回调（每条提交的命令一行） */
  audit?: (entry: AuditEntry) => void;
  /** 诊断日志（名额回收/顶替等，便于排查"假性达上限"） */
  log?: (msg: string) => void;
}

/** 一条命令审计记录 */
export interface AuditEntry {
  at: number;
  sessionId: string;
  /** 提取出的完整命令行（非逐字节键盘输入） */
  command: string;
  /** 是否被拒绝名单拦下 */
  denied: boolean;
}

export interface OpenOptions {
  shell: ShellInfo;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

interface Entry {
  session: PtySession;
  /** 最后活跃时间（有输入/输出即刷新） */
  lastActive: number;
  /** 断连时间；null = 有活跃 WS 连接 */
  detachedAt: number | null;
  /** 命令拼装缓冲：逐字节输入累积到回车，用于审计与拒绝判定 */
  lineBuffer: string;
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: TerminalManagerOptions;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(options: TerminalManagerOptions) {
    this.opts = { deny: [], ...options };
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    // 回收定时器不应阻止进程退出
    this.sweeper.unref?.();
  }

  /** 当前存活会话数 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 新建会话。
   * @throws TooManySessionsError 超过并发上限
   * @throws PtyUnavailableError 原生模块缺失
   */
  open(o: OpenOptions): PtySession {
    // 名额判定前先做两件清理，避免「界面上一个终端都没有却报已达上限」：
    // 1) 已过宽限期的 detached 会话（正常应被 sweep 回收，但 sweep 30s 才跑一次）；
    // 2) 仍超限时顶掉最老的 detached 会话——它的 60s 宽限期本是给网络闪断重连用的，
    //    而用户此刻主动新建终端，意图更明确；被顶掉的会话重连时会收到
    //    「会话已不存在，将新建终端」并自动新建，不会卡死。
    // 只动 detached（detachedAt !== null，即无活跃 WS）会话，活跃会话一律不抢。
    this.reclaimStaleDetached(Date.now());
    if (this.entries.size >= this.opts.maxSessions) {
      this.evictOldestDetached();
    }
    if (this.entries.size >= this.opts.maxSessions) {
      throw new TooManySessionsError(this.opts.maxSessions);
    }
    const ptyOpts: PtySessionOptions = {
      shell: o.shell,
      cwd: o.cwd,
      cols: o.cols,
      rows: o.rows,
      env: o.env,
    };
    const session = createPtySession(ptyOpts);
    const entry: Entry = {
      session,
      lastActive: Date.now(),
      detachedAt: null,
      lineBuffer: '',
    };
    this.entries.set(session.id, entry);
    return session;
  }

  /** 取会话（不存在或已回收返回 undefined） */
  get(id: string): PtySession | undefined {
    return this.entries.get(id)?.session;
  }

  /** 是否有该会话 */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 标记有活跃连接（重连或首次 attach） */
  attach(id: string): PtySession | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.detachedAt = null;
    e.lastActive = Date.now();
    return e.session;
  }

  /** 标记连接断开（启动宽限期计时） */
  detach(id: string): void {
    const e = this.entries.get(id);
    if (e) e.detachedAt = Date.now();
  }

  /** 刷新活跃时间 */
  touch(id: string): void {
    const e = this.entries.get(id);
    if (e) e.lastActive = Date.now();
  }

  /**
   * 处理用户输入：累积命令行做审计与拒绝判定，命中拒绝名单时不写入 PTY。
   * @returns true = 已写入；false = 被拒绝（调用方应回 err{code:'denied'}）
   */
  input(id: string, data: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.lastActive = Date.now();

    // 命令行拼装：回车（\r 或 \n）提交，退格回删，控制字符忽略
    let denyHit = false;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const cmd = e.lineBuffer.trim();
        e.lineBuffer = '';
        if (cmd) {
          const hit = this.matchDeny(cmd);
          if (hit) {
            denyHit = true;
            this.opts.audit?.({ at: Date.now(), sessionId: id, command: cmd, denied: true });
          } else {
            this.opts.audit?.({ at: Date.now(), sessionId: id, command: cmd, denied: false });
          }
        }
      } else if (ch === '\x7f' || ch === '\b') {
        e.lineBuffer = e.lineBuffer.slice(0, -1);
      } else if (ch >= ' ') {
        e.lineBuffer += ch;
      }
    }

    if (denyHit) return false;
    e.session.write(data);
    return true;
  }

  /** 命令是否命中拒绝名单（大小写不敏感子串匹配） */
  private matchDeny(cmd: string): string | null {
    const list = this.opts.deny ?? [];
    if (!list.length) return null;
    const lower = cmd.toLowerCase();
    for (const kw of list) {
      if (kw && lower.includes(kw.toLowerCase())) return kw;
    }
    return null;
  }

  /** 关闭并清理单个会话 */
  close(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.session.kill();
  }

  /** 只回收已过宽限期的 detached 会话（活跃会话不受影响） */
  private reclaimStaleDetached(now: number): void {
    for (const [id, e] of [...this.entries]) {
      if (e.detachedAt !== null && now - e.detachedAt > REATTACH_GRACE_MS) {
        this.opts.log?.(`[manager] 回收过期 detached 会话 ${id}（已断连 ${Math.round((now - e.detachedAt) / 1000)}s）`);
        this.close(id);
      }
    }
  }

  /**
   * 顶掉最老的 detached 会话为新终端腾名额。
   * @returns 是否腾出了名额（无 detached 会话时返回 false）
   */
  private evictOldestDetached(): boolean {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, e] of this.entries) {
      if (e.detachedAt !== null && e.detachedAt < oldestAt) {
        oldestAt = e.detachedAt;
        oldestId = id;
      }
    }
    if (!oldestId) return false;
    this.opts.log?.(`[manager] 名额已满，顶掉最老的 detached 会话 ${oldestId}`);
    this.close(oldestId);
    return true;
  }

  /** 扫描并回收过期会话 */
  sweep(now: number = Date.now()): void {
    for (const [id, e] of [...this.entries]) {
      const idle = now - e.lastActive;
      const detachedFor = e.detachedAt === null ? 0 : now - e.detachedAt;
      if (detachedFor > REATTACH_GRACE_MS || idle > this.opts.idleMs) {
        this.close(id);
      }
    }
  }

  /** 服务关闭时全量清理 */
  disposeAll(): void {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const id of [...this.entries.keys()]) this.close(id);
  }
}
