// 终端 WebSocket 入口（Task-20261027-001 D1 / D5 / D7）
//
// 关键约束与对策：
// - 浏览器 WebSocket **无法设置任何自定义请求头**（比 EventSource 更彻底，
//   参见 webui/src/api/sse.ts 已记录的同类问题），Authorization 传不进来；
//   query 传 token 会进服务端访问日志与浏览器历史 → **改用子协议承载**：
//     Sec-WebSocket-Protocol: loop-agent.v1.<base64url(token)>
//   用 base64url 包裹是因为 HTTP token 语法不允许逗号/空格等字符，裸 token 可能非法。
// - `node:http` 无内置 WS 帧编解码（Node 22+ 也只有 client 端 WebSocket），
//   故引入 ws（纯 JS、零传递依赖）。
// - 协议：JSON 文本帧；输出侧已由 PtySession 做 16ms 合帧。
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentConfig } from '../config/schema.js';
import { LOOPBACK_HOST } from '../api/http-utils.js';
import { detectShells, pickShell, type ShellInfo } from './shells.js';
import { PtyUnavailableError } from './pty-session.js';
import { TerminalManager, TooManySessionsError } from './manager.js';

/** 子协议前缀 */
const SUBPROTOCOL_PREFIX = 'loop-agent.v1.';

export interface TerminalWsDeps {
  getConfig: () => AgentConfig;
  /** 会话表（server 持有，close 时 disposeAll） */
  manager: TerminalManager;
  /** 解析 ?ws= 到绝对工作目录（校验必须是已注册工作空间） */
  resolveCwd: (wsParam: string | null) => Promise<string>;
  log?: (msg: string) => void;
  /** shell 探测（单测注入） */
  detect?: () => ShellInfo[];
}

interface ClientQuery {
  cols: number;
  rows: number;
  shellId?: string;
  /** 重连复用已存在的 PTY 会话 */
  sid?: string;
  wsParam: string | null;
}

/** 解析 base64url → utf8 字符串（失败返回 null） */
function b64urlDecode(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** base64url 编码（前端对应实现的镜像，单测用） */
export function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 从 `Sec-WebSocket-Protocol` 头里解出 token。
 * 头可能是逗号分隔的多个协议，逐个匹配前缀。
 */
export function extractTokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(',')) {
    const p = raw.trim();
    if (p.startsWith(SUBPROTOCOL_PREFIX)) {
      return b64urlDecode(p.slice(SUBPROTOCOL_PREFIX.length));
    }
  }
  return null;
}

/**
 * 终端握手鉴权（与 http-utils.isAuthorized 同口径）：
 * - 配置了 token → 子协议里的 token 必须完全一致
 * - 未配置 token → 仅放行回环来源
 */
export function authorizeTerminal(
  req: IncomingMessage,
  token: string,
): { ok: true } | { ok: false; status: number; reason: string } {
  const presented = extractTokenFromProtocols(req.headers['sec-websocket-protocol'] as string | undefined);
  if (token) {
    if (presented !== token) return { ok: false, status: 401, reason: '缺少或错误的终端 Token' };
    return { ok: true };
  }
  // 未配置 token：仅本机
  const remote = req.socket.remoteAddress ?? '';
  const isLoopback =
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
  if (!isLoopback) return { ok: false, status: 403, reason: '未配置 api.token 时终端仅允许本机访问' };
  return { ok: true };
}

/**
 * Origin 白名单：默认只接受与请求 Host 同源，或回环来源的 Origin（防 CSRF 式跨站连接）。
 * 无 Origin 头（非浏览器客户端如 curl/测试）放行——此时已由 token/回环判定把关。
 */
export function checkOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = (req.headers.host ?? '').toLowerCase();
    if (host && u.host.toLowerCase() === host) return true;
    return LOOPBACK_HOST.has(u.hostname);
  } catch {
    return false;
  }
}

