/**
 * 跨工作空间并行调度验收（Task-20261021-010-04 P1/P2）
 *
 * 覆盖：
 * - 6.2.1 A 空间 run 进行中，B 空间 POST /sessions 成功（不再 busy）
 * - 6.2.2 A 空间 run 进行中，DELETE B 空间会话成功
 * - 6.2.3 A 空间 run 进行中，DELETE A 空间同一会话仍 busy
 * - 6.2.4 GET /sessions/:id（跨空间）switched === false，不切换空间
 * - 6.2.5 POST /sessions/:id/messages（跨空间）使用该会话所属空间的 runAgent/store
 * - 6.2.6 两空间 run 并行时 /workspaces 的 running 标记各自正确
 * - 6.3.1 Semaphore 超上限排队而非失败，active <= max（FIFO）
 * - 6.3.2 LOOP_AGENT_MAX_CONCURRENCY 非法值回退 8
 * - 6.3.3 /workspaces 的 current 随最近使用指针变化（D9）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { Semaphore } from '../src/api/semaphore.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-cross-workspace-parallel');
const USER_DIR = join(ROOT, 'user');
const WS_A = join(ROOT, 'ws-a');
const WS_B = join(ROOT, 'ws-b');

let registry: WorkspaceRegistry;
let server: ApiServer;
let base = '';
let rootA = '';
let rootB = '';

/** A 空间 run 的挂起闸门（releaseA 调用后放行） */
let releaseA: () => void = () => {};
/** 记录每次 run 的归属 root 与 sessionId（断言 6.2.5 落点） */
const runCalls: { root: string; sessionId: string; input: string }[] = [];

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** 轮询等待条件成立（最长 3s） */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
}

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });
  rootA = await canonicalWorkspacePath(WS_A);
  rootB = await canonicalWorkspacePath(WS_B);

  registry = new WorkspaceRegistry({
    userDir: USER_DIR,
    // 单测缝：按空间注入假 runAgent（A 空间挂起、B 空间即时回复），避免真实 LLM 调用
    runAgentFactory: (root) => async (sessionId, input) => {
      runCalls.push({ root, sessionId, input });
      if (root === rootA) {
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
      }
      return {
        answer: `回复:${input}`,
        steps: [],
        iterations: 1,
        messages: [
          { role: 'user', content: input },
          { role: 'assistant', content: `回复:${input}` },
        ],
      };
    },
  });
  const rt = await registry.get(rootA);
  const cfg: AgentConfig = { ...structuredClone(DEFAULT_CONFIG), api: { ...DEFAULT_CONFIG.api, port: 0 } };
  server = createApiServer({
    // 带 registry 时消息路由不应落到 deps.runAgent（6.2.5 反证）
    runAgent: async () => {
      throw new Error('不应走 deps.runAgent（应按 sessionId 路由到归属 runtime）');
    },
    sessionStore: rt.store,
    sessions: rt.sessions,
    getConfig: () => cfg,
    version: 'test-0.0.0',
    runtime: {
      configLoader: rt.configLoader,
      configWriter: rt.configWriter,
      createMemoryKit: () => rt.getMemoryKit(),
    },
    registry,
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  registry.reset();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放延迟：残留临时目录不影响测试结果
  }
});

