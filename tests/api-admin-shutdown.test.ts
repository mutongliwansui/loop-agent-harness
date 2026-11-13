// POST /admin/shutdown 端点守卫矩阵与幂等单测（任务 20261112-007-02）
//
// 覆盖点对应设计决策：
// - D2-3 自定义头守卫（防网页 CSRF）：缺头/错头 → 403，且**不得触发关停**
// - 未注入 requestShutdown → 501（既有单测/嵌入用法不崩）
// - 首次触发 → 202 + 调用一次；重复触发 → 409 且不重复调用
// - 鉴权前置：配了 token 时缺 Bearer 先被 401 拦下，不会走到 handler
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer, type ApiServer, type ApiServerDeps } from '../src/api/server.js';
import { createShutdownState } from '../src/api/shutdown.js';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '../src/api/handlers/admin.js';
import { SessionStore } from '../src/session/index.js';

describe('POST /admin/shutdown', () => {
  let dir: string;
  let api: ApiServer | null = null;
  let baseUrl = '';
  /** requestShutdown 被调用的次数（端点每次都会询问状态机） */
  let calls: string[] = [];
  /** 其中「首次触发」的次数（真实语义：状态机只会让一次返回 true） */
  let accepted = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admin-shutdown-'));
    calls = [];
    accepted = 0;
    api = null;
    baseUrl = '';
  });

  afterEach(async () => {
    if (api) await api.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  /** 起真实 http server（走完整路由 + 鉴权链路） */
  async function boot(opts: { token?: string; withShutdown?: boolean } = {}): Promise<void> {
    const store = new SessionStore(join(dir, 'workspace'), false, dir);
    const deps: ApiServerDeps = {
      runAgent: async () => ({ text: '' }) as never,
      sessionStore: store,
      getConfig: () =>
        ({
          api: { host: '127.0.0.1', port: 0, token: opts.token ?? '', webRoot: '' },
          model: { name: 'test-model' },
          memory: { dreaming: { shutdownBudgetMs: 1000 } },
          webui: { terminal: false },
        }) as never,
      log: () => {},
    };
    if (opts.withShutdown !== false) {
      deps.requestShutdown = (reason: string) => {
        calls.push(reason);
        if (calls.length > 1) return false; // 模拟状态机幂等：只有首次返回 true
        accepted += 1;
        return true;
      };
    }
    api = createApiServer(deps);
    const { port } = await api.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  async function post(headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/admin/shutdown`, { method: 'POST', headers });
  }

  const H = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE };

  it('缺自定义头 → 403，且不触发关停', async () => {
    await boot();
    const res = await post();
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('自定义头值错误 → 403，且不触发关停', async () => {
    await boot();
    const res = await post({ [CLIENT_HEADER]: 'browser' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('带正确头 → 202 且触发一次', async () => {
    await boot();
    const res = await post(H);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, shuttingDown: true });
    expect(accepted).toBe(1);
  });

  it('重复调用 → 409 且不重复触发', async () => {
    await boot();
    expect((await post(H)).status).toBe(202);
    const res2 = await post(H);
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ ok: false, code: 'ALREADY_SHUTTING_DOWN' });
    // 关键：只有首次被受理，重复请求不得再次触发关停
    expect(accepted).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('未注入 requestShutdown → 501（不崩溃）', async () => {
    await boot({ withShutdown: false });
    const res = await post(H);
    expect(res.status).toBe(501);
  });

  it('配置了 token 时：缺 Bearer 即使带头也被鉴权拦下（401）', async () => {
    await boot({ token: 'tk' });
    const res = await post(H);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('配置了 token 时：带头 + 正确 Bearer → 202', async () => {
    await boot({ token: 'tk' });
    const res = await post({ ...H, authorization: 'Bearer tk' });
    expect(res.status).toBe(202);
    expect(accepted).toBe(1);
  });

  it('GET /admin/shutdown → 405（只接受 POST）', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/admin/shutdown`);
    expect(res.status).toBe(405);
  });
});

describe('createShutdownState', () => {
  it('首次 request 返回 true 并异步启动序列，重复返回 false 且不重复启动', async () => {
    const reasons: string[] = [];
    const st = createShutdownState((r) => reasons.push(r));

    expect(st.request('first')).toBe(true);
    expect(st.shuttingDown).toBe(true);
    expect(st.request('second')).toBe(false);
    expect(st.request('third')).toBe(false);

    // 序列经 setImmediate 延后（D2-2：先把 HTTP 响应写出去）
    expect(reasons).toHaveLength(0);
    await new Promise<void>((r) => setImmediate(r));
    expect(reasons).toEqual(['first']);
  });

  it('未触发前 shuttingDown 为 false', () => {
    const st = createShutdownState(() => {});
    expect(st.shuttingDown).toBe(false);
  });
});
