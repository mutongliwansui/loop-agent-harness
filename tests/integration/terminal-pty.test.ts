/**
 * 终端真实联调测试（Task-20261027-001 / 设计文档「唯一未勾选验收项」）
 *
 * 与 tests/terminal-manager.test.ts 的分工：
 * - 那边用 vi.mock 替身验证「会话管理策略」（并发/回收/审计），毫秒级确定性
 * - 本文件跑**真实进程与真实 socket**，验证整条链路真的通：
 *     PtySession（真 ConPTY）→ TerminalManager → attachTerminalWs → ws 客户端
 *   覆盖「单测永远发现不了」的问题：pid 就绪延迟、中文编码、子协议鉴权、ready 时序。
 *
 * 之所以必须有这一层：项目里 ConPTY 有多个实测坑（spawn 返回时 pid=0、conhost 进程树、
 * 关流后残留回调），这些都无法用替身覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createPtySession, PtySession } from '../../src/terminal/pty-session.js';
import { detectShells, type ShellInfo } from '../../src/terminal/shells.js';
import { b64urlEncode } from '../../src/terminal/ws.js';
import { createApiServer, type ApiServer } from '../../src/api/server.js';
import { SessionStore } from '../../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../../src/config/schema.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-terminal-pty');
const WORKSPACE = join(TEST_DIR, 'workspace');

/** 本机可用 shell（Windows 上通常 powershell + cmd；POSIX 为 bash/sh） */
let shells: ShellInfo[] = [];
/** 首选 shell：优先 powershell（交互提示符稳定），回落到探测到的第一个 */
let shell: ShellInfo;

beforeAll(() => {
  mkdirSync(WORKSPACE, { recursive: true });
  shells = detectShells();
  shell = shells.find((s) => s.id === 'powershell') ?? shells[0];
});

/**
 * 清理临时目录。
 *
 * Windows 上会踩 EPERM：PTY 的 cwd 就在 TEST_DIR 内，进程未完全退出时
 * conhost.exe 仍持有该目录句柄，rmSync 会直接失败。故先杀会话再重试删除，
 * 且删除失败不得让整套用例判失败（临时目录残留无害）。
 */
