/**
 * GET /sessions/:id/stream（attach 续传）测试（Task-20261021-001 P0）
 *
 * 覆盖：
 * 1. 无 run → 204；会话不存在 → 404
 * 2. run 中：/workspaces 注入 running、/sessions/:id 注入 run、attach 回放已发生事件并续传实时事件
 * 3. 客户端断开 POST 流后 run 继续完成，重连可回放全量事件与终态
 * 4. run 结束后保留期内 attach → 回放终态后关流
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { AgentOptions, AgentResult, ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-stream-attach');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

type Res = Awaited<ReturnType<typeof fetch>>;

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);

/** 可控闸门：run 在 emit onStart 后挂起，由测试决定何时继续 */
let openGate: (() => void) | null = null;
let gate: Promise<void> = Promise.resolve();
let started = false;

function makeResult(answer: string, input: string): AgentResult {
  return {
    answer,
    steps: [{ thought: `思考:${input}` }],
    iterations: 1,
    messages: [
      { role: 'user', content: input },
      { role: 'assistant', content: answer },
    ] as ChatMessage[],
  };
}

const runAgent = async (input: string, options: AgentOptions): Promise<AgentResult> => {
  for (const ev of options.events ?? []) await ev.onStart?.(input);
  started = true;
  await gate;
  const result = makeResult(`回复:${input}`, input);
  for (const ev of options.events ?? []) {
    await ev.onLLMStream?.('片段');
    await ev.onEnd?.(result);
  }
  return result;
};

/** 解析 SSE 响应体（保留 id 行），用于断言 seq 连续性 */
async function readSse(res: Res): Promise<{ id?: number; event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim() && !block.trim().startsWith(':'))
    .map((block) => {
      let id: number | undefined;
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) id = Number(line.slice(4));
        else if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      return { id, event, data: JSON.parse(data) };
    });
}

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
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function jsonOf(res: Res): Promise<any> {
  return res.json();
}

async function createSessionViaApi(): Promise<string> {
  const res = await req('POST', '/sessions');
  expect(res.status).toBe(201);
  return ((await jsonOf(res)) as { id: string }).id;
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = new SessionStore(TEST_WORKSPACE, false, TEST_DIR);
  await store.init();

  config = { ...config, api: { ...config.api, port: 0 } };
  server = createApiServer({ runAgent, sessionStore: store, getConfig: () => config });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  started = false;
  openGate = null;
  gate = Promise.resolve();
});

describe('GET /sessions/:id/stream', () => {
  it('无运行记录 → 204', async () => {
    const id = await createSessionViaApi();
    const res = await req('GET', `/sessions/${id}/stream?cursor=0`);
    expect(res.status).toBe(204);
  });

  it('会话不存在 → 404', async () => {
    const res = await req('GET', '/sessions/sess_unknown/stream');
    expect(res.status).toBe(404);
  });

  it('run 中：/workspaces 与 /sessions/:id 暴露运行状态，attach 回放并续传', async () => {
    const id = await createSessionViaApi();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    // 发起流式消息（不等待完成）
    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '你好', stream: true }).then(readSse);
    await waitFor(() => started);

    // 运行中标记
    const ws = await req('GET', '/workspaces');
    const workspaces = ((await jsonOf(ws)) as { workspaces: { sessions: { id: string; running?: boolean }[] }[] }).workspaces;
    expect(workspaces.flatMap((w) => w.sessions).find((s) => s.id === id)?.running).toBe(true);

    const detail = await req('GET', `/sessions/${id}`);
    expect((await jsonOf(detail)).run).toMatchObject({ status: 'running' });

    // cursor=0：回放已发生的 start，然后等待实时事件与终态
    const attachPromise = req('GET', `/sessions/${id}/stream?cursor=0`).then(readSse);
    await new Promise((r) => setTimeout(r, 50));
    openGate?.();

    const attachEvents = await attachPromise;
    const postEvents = await postPromise;

    expect(attachEvents.map((e) => e.event)).toEqual(['start', 'llm_stream', 'end', 'done']);
    expect(attachEvents.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    // POST 连接本身也是订阅者，收到同一批事件
    expect(postEvents.map((e) => e.event)).toEqual(['start', 'llm_stream', 'end', 'done']);
  });

  it('客户端断开 POST 流后 run 继续完成，重连回放全量事件', async () => {
    const id = await createSessionViaApi();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const ac = new AbortController();
    const aborted = fetch(`${base}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '长任务', stream: true }),
      signal: ac.signal,
    }).catch(() => null);
    await waitFor(() => started);
    ac.abort(); // 模拟切页面/刷新导致的连接断开
    await aborted;

    openGate?.();
    // run 不受断连影响；用 /workspaces 轮询运行标记（避免与落盘 rename 抢会话文件读锁）
    await waitFor(async () => {
      const ws = await req('GET', '/workspaces');
      const workspaces = ((await jsonOf(ws)) as {
        workspaces: { sessions: { id: string; running?: boolean }[] }[];
      }).workspaces;
      return workspaces.flatMap((w) => w.sessions).find((s) => s.id === id)?.running === false;
    });

    const replay = await readSse(await req('GET', `/sessions/${id}/stream?cursor=0`));
    expect(replay.map((e) => e.event)).toEqual(['start', 'llm_stream', 'end', 'done']);
    expect(replay.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it('cursor 命中已有 seq 时只回放其后的增量', async () => {
    const id = await createSessionViaApi();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const postPromise = req('POST', `/sessions/${id}/messages`, { message: '增量', stream: true }).then(readSse);
    await waitFor(() => started);
    openGate?.();
    await postPromise;

    const replay = await readSse(await req('GET', `/sessions/${id}/stream?cursor=2`));
    expect(replay.map((e) => e.id)).toEqual([3, 4]);
    expect(replay.map((e) => e.event)).toEqual(['end', 'done']);
  });
});
