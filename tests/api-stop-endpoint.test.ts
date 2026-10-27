/**
 * POST /sessions/:id/stop 端到端测试（Task-20261021-002-03 P1）
 *
 * 覆盖（任务文档 6.2）：
 * - 6.2.1 404：会话不存在
 * - 6.2.2 204：会话存在但无 running run
 * - 6.2.3 202：running run → signal.aborted 置位，runAgent 收到 signal（D8 注入）
 * - 6.2.4 重复 /stop：202 + alreadyAborting:true
 * - 6.2.5 abort 后 attach 收到 aborted 事件并关流
 * - 6.2.6 落盘后 GET /sessions/:id 每个 tool_calls 都有对应 tool 响应（封口生效）
 * - 6.2.7 partial 落盘抛错 → 收到 warning 事件且响应仍 200 正常结束
 * - 6.1.2 幂等（RunHub 层已单测；此处验证重复 HTTP 请求不 500）
 *
 * mock runAgent：模拟真实 agent 的取消行为——监听 options.signal，aborted 后
 * 抛 AgentAbortedError（partial 为带孤立 tool_calls 的快照），与 task-02 主循环语义一致。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { AgentAbortedError, type AgentOptions, type ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-stop');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

type Res = Awaited<ReturnType<typeof fetch>>;

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);

/** 当前正在跑的 run 的 AgentOptions（测试用来读 signal / 定制行为） */
let liveOptions: AgentOptions | null = null;
/** runAgent 行为钩子（每个用例自定义；05：签名含 sessionId） */
let runImpl: (sessionId: string, input: string, options: AgentOptions) => Promise<unknown> = async () => {
  throw new Error('not configured');
};

/** 默认行为：发 onStart 后挂起直到 abort，然后抛 AgentAbortedError（快照带孤立 tool_calls） */
const hangingAgent = async (_sessionId: string, input: string, options: AgentOptions): Promise<unknown> => {
  liveOptions = options;
  for (const ev of options.events ?? []) await ev.onStart?.(input);
  await new Promise<void>((resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      reject(
        new AgentAbortedError({
          messages: [
            { role: 'user', content: input },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_orphan_1', type: 'function', function: { name: 'fileRead', arguments: '{}' } },
              ],
            } as unknown as ChatMessage,
          ],
          transcript: [{ role: 'user', content: input }],
          steps: [{ thought: 'a', observation: 'b' }],
          iterations: 1,
        }),
      );
    }, { once: true });
  });
  return null;
};

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let base = '';
let store: SessionStore;
let server: ApiServer;

async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function createSessionViaApi(): Promise<string> {
  const res = await req('POST', '/sessions');
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
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
  liveOptions = null;
  runImpl = async () => {
    throw new Error('not configured');
  };
});