function cleanupTmp(): void {
  for (const s of opened) {
    try {
      s.kill();
    } catch {
      /* 已退出 */
    }
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      return;
    } catch {
      // 句柄释放需要几十毫秒；同步睡眠避免引入异步时序
      const until = Date.now() + 120;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

/** 轮询等待条件成立（PTY 输出是异步流，只能等） */
async function waitFor(
  fn: () => boolean,
  { timeout = 20_000, step = 25 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return fn();
}

/** 订阅会话输出并累积（返回读取器与注销函数） */
function collect(session: PtySession): { text: () => string; stop: () => void } {
  let buf = '';
  const cb = (d: string): void => {
    buf += d;
  };
  session.onOutput(cb);
  return { text: () => buf, stop: () => session.offOutput(cb) };
}

/** 开一个真实 PTY，并在用例结束时确保 kill（避免泄漏 conhost） */
const opened: PtySession[] = [];
function openPty(over: Partial<{ cols: number; rows: number }> = {}): PtySession {
  const s = createPtySession({
    shell,
    cwd: WORKSPACE,
    cols: over.cols ?? 80,
    rows: over.rows ?? 24,
  });
  opened.push(s);
  return s;
}

afterAll(() => {
  cleanupTmp();
});

describe('真实 PTY 会话（ConPTY / forkpty）', () => {
  it('能探测到至少一个 shell 并可 spawn', () => {
    expect(shells.length).toBeGreaterThan(0);
    expect(shell).toBeTruthy();
  });

  it('spawn 后 pid 最终会就绪（Windows 上 spawn 返回瞬间为 0）', async () => {
    const s = openPty();
    const pid = await s.waitPid(5000);
    // 若始终为 0，前端状态条会永远显示 "PID 0"，属真实回归
    expect(pid).toBeGreaterThan(0);
  });

  it('写命令后能收到回显（端到端字节流通）', async () => {
    const s = openPty();
    const out = collect(s);
    const marker = `MARK${Date.now().toString(36).toUpperCase()}`;
    s.write(`echo ${marker}\r`);
    const ok = await waitFor(() => out.text().includes(marker));
    out.stop();
    expect(ok, `未收到回显，实际输出：${JSON.stringify(out.text().slice(-500))}`).toBe(true);
  }, 30_000);

  it('中文与符号回显不乱码（不注入 chcp，靠 ConPTY 内部 UTF-16）', async () => {
    const s = openPty();
    const out = collect(s);
    const marker = `验证${Date.now().toString(36)}✓`;
    s.write(`echo ${marker}\r`);
    const ok = await waitFor(() => out.text().includes(marker));
    out.stop();
    expect(ok, `中文回显丢失，实际输出：${JSON.stringify(out.text().slice(-500))}`).toBe(true);
  }, 30_000);

  it('回放缓冲累积输出（重连后补历史的依据）', async () => {
    const s = openPty();
    const marker = `REPLAY${Date.now().toString(36).toUpperCase()}`;
    s.write(`echo ${marker}\r`);
    const ok = await waitFor(() => s.replay().includes(marker));
    expect(ok).toBe(true);
  }, 30_000);

  it('resize 在会话存活期与非法入参下都不抛错', () => {
    const s = openPty();
    expect(() => s.resize(120, 40)).not.toThrow();
    // 非法值应被静默忽略（避免分割条拖拽产生 0 列把 PTY 打挂）
    expect(() => s.resize(0, 0)).not.toThrow();
    expect(() => s.resize(Number.NaN, 10)).not.toThrow();
  });

  it('kill 之后写入被静默丢弃（不抛错）', async () => {
    const s = openPty();
    await s.waitPid(5000);
    s.kill();
    expect(() => s.write('echo after-kill\r')).not.toThrow();
    expect(() => s.kill()).not.toThrow(); // 幂等
  });
});

/* ==========================================================================
 * WS 全链路：createApiServer（webui.terminal=true）→ 真实 ws 客户端
 * ========================================================================== */

describe('终端 WS 全链路', () => {
  let server: ApiServer;
  let port = 0;
  let config: AgentConfig;
  let store: SessionStore;

  beforeAll(async () => {
    config = structuredClone(DEFAULT_CONFIG);
    config.webui.terminal = true;
    // 刻意不设 api.token：验证「未配置 token 时回环放行」这一档
    config.api.token = '';
    config.api.host = '127.0.0.1';
    // port 0：随机端口，避免与开发中的 --serve（默认 3000）抢占
    config.api.port = 0;

    store = new SessionStore(WORKSPACE, false, join(TEST_DIR, 'user'));
    server = createApiServer({
      runAgent: async () => {
        throw new Error('终端测试不应调用 runAgent');
      },
      sessionStore: store,
      getConfig: () => config,
      version: 'test',
    });
    port = (await server.start()).port;
  }, 30_000);

  afterAll(async () => {
    await server?.close();
  });

  /** 连接终端 WS，返回消息收集器 */
  function connect(token?: string): {
    ws: WebSocket;
    messages: Array<Record<string, unknown>>;
    waitMsg: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown> | null>;
    closed: () => boolean;
    close: () => void;
  } {
    const url = `ws://127.0.0.1:${port}/ws/terminal?cols=80&rows=24`;
    const protocols = token ? [`loop-agent.v1.${b64urlEncode(token)}`] : undefined;
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    const messages: Array<Record<string, unknown>> = [];
    let isClosed = false;
    ws.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });
    ws.on('close', () => {
      isClosed = true;
    });
    ws.on('error', () => {
      isClosed = true;
    });
    return {
      ws,
      messages,
      async waitMsg(pred, ms = 20_000) {
        const ok = await waitFor(() => messages.some(pred), { timeout: ms });
        return ok ? (messages.find(pred) ?? null) : null;
      },
      closed: () => isClosed,
      close: () => {
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      },
    };
  }

  it('握手后被拒绝（未启用终端）→ 连接失败', async () => {
    // 临时关掉开关，验证 D7「默认关闭」在协议层的真实表现
    const saved = config.webui.terminal;
    config.webui.terminal = false;
    const c = connect();
    const rejected = await waitFor(() => c.closed(), { timeout: 8000 });
    c.close();
    config.webui.terminal = saved;
    expect(rejected, '未启用终端时应拒绝升级').toBe(true);
  }, 20_000);

  it('配置 token 后：缺 token 拒绝，带正确 token 放行', async () => {
    const saved = config.api.token;
    config.api.token = 'secret-token-123';

    // 1) 不带子协议 → 401
    const bad = connect();
    expect(await waitFor(() => bad.closed(), { timeout: 8000 }), '缺少 token 应被拒').toBe(true);
    bad.close();

    // 2) 带正确 token → 能拿到 ready
    const good = connect('secret-token-123');
    const ready = await good.waitMsg((m) => m.t === 'ready', 20_000);
    good.close();
    config.api.token = saved;

    expect(ready, '带正确子协议 token 应拿到 ready').toBeTruthy();
    expect(typeof ready?.sid).toBe('string');
  }, 40_000);

  it('ready → 输入 → 输出 → close 全链路', async () => {
    const c = connect();
    const ready = await c.waitMsg((m) => m.t === 'ready', 20_000);
    expect(ready, '未收到 ready').toBeTruthy();
    // pid 必须真实（waitPid 生效），否则状态条显示 PID 0
    expect(Number(ready?.pid)).toBeGreaterThan(0);
    expect(Array.isArray(ready?.shells)).toBe(true);
    expect((ready?.shells as unknown[]).length).toBeGreaterThan(0);

    const marker = `WS${Date.now().toString(36).toUpperCase()}`;
    c.ws.send(JSON.stringify({ t: 'in', d: `echo ${marker}\r` }));
    const got = await c.waitMsg(
      (m) => m.t === 'out' && String(m.d ?? '').includes(marker),
      20_000,
    );
    expect(got, `WS 未收到命令输出，已收消息：${JSON.stringify(c.messages.slice(-3))}`).toBeTruthy();

    // 显式关闭：服务端应杀会话并断开
    c.ws.send(JSON.stringify({ t: 'close' }));
    expect(await waitFor(() => c.closed(), { timeout: 10_000 })).toBe(true);
  }, 60_000);
});
