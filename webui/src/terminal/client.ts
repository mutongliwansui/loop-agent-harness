// 终端 WebSocket 客户端（Task-20261027-001 D5 / D9）
//
// 约束：浏览器 WebSocket 构造器**无法设置自定义请求头**，Bearer 传不进去；
// query 传 token 会进访问日志与浏览器历史 → token 走子协议：
//   Sec-WebSocket-Protocol: loop-agent.v1.<base64url(token)>
// 服务端（src/terminal/ws.ts）按同一规则解码校验。
import { getToken } from '../api/client.js';

/** 终端状态机（与 TerminalPanel 的覆盖层一一对应） */
export type TermState =
  /** 尚未连接 / 已关闭 */
  | 'empty'
  /** 正在握手 */
  | 'connecting'
  /** 会话就绪，可交互 */
  | 'running'
  /** 命令执行中（从输出流推断，见 Panel） */
  | 'busy'
  /** 进程已退出 */
  | 'exited'
  /** 断连（正在退避重连） */
  | 'offline'
  /** 缺 PTY 原生依赖 */
  | 'unsupported'
  /** 配置未启用 / 鉴权失败 */
  | 'denied';

/** 服务端 → 客户端消息 */
type ServerMsg =
  | { t: 'ready'; sid: string; pid: number; shell: string; shellLabel: string; cwd: string; shells: { id: string; label: string }[] }
  | { t: 'out'; d: string; replay?: boolean }
  | { t: 'exit'; code: number }
  | { t: 'err'; code: string; message: string }
  | { t: 'info'; message: string };

export interface TerminalClientCallbacks {
  onData: (chunk: string) => void;
  onState: (state: TermState, detail?: { message?: string; code?: number }) => void;
  /** ready 后回填真实会话信息（pid / shell / cwd） */
  onReady?: (info: { sid: string; pid: number; shell: string; shellLabel: string; cwd: string }) => void;
}

export interface TerminalClientOptions extends TerminalClientCallbacks {
  /** 工作空间路径（?ws=），决定 PTY 的 cwd */
  wsPath?: string;
  shellId?: string;
  cols: number;
  rows: number;
}

const SUBPROTOCOL_PREFIX = 'loop-agent.v1.';
/** 重连退避序列（1s→2s→4s→8s，上限 5 次后转手动） */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_RETRY = BACKOFF_MS.length;

/** base64url 编码（与 src/terminal/ws.ts 的 b64urlEncode 对齐；Unicode 安全） */
export function b64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 拼 WS 地址（含 token 之外的查询参数） */
export function buildTerminalUrl(
  opts: { wsPath?: string; shellId?: string; cols: number; rows: number; sid?: string },
  loc: { protocol: string; host: string } = window.location,
): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams();
  q.set('cols', String(Math.max(1, Math.floor(opts.cols))));
  q.set('rows', String(Math.max(1, Math.floor(opts.rows))));
  if (opts.shellId) q.set('shell', opts.shellId);
  if (opts.sid) q.set('sid', opts.sid);
  if (opts.wsPath) q.set('ws', opts.wsPath);
  return `${proto}//${loc.host}/ws/terminal?${q.toString()}`;
}

export class TerminalClient {
  private ws: WebSocket | null = null;
  private readonly opts: TerminalClientOptions;
  private state: TermState = 'empty';
  private sid: string | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pendingResize: { cols: number; rows: number } | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TerminalClientOptions) {
    this.opts = opts;
  }

  get currentState(): TermState {
    return this.state;
  }

  get sessionId(): string | null {
    return this.sid;
  }

  private setState(s: TermState, detail?: { message?: string; code?: number }): void {
    this.state = s;
    this.opts.onState(s, detail);
  }

  connect(): void {
    if (this.disposed) return;
    this.setState('connecting');
    const token = getToken();
    const url = buildTerminalUrl({
      wsPath: this.opts.wsPath,
      shellId: this.opts.shellId,
      cols: this.opts.cols,
      rows: this.opts.rows,
      sid: this.sid ?? undefined,
    });

    let ws: WebSocket;
    try {
      // 第二个参数为子协议；token 为空时不带（服务端此时只放行本机）
      ws = token ? new WebSocket(url, [`${SUBPROTOCOL_PREFIX}${b64url(token)}`]) : new WebSocket(url);
    } catch (e) {
      this.setState('offline', { message: e instanceof Error ? e.message : '无法建立连接' });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.disposed) return;
      // 已退出/明确不可用时不重连
      if (this.state === 'exited' || this.state === 'unsupported' || this.state === 'denied') return;
      this.setState('offline');
      this.scheduleRetry();
    };

    ws.onerror = () => {
      // 具体原因由 onclose 统一处理（WebSocket 规范不暴露状态码给 error 事件）
    };
  }

  private handleMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'ready':
        this.sid = msg.sid;
        this.setState('running');
        this.opts.onReady?.({
          sid: msg.sid,
          pid: msg.pid,
          shell: msg.shell,
          shellLabel: msg.shellLabel,
          cwd: msg.cwd,
        });
        break;
      case 'out':
        this.opts.onData(msg.d);
        break;
      case 'exit':
        this.setState('exited', { code: msg.code });
        break;
      case 'err':
        if (msg.code === 'pty_missing') this.setState('unsupported', { message: msg.message });
        else if (msg.code === 'too_many' || msg.code === 'bad_workspace') {
          this.setState('denied', { message: msg.message });
        } else if (msg.code === 'denied') {
          // 拒绝名单拦截：不改变连接状态，由 Panel 显示提示条
          this.opts.onData(`\r\n\x1b[33m[已拒绝] ${msg.message}\x1b[0m\r\n`);
        } else this.setState('offline', { message: msg.message });
        break;
      case 'info':
        this.opts.onData(`\r\n\x1b[90m${msg.message}\x1b[0m\r\n`);
        break;
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return;
    if (this.retries >= MAX_RETRY) return; // 转手动重连
    const delay = BACKOFF_MS[this.retries] ?? 16000;
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed) this.connect();
    }, delay);
  }

  /** 手动重连（重置退避计数） */
  reconnect(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retries = 0;
    this.sid = null; // 手动重连不复用旧会话（用户可能已关掉进程）
    this.closeSocket();
    this.connect();
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'in', d: data }));
    }
  }

  /** 尺寸变化：120ms 防抖后下发（拖拽分割条时会高频触发） */
  resize(cols: number, rows: number): void {
    this.pendingResize = { cols, rows };
    if (this.resizeTimer) return;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      const p = this.pendingResize;
      this.pendingResize = null;
      if (!p || this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ t: 'resize', cols: p.cols, rows: p.rows }));
    }, 120);
  }

  /** 请求服务端把 PTY 结束掉（关标签时用） */
  closeSession(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'close' }));
    }
    this.disposed = true;
    this.closeSocket();
  }

  private closeSocket(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000, 'disposed');
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 组件卸载：不发 close（保留 PTY 供 60s 内重连），仅断开 */
  dispose(): void {
    this.disposed = true;
    this.closeSocket();
  }
}