describe('POST /sessions/:id/stop', () => {
  it('6.2.1 会话不存在 → 404', async () => {
    const res = await req('POST', '/sessions/sess_unknown/stop');
    expect(res.status).toBe(404);
  });

  it('6.2.2 会话存在但无 running run → 204 幂等', async () => {
    const id = await createSessionViaApi();
    // 从未运行
    const res1 = await req('POST', `/sessions/${id}/stop`);
    expect(res1.status).toBe(204);
    // 跑完一次后再停
    runImpl = async (input, options) => {
      const result = {
        answer: 'done',
        steps: [],
        iterations: 1,
        messages: [
          { role: 'user', content: input },
          { role: 'assistant', content: 'done' },
        ],
      };
      for (const ev of options.events ?? []) await ev.onEnd?.(result);
      return result;
    };
    const postRes = await req('POST', `/sessions/${id}/messages`, { message: '快速完成' });
    expect(postRes.status).toBe(200);
    const detail = await req('GET', `/sessions/${id}`);
    const runStatus = ((await detail.json()) as { run?: { status?: string } }).run?.status;
    // 落盘后 run 状态应已离开 running（finish('done') 已执行）
    expect(runStatus).toBe('done');
    const res2 = await req('POST', `/sessions/${id}/stop`);
    expect(res2.status).toBe(204);
  });

  it('6.2.3 running run → 202，runAgent 收到的 signal 被 abort 置位（D8）', async () => {
    const id = await createSessionViaApi();
    runImpl = hangingAgent;

    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '长任务', stream: true });
    await waitFor(() => liveOptions !== null, 8000);

    const stopRes = await req('POST', `/sessions/${id}/stop`);
    expect(stopRes.status).toBe(202);
    const body = (await stopRes.json()) as { runId: string; status: string; alreadyAborting?: boolean };
    expect(body.status).toBe('aborting');
    expect(body.alreadyAborting).toBeUndefined();
    expect(liveOptions?.signal?.aborted).toBe(true);

    // run 以 aborted 收尾：HTTP 仍 200（D7），响应体标记 aborted
    const postRes = await postPromise;
    expect(postRes.status).toBe(200);
    const text = await postRes.text();
    expect(text).toContain('event: aborted');
    expect(text).toContain('"partial":true');
  });

  it('6.2.4 重复 /stop → 202 + alreadyAborting:true（HTTP 层不 500）', async () => {
    const id = await createSessionViaApi();
    runImpl = hangingAgent;

    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '长任务', stream: true });
    await waitFor(() => liveOptions !== null, 8000);

    const stop1 = await req('POST', `/sessions/${id}/stop`);
    expect(stop1.status).toBe(202);
    const stop2 = await req('POST', `/sessions/${id}/stop`);
    expect(stop2.status).toBe(202);
    const body2 = (await stop2.json()) as { alreadyAborting?: boolean };
    expect(body2.alreadyAborting).toBe(true);

    await postPromise;
  });

  it('6.2.5 abort 后 attach 收到 aborted 事件并关流', async () => {
    const id = await createSessionViaApi();
    runImpl = hangingAgent;

    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '长任务', stream: true });
    await waitFor(() => liveOptions !== null, 8000);

    // attach：cursor=0 全量回放 + 实时续传
    const attachPromise = req('GET', `/sessions/${id}/stream?cursor=0`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));

    await req('POST', `/sessions/${id}/stop`);
    const [attachText, postRes] = await Promise.all([attachPromise, postPromise]);
    expect(postRes.status).toBe(200);

    const events = attachText
      .split('\n\n')
      .filter((b) => b.trim() && !b.trim().startsWith(':'))
      .map((b) => (b.match(/event: (.+)/) ?? [])[1]);
    expect(events[events.length - 1]).toBe('aborted'); // attach 连接已被终态关流
  });

  it('6.2.6 停止后落盘：每个 tool_calls 都有对应 tool 响应（封口生效）', async () => {
    const id = await createSessionViaApi();
    runImpl = hangingAgent;

    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '工具任务', stream: true });
    await waitFor(() => liveOptions !== null, 8000);
    await req('POST', `/sessions/${id}/stop`);
    await postPromise;

    // 落盘是异步完成的：轮询直到用户消息可见（落盘成功）
    // 超时放宽到 15s：全量套件满载时磁盘持久化 + 详情请求可能明显慢于空载，
    // 8s 曾在满负载回归里触发 waitFor 超时误报（用例串行跑必过，连跑 3 次验证）。
    await waitFor(async () => {
      const detail = await req('GET', `/sessions/${id}`);
      const data = (await detail.json()) as { messages: ChatMessage[] };
      return data.messages.some((m) => m.role === 'user');
    }, 15000);
    const detail = await req('GET', `/sessions/${id}`);
    const data = (await detail.json()) as { messages: ChatMessage[] };
    const declared: string[] = [];
    const answered = new Set<string>();
    for (const m of data.messages) {
      const calls = (m as { tool_calls?: { id: string }[] }).tool_calls;
      if (calls) declared.push(...calls.map((c) => c.id));
      const toolId = (m as { tool_call_id?: string }).tool_call_id;
      if (m.role === 'tool' && toolId) answered.add(toolId);
    }
    expect(declared).toEqual(['call_orphan_1']);
    expect(answered.has('call_orphan_1')).toBe(true); // 封口补齐，不报序列错误
  });

  it('6.2.7 partial 落盘抛错 → warning 事件下发且 HTTP 响应仍 200 正常结束', async () => {
    const id = await createSessionViaApi();
    runImpl = hangingAgent;

    // 令落盘失败：spy updateSession 让 aborted 分支的持久化调用抛错（不影响 GET 详情读取）
    const updateSession = store.updateSession.bind(store);
    const spy = vi
      .spyOn(store, 'updateSession')
      .mockImplementation(async (...args: unknown[]) => {
        // aborted 分支传 (id, sealed, message, {transcript})；仅中断本次，不影响其它调用
        throw new Error('mock 磁盘已满');
      });
    try {
      const postPromise = req('POST', `/sessions/${id}/messages`, { message: '落盘失败', stream: true });
      await waitFor(() => liveOptions !== null, 8000);

      const attachPromise = req('GET', `/sessions/${id}/stream?cursor=0`).then((r) => r.text());
      await new Promise((r) => setTimeout(r, 50));
      await req('POST', `/sessions/${id}/stop`);

      const [attachText, postRes] = await Promise.all([attachPromise, postPromise]);
      expect(postRes.status).toBe(200);
      expect(attachText).toContain('event: warning');
      expect(attachText).toContain('mock 磁盘已满');
      expect(attachText).toContain('event: aborted');
    } finally {
      spy.mockRestore();
      void updateSession;
    }
  });
});