function parseQuery(rawUrl: string | undefined): ClientQuery {
  const u = new URL(rawUrl ?? '/', 'http://localhost');
  const q = u.searchParams;
  const num = (k: string, dflt: number): number => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 && v <= 1000 ? Math.floor(v) : dflt;
  };
  return {
    cols: num('cols', 96),
    rows: num('rows', 27),
    shellId: q.get('shell') ?? undefined,
    sid: q.get('sid') ?? undefined,
    wsParam: q.get('ws'),
  };
}

/** 拒绝升级：写回原始 HTTP 响应后断开（浏览器会表现为 WS 连接失败） */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = JSON.stringify({ error: { code: status === 401 ? 'unauthorized' : 'forbidden', message: reason } });
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
  socket.destroy();
}

/**
 * 把终端 WS 挂到既有 http server 上。
 * 返回清理函数（server.close 时调用，全量杀 PTY 并关闭 wss）。
 */
export function attachTerminalWs(server: Server, deps: TerminalWsDeps): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    // 回显客户端请求的子协议（不回显则浏览器判定协商失败而断开）
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  const log = (m: string): void => deps.log?.(m);
  const detect = deps.detect ?? (() => detectShells());

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws/terminal') {
      // 其他升级路径未实现：明确 404，避免连接悬挂
      socket.destroy();
      return;
    }

    const cfg = deps.getConfig();
    // D7：默认关闭——未显式开启时直接拒绝（不是静默失败，前端可据此显示配置提示）
    if (!cfg.webui?.terminal) {
      rejectUpgrade(socket, 403, '终端未启用：请在配置中设置 webui.terminal = true');
      return;
    }
    if (!checkOrigin(req)) {
      rejectUpgrade(socket, 403, 'Origin 不在白名单');
      return;
    }
    const auth = authorizeTerminal(req, cfg.api.token);
    if (!auth.ok) {
      rejectUpgrade(socket, auth.status, auth.reason);
      return;
    }

    // 安全前提：非回环绑定且无 token 时，server.start 已拒绝启动；
    // 此处再加一道：非回环 host 时必须有 token（防配置热改绕过启动校验）
    if (!cfg.api.token && !LOOPBACK_HOST.has(cfg.api.host)) {
      rejectUpgrade(socket, 403, '非回环绑定必须配置 api.token 才能启用终端');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, parseQuery(req.url)));
  };

  const onConnection = (ws: WebSocket, q: ClientQuery): void => {
    const send = (msg: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };

    void (async () => {
      // ---- 1. 解析工作目录（新建与复用都要，用于 ready 消息展示） ----
      let cwd: string;
      try {
        cwd = await deps.resolveCwd(q.wsParam);
      } catch (e) {
        send({
          t: 'err',
          code: 'bad_workspace',
          message: e instanceof Error ? e.message : '工作空间无效',
        });
        ws.close(1011, 'bad_workspace');
        return;
      }

      // ---- 2. 定位或新建会话 ----
      let session: ReturnType<TerminalManager['get']>;
      if (q.sid) {
        session = deps.manager.attach(q.sid);
        if (session) {
          log(`[terminal] 重连复用会话 ${q.sid} (pid ${session.pid})`);
        } else {
          send({ t: 'info', message: `会话 ${q.sid} 已不存在，将新建终端` });
        }
      }

      const shells = detect();
      if (!shells.length) {
        send({ t: 'err', code: 'no_shell', message: '未探测到可用的 shell' });
        ws.close(1011, 'no_shell');
        return;
      }

      if (!session) {
        const shell = pickShell(shells, q.shellId);
        if (!shell) {
          send({ t: 'err', code: 'no_shell', message: '未探测到可用的 shell' });
          ws.close(1011, 'no_shell');
          return;
        }
        try {
          session = deps.manager.open({ shell, cwd, cols: q.cols, rows: q.rows });
        } catch (e) {
          if (e instanceof PtyUnavailableError) {
            send({ t: 'err', code: 'pty_missing', message: e.message });
          } else if (e instanceof TooManySessionsError) {
            send({ t: 'err', code: 'too_many', message: e.message });
          } else {
            send({
              t: 'err',
              code: 'spawn_failed',
              message: e instanceof Error ? e.message : String(e),
            });
          }
          ws.close(1011, 'open_failed');
          return;
        }
      }

      const sid = session.id;
      const shell = session.shell;

      // ---- 3. 就绪 + 回放 ----
      // 先等 pid 就绪：Windows ConPTY 下 spawn 返回时 pid 为 0，约 100ms 后才填充，
      // 立即读会让前端状态条永远显示 "PID 0"（见 PtySession.waitPid 注释）
      const pid = await session.waitPid();
      send({
        t: 'ready',
        sid,
        pid,
        shell: shell.id,
        shellLabel: shell.label,
        cwd,
        shells: shells.map((s) => ({ id: s.id, label: s.label })),
      });
      const replay = session.replay();
      if (replay) send({ t: 'out', d: replay, replay: true });

      // ---- 3. 管道接线 ----
      // 注意：只订阅一次（PtySession.onOutput）。manager.subscribe 是给多连接广播预留的，
      // 当前单连接模型下不再重复挂载，避免同一条输出被发两遍。
      const onData = (chunk: string): void => send({ t: 'out', d: chunk });
      session.onOutput(onData);

      let closed = false;
      /** 心跳定时器（cleanup 会引用，需先声明避免 TDZ） */
      let heartbeat: NodeJS.Timeout | null = null;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        // 必须注销，否则每次重连都会在会话上累积一个失效回调
        session.offOutput(onData);
        deps.manager.detach(sid);
        if (heartbeat) clearInterval(heartbeat);
      };

      const exitCb = (code: number): void => {
        send({ t: 'exit', code });
      };
      session.onExit(exitCb);

      ws.on('message', (raw) => {
        let msg: { t?: string; d?: string; cols?: number; rows?: number; sig?: string };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return; // 非法帧直接忽略（不自毁连接）
        }
        switch (msg.t) {
          case 'in': {
            if (typeof msg.d !== 'string') return;
            const accepted = deps.manager.input(sid, msg.d);
            if (!accepted) {
              send({ t: 'err', code: 'denied', message: '该命令被 webui.terminalDeny 拒绝执行' });
            }
            break;
          }
          case 'resize':
            session.resize(Number(msg.cols), Number(msg.rows));
            break;
          case 'signal':
            // Ctrl+C 等：直接送控制字符，最贴近真实终端
            if (msg.sig === 'INT') deps.manager.input(sid, '\x03');
            break;
          case 'replay':
            send({ t: 'out', d: session.replay(), replay: true });
            break;
          case 'close':
            deps.manager.close(sid);
            ws.close(1000, 'closed by client');
            break;
          default:
            break;
        }
      });

      ws.on('close', () => {
        cleanup();
        // 已发 close 主动关闭时 entry 早被移除，若仍报「进入宽限期」会误导排查
        log(
          deps.manager.has(sid)
            ? `[terminal] 连接断开，会话 ${sid} 进入 60s 宽限期`
            : `[terminal] 连接断开，会话 ${sid} 已关闭`,
        );
      });
      ws.on('error', () => {
        cleanup();
      });

      // ---- 4. 心跳（30s）：清理半开连接 ----
      heartbeat = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        try {
          ws.ping();
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 30_000);
      heartbeat.unref?.();
    })().catch((e: unknown) => {
      log(`[terminal] 会话建立失败: ${e instanceof Error ? e.message : String(e)}`);
      try {
        send({ t: 'err', code: 'internal', message: e instanceof Error ? e.message : String(e) });
        ws.close(1011, 'internal');
      } catch {
        /* 已断开 */
      }
    });
  };

  server.on('upgrade', onUpgrade);

  return () => {
    server.off('upgrade', onUpgrade);
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        /* 忽略 */
      }
    }
    wss.close();
  };
}
