// 生命周期单测（任务 20261112-007-02 / D2-4、D2-5、D2-7）
//
// 覆盖点：
// - requestShutdown 的应答映射：202/409/403/501/连不上
// - gracefulQuit 三条结局：优雅退出、超时强杀、本来就已退出
// - 超时上限必须等于 budget + grace（用户调大预算时不能被提前砍）
// - 单实例锁语义：拿不到锁时返回 false 且不注册 second-instance
//
// 用假 handle 而非真进程：强杀路径要断言「taskkill 被调用过」，
// 真跑 taskkill 会杀掉测试自己的进程树，风险太大。
import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  requestShutdown,
  gracefulQuit,
  killTree,
  installSingleInstance,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type SingleInstanceApp,
} from '../desktop/src/lifecycle';
import type { BackendHandle } from '../desktop/src/backend-process';
import { pickPort } from '../desktop/src/port';

/** 起一个假的 /admin/shutdown 端点，按 status 返回（不读 body 也能验证映射） */
async function serveShutdown(status: number): Promise<{ server: Server; port: number }> {
  const port = await pickPort(34500 + Math.floor(Math.random() * 400));
  const server = createServer((req, res) => {
    // 收集请求头，供断言标记头确实被带上
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('requestShutdown：应答映射', () => {
  it('202 → accepted', async () => {
    const { server, port } = await serveShutdown(202);
    try {
      expect(await requestShutdown({ port })).toBe('accepted');
    } finally {
      await close(server);
    }
  });

  it('409 → already（幂等：别人先发了）', async () => {
    const { server, port } = await serveShutdown(409);
    try {
      expect(await requestShutdown({ port })).toBe('already');
    } finally {
      await close(server);
    }
  });

  it('403 → denied', async () => {
    const { server, port } = await serveShutdown(403);
    try {
      expect(await requestShutdown({ port })).toBe('denied');
    } finally {
      await close(server);
    }
  });

  it('501 → unsupported（老版本 exe 没有该端点）', async () => {
    const { server, port } = await serveShutdown(501);
    try {
      expect(await requestShutdown({ port })).toBe('unsupported');
    } finally {
      await close(server);
    }
  });

  it('连不上 → unreachable', async () => {
    // 取一个刚释放的端口，确保无人监听
    const port = await pickPort(34900 + Math.floor(Math.random() * 60));
    expect(await requestShutdown({ port, timeoutMs: 500 })).toBe('unreachable');
  });

  it('必带 X-LoopAgent-Client: desktop，且有 token 时带 Bearer', async () => {
    const port = await pickPort(34500 + Math.floor(Math.random() * 400));
    let seen: { client?: string; auth?: string } = {};
    const server = createServer((req, res) => {
      seen = {
        client: req.headers[CLIENT_HEADER.toLowerCase()] as string | undefined,
        auth: req.headers.authorization,
      };
      res.writeHead(202).end('{}');
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      await requestShutdown({ port, token: 'tk-1' });
      expect(seen.client).toBe(CLIENT_HEADER_VALUE);
      expect(seen.auth).toBe('Bearer tk-1');
    } finally {
      await close(server);
    }
  });
});

/** 假后端句柄：可控存活状态与退出时机 */
function fakeHandle(port: number, opts: { exitAfterMs?: number; alreadyDead?: boolean } = {}) {
  let alive = !opts.alreadyDead;
  let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    resolveExit = r;
  });
  if (opts.alreadyDead) resolveExit({ code: 1, signal: null });
  if (opts.exitAfterMs !== undefined) {
    setTimeout(() => {
      alive = false;
      resolveExit({ code: 0, signal: null });
    }, opts.exitAfterMs);
  }
  const stop = vi.fn(async () => {
    alive = false;
    resolveExit({ code: 0, signal: null });
  });
  const handle: BackendHandle = {
    pid: undefined, // 不真杀：killTree(undefined) 直接返回 false，落到 stop()
    port,
    tail: () => '',
    exited,
    isAlive: () => alive,
    stop,
  };
  return { handle, stop };
}

describe('gracefulQuit：三条结局', () => {
  it('后端在预算内退出 → graceful', async () => {
    const { server, port } = await serveShutdown(202);
    try {
      const { handle } = fakeHandle(port, { exitAfterMs: 30 });
      const out = await gracefulQuit(handle, { budgetMs: 200, graceMs: 200 });
      expect(out).toBe('graceful');
    } finally {
      await close(server);
    }
  });

  it('后端不退出且超时 → killed，并回落到 stop()', async () => {
    const { server, port } = await serveShutdown(202);
    try {
      const { handle, stop } = fakeHandle(port);
      const out = await gracefulQuit(handle, { budgetMs: 30, graceMs: 20 });
      expect(out).toBe('killed');
      // pid 为 undefined 时 taskkill 不执行，必须回落到句柄自带 stop()
      expect(stop).toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('后端本来就已退出 → dead，不发请求', async () => {
    const { handle } = fakeHandle(1, { alreadyDead: true });
    const out = await gracefulQuit(handle, { budgetMs: 100, graceMs: 100 });
    expect(out).toBe('dead');
  });

  it('端点拒绝（403）→ 直接强杀，不白等预算', async () => {
    const { server, port } = await serveShutdown(403);
    try {
      const { handle, stop } = fakeHandle(port);
      const started = Date.now();
      const out = await gracefulQuit(handle, { budgetMs: 10_000, graceMs: 10_000 });
      expect(out).toBe('killed');
      // 远小于 20s，说明没等满预算
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(stop).toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('上限 = budget + grace：预算被调大时等待时间同比变长（D2-4）', async () => {
    const { server, port } = await serveShutdown(202);
    try {
      const { handle } = fakeHandle(port); // 永不退出
      const started = Date.now();
      const out = await gracefulQuit(handle, { budgetMs: 150, graceMs: 100 });
      const elapsed = Date.now() - started;
      expect(out).toBe('killed');
      // 至少要等满 250ms（留 100ms 调度余量），证明不是固定短超时
      expect(elapsed).toBeGreaterThanOrEqual(220);
    } finally {
      await close(server);
    }
  });
});

describe('killTree', () => {
  it('没有 pid 时返回 false（不执行任何杀进程命令）', () => {
    expect(killTree(undefined)).toBe(false);
  });
});

describe('installSingleInstance：单实例锁', () => {
  function fakeApp(hasLock: boolean): SingleInstanceApp & { listeners: number } {
    const app = {
      listeners: 0,
      requestSingleInstanceLock: () => hasLock,
      on: (_e: 'second-instance', _l: () => void) => {
        app.listeners += 1;
      },
    };
    return app;
  }

  it('拿到锁 → true 且注册 second-instance 回调', () => {
    const app = fakeApp(true);
    const onSecond = vi.fn();
    expect(installSingleInstance(app, onSecond)).toBe(true);
    expect(app.listeners).toBe(1);
  });

  it('拿不到锁 → false 且不注册回调（调用方应退出）', () => {
    const app = fakeApp(false);
    expect(installSingleInstance(app, vi.fn())).toBe(false);
    expect(app.listeners).toBe(0);
  });
});
