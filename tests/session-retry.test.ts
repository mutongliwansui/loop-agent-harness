/**
 * 20261106-005 P1：POST /sessions/:id/retry 端到端测试
 *
 * 覆盖（D2/D12/D13）：
 * - 会话不存在 → 404
 * - seq 非整数/越界/指向用户消息 → 400
 * - 运行中 → 409
 * - 重试第一轮回答 → 存储截断为 system+新用户+新回答，runAgent 收到原用户文本且历史为空
 * - 重试最后一轮回答 → 只删除最后一轮，之前轮次保留（runAgent 收到 2 条历史）
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { AgentOptions, ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-session-retry');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

type Res = Awaited<ReturnType<typeof fetch>>;
type Detail = { meta: { title?: string; messageCount?: number }; messages: ChatMessage[] };

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);
let base = '';
let store: SessionStore;
let server: ApiServer;

/** 每次 run 收到的入参（断言重试文本与截断后的历史） */
let lastInput = '';
let lastOptions: AgentOptions | null = null;

/** 默认行为：模拟 agent 回一条固定格式回答并落盘本轮消息 */
let runImpl: (sessionId: string, input: string, options: AgentOptions) => Promise<unknown> = async (
  _sessionId,
  input,
  options,
) => {
  lastInput = input;
  lastOptions = options;
  const result = {
    answer: `答：${input}`,
    steps: [],
    iterations: 1,
    messages: [
      { role: 'user', content: input },
      { role: 'assistant', content: `答：${input}` },
    ],
  };
  for (const ev of options.events ?? []) await ev.onEnd?.(result);
  return result;
};

async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createSession(): Promise<string> {
  const res = await req('POST', '/sessions', { workspacePath: TEST_WORKSPACE });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function detail(id: string): Promise<Detail> {
  const res = await req('GET', `/sessions/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
}

/**
 * 发一轮消息并等待服务端释放 inFlight：
 * SSE 响应在 res.end() 时即结束，而 handler 的 finally 紧随其后；留出一次事件循环余量，
 * 否则紧接着的 retry 可能被误判为「运行中」→ 409。
 */
async function postMessage(id: string, message: string): Promise<void> {
  const res = await req('POST', `/sessions/${id}/messages`, { message });
  expect(res.status).toBe(200);
  await res.text();
  await new Promise((r) => setTimeout(r, 120));
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = new SessionStore(TEST_WORKSPACE, false, TEST_DIR);
  await store.init();
  config = { ...config, api: { ...config.api, port: 0 } };
  server = createApiServer({
    runAgent: (sessionId, input, options) => runImpl(sessionId, input, options),
    sessionStore: store,
    getConfig: () => config,
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  lastInput = '';
  lastOptions = null;
});

describe('POST /sessions/:id/retry', () => {
  it('会话不存在 → 404', async () => {
    const res = await req('POST', '/sessions/sess_missing/retry', { seq: 1 });
    expect(res.status).toBe(404);
  });

  it('seq 非法 / 越界 / 指向用户消息 → 400', async () => {
    const id = await createSession();
    await postMessage(id, '第一问');

    const bad = await req('POST', `/sessions/${id}/retry`, { seq: '1' });
    expect(bad.status).toBe(400);

    const outOfRange = await req('POST', `/sessions/${id}/retry`, { seq: 99 });
    expect(outOfRange.status).toBe(400);

    // [0]=user, [1]=assistant：seq=0 指向用户消息
    const onUser = await req('POST', `/sessions/${id}/retry`, { seq: 0 });
    expect(onUser.status).toBe(400);
  });

  it('重试第一轮回答 → 截断其后全部消息并以原文本重发', async () => {
    const id = await createSession();
    await postMessage(id, '第一问');
    await postMessage(id, '第二问');

    const before = await detail(id);
    const visible = before.messages.filter((m) => m.role !== 'system');
    expect(visible.length).toBe(4); // u1 a1 u2 a2

    const res = await req('POST', `/sessions/${id}/retry`, { seq: 1 });
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('event: done');

    // 后端以存储中的用户原文重发，且截断后历史为空
    expect(lastInput).toBe(visible[0].content);
    expect((lastOptions?.messages ?? []).length).toBe(0);

    const after = await detail(id);
    const afterVisible = after.messages.filter((m) => m.role !== 'system');
    expect(afterVisible.length).toBe(2);
    expect(afterVisible[0].content).toBe(visible[0].content);
    expect(afterVisible[1].content).toBe(`答：${visible[0].content}`);
  });

  it('重试最后一轮回答 → 保留之前轮次，只重建最后一轮', async () => {
    const id = await createSession();
    await postMessage(id, '第一问');
    await postMessage(id, '第二问');

    const before = await detail(id);
    const visible = before.messages.filter((m) => m.role !== 'system');
    // seq=3 → 最后一轮 assistant；向前找 [2] 用户消息
    const res = await req('POST', `/sessions/${id}/retry`, { seq: 3 });
    expect(res.status).toBe(200);
    await res.text();

    expect(lastInput).toBe(visible[2].content);
    expect((lastOptions?.messages ?? []).length).toBe(2); // u1 a1 保留

    const after = await detail(id);
    const afterVisible = after.messages.filter((m) => m.role !== 'system');
    expect(afterVisible.length).toBe(4);
    expect(afterVisible[0].content).toBe(visible[0].content);
    expect(afterVisible[1].content).toBe(visible[1].content);
    expect(afterVisible[2].content).toBe(visible[2].content);
    expect(afterVisible[3].content).toBe(`答：${visible[2].content}`);
  });

  it('运行中 → 409', async () => {
    const id = await createSession();
    // 先制造一轮已完成历史
    await postMessage(id, '第一问');
    // 再挂起一个 run（不结束）
    let release: (() => void) | null = null;
    runImpl = async (_sessionId, input, options) => {
      lastOptions = options;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const result = {
        answer: 'late',
        steps: [],
        iterations: 1,
        messages: [
          { role: 'user', content: input },
          { role: 'assistant', content: 'late' },
        ],
      };
      for (const ev of options.events ?? []) await ev.onEnd?.(result);
      return result;
    };
    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '挂起中' });
    // 等 inFlight 生效（runAgent 已被调用）
    for (let i = 0; i < 40 && !release; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(release).not.toBeNull();

    const res = await req('POST', `/sessions/${id}/retry`, { seq: 1 });
    expect(res.status).toBe(409);

    (release as unknown as () => void)();
    await postPromise;
  });
});