describe('6.2 跨空间并行调度', () => {
  it('A 空间 run 进行中：B 空间增删会话/发消息均不 busy，A 空间同会话删除仍 busy', { timeout: 20000 }, async () => {
    // 两空间各建一个会话（id 命名空间互不相同，6.1.3 顺带覆盖）
    const resA = await req('POST', '/sessions', { title: 'A会话', workspacePath: WS_A });
    expect(resA.status).toBe(201);
    const sA = (await resA.json()) as { id: string };
    const resB = await req('POST', '/sessions', { title: 'B会话', workspacePath: WS_B });
    expect(resB.status).toBe(201);
    const sB = (await resB.json()) as { id: string };
    expect(sA.id.startsWith(`sess_${workspaceId(rootA).slice(0, 8)}_`)).toBe(true);
    expect(sB.id.startsWith(`sess_${workspaceId(rootB).slice(0, 8)}_`)).toBe(true);

    // 启动 A 空间的长 run（挂起直到 releaseA）
    const runP = req('POST', `/sessions/${sA.id}/messages`, { message: '长任务', stream: false });
    await waitFor(() => runCalls.some((c) => c.sessionId === sA.id));

    // 6.2.6：A 的会话 running=true，B 的 running=false
    const wsRes = await req('GET', '/workspaces');
    const wsBody = (await wsRes.json()) as {
      workspaces: { id: string; sessions: { id: string; running: boolean }[] }[];
    };
    const wsOfA = wsBody.workspaces.find((w) => w.id === workspaceId(rootA))!;
    const wsOfB = wsBody.workspaces.find((w) => w.id === workspaceId(rootB))!;
    expect(wsOfA.sessions.find((s) => s.id === sA.id)!.running).toBe(true);
    expect(wsOfB.sessions.find((s) => s.id === sB.id)!.running).toBe(false);

    // 6.2.1：A 运行中，B 空间新建会话不再 busy
    const resB2 = await req('POST', '/sessions', { title: 'B会话2', workspacePath: WS_B });
    expect(resB2.status).toBe(201);
    const sB2 = (await resB2.json()) as { id: string };

    // 6.2.4：查看 B 空间会话 → switched 恒 false，不切换空间
    const detail = await req('GET', `/sessions/${sB.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      workspace: { id: string; switched: boolean };
    };
    expect(detailBody.workspace.switched).toBe(false);
    expect(detailBody.workspace.id).toBe(workspaceId(rootB));

    // 6.2.5：A 运行中，向 B 空间会话发消息 → 走 B 空间的 runAgent，正常完成
    const msgB = await req('POST', `/sessions/${sB.id}/messages`, { message: '你好B', stream: false });
    expect(msgB.status).toBe(200);
    const msgBBody = (await msgB.json()) as { answer: string };
    expect(msgBBody.answer).toBe('回复:你好B');
    expect(runCalls.some((c) => c.sessionId === sB.id && c.root === rootB)).toBe(true);
    // 落盘在 B 空间目录（store 视角断言）
    const rtB = registry.peek(rootB)!;
    const storedB = await rtB.store.loadSession(sB.id);
    expect(storedB.messages.some((m) => m.content === '你好B')).toBe(true);

    // 6.2.2：A 运行中，删除 B 空间会话成功
    const delB2 = await req('DELETE', `/sessions/${sB2.id}`);
    expect(delB2.status).toBe(200);

    // 6.2.3：A 运行中，删除 A 空间同一会话仍 busy
    const delA = await req('DELETE', `/sessions/${sA.id}`);
    expect(delA.status).toBe(409);
    const delABody = (await delA.json()) as { error: { code: string } };
    expect(delABody.error.code).toBe('busy');

    // 放行 A 的 run：正常完成
    releaseA();
    const runRes = await runP;
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { answer: string };
    expect(runBody.answer).toBe('回复:长任务');

    // A 的 run 结束后：删除 A 会话成功
    const delA2 = await req('DELETE', `/sessions/${sA.id}`);
    expect(delA2.status).toBe(200);
  });
});

describe('6.3 全局并发信号量（D18）', () => {
  it('6.3.1 并发超过上限时排队而非失败，active 始终 <= max（FIFO 先到先得）', async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let maxSeen = 0;
    const order: number[] = [];
    const task = (i: number) =>
      gate.run(async () => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        order.push(i);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      });
    // 5 个任务、上限 2：全部成功、峰值不超 2、FIFO 启动顺序
    await Promise.all([task(0), task(1), task(2), task(3), task(4)]);
    expect(maxSeen).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
  });

  it('6.3.2 LOOP_AGENT_MAX_CONCURRENCY 非法值回退 8；合法值生效', () => {
    const prev = process.env.LOOP_AGENT_MAX_CONCURRENCY;
    try {
      process.env.LOOP_AGENT_MAX_CONCURRENCY = 'abc';
      const bad = new WorkspaceRegistry({ userDir: USER_DIR });
      expect(bad.maxConcurrency).toBe(8); // min(4×4, 8)

      process.env.LOOP_AGENT_MAX_CONCURRENCY = '3';
      const good = new WorkspaceRegistry({ userDir: USER_DIR });
      expect(good.maxConcurrency).toBe(3); // min(4×4, 3)
    } finally {
      if (prev === undefined) delete process.env.LOOP_AGENT_MAX_CONCURRENCY;
      else process.env.LOOP_AGENT_MAX_CONCURRENCY = prev;
    }
  });

  it('6.3.3 /workspaces 的 current 随最近使用指针变化（D9）', async () => {
    // 上一用例已把指针带到 B（GET /sessions/:id 经 locateSession 取用 B 的 runtime）
    const res = await req('GET', '/workspaces');
    const body = (await res.json()) as { workspaces: { id: string; current: boolean }[] };
    expect(body.workspaces.find((w) => w.current)?.id).toBe(workspaceId(rootB));

    // 显式在 A 空间创建会话 → 指针回到 A
    const create = await req('POST', '/sessions', { title: '回A', workspacePath: WS_A });
    expect(create.status).toBe(201);
    const res2 = await req('GET', '/workspaces');
    const body2 = (await res2.json()) as { workspaces: { id: string; current: boolean }[] };
    expect(body2.workspaces.find((w) => w.current)?.id).toBe(workspaceId(rootA));
  });
});
