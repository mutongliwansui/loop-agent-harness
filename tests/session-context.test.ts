/**
 * 20261106-005 P0：GET /sessions/:id/context 端到端测试
 *
 * 覆盖：
 * - 未运行过的会话 → source='estimate'（按历史消息估算）
 * - 跑过一轮并收到 llm_stats → source='stats'（真实 prompt_tokens，带 updatedAt）
 * - maxTokens<=0 → percent=0（不除零）
 * - 会话不存在 → 404
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { AgentOptions } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-session-context');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

type Res = Awaited<ReturnType<typeof fetch>>;
type ContextBody = {
  contextTokens: number;
  maxTokens: number;
  threshold: number;
  percent: number;
  keepRecentTurns: number;
  source: 'stats' | 'estimate';
  updatedAt?: string;
};

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);
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

async function createSession(): Promise<string> {
  const res = await req('POST', '/sessions');
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 发一轮消息并读完 SSE：确保 run 已完成（响应头先于 run 结束，必须消费 body） */
async function postMessage(id: string, message: string): Promise<void> {
  const res = await req('POST', `/sessions/${id}/messages`, { message });
  expect(res.status).toBe(200);
  await res.text();
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = new SessionStore(TEST_WORKSPACE, false, TEST_DIR);
  await store.init();
  config = { ...structuredClone(DEFAULT_CONFIG), api: { ...DEFAULT_CONFIG.api, port: 0 } };
  server = createApiServer({
    runAgent: async (_sessionId, input, options: AgentOptions) => {
      // 「估算」开头的输入：不发送 llm_stats，用于验证估算兜底分支
      if (!input.startsWith('估算')) {
        for (const ev of options.events ?? []) {
          await ev.onLLMStats?.({
            iteration: 1,
            maxIterations: 5,
            contextTokens: 12000,
            contextMaxTokens: 200000,
            contextThreshold: 160000,
            promptTokens: 12000,
            completionTokens: 100,
            totalTokens: 12100,
            elapsedMs: 120,
          });
        }
      }
      const answer = input.startsWith('估算')
        ? `答${'y'.repeat(4000)}`
        : '收到';
      const result = {
        answer,
        steps: [],
        iterations: 1,
        messages: [
          { role: 'user', content: input },
          { role: 'assistant', content: answer },
        ],
      };
      for (const ev of options.events ?? []) await ev.onEnd?.(result);
      return result;
    },
    sessionStore: store,
    getConfig: () => config,
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

describe('GET /sessions/:id/context', () => {
  it('会话不存在 → 404', async () => {
    const res = await req('GET', '/sessions/sess_nope/context');
    expect(res.status).toBe(404);
  });

  it('未收到 llm_stats → 估算兜底（source=estimate）', async () => {
    const id = await createSession();
    // 「估算」开头的输入让 mock 不发送 llm_stats，历史中留存 4000+ 字符消息
    await postMessage(id, `估算${'x'.repeat(4000)}`);
    const res = await req('GET', `/sessions/${id}/context`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;
    expect(body.source).toBe('estimate');
    expect(body.maxTokens).toBe(config.memory.working.maxTokens);
    expect(body.threshold).toBe(
      Math.round(config.memory.working.maxTokens * config.memory.working.compactionThreshold),
    );
    expect(body.keepRecentTurns).toBe(config.memory.working.keepRecentTurns);
    // 前后各约 4000 字符 ≈ 1000 token
    expect(body.contextTokens).toBeGreaterThan(1500);
    expect(body.percent).toBeGreaterThan(0);
    expect(body.updatedAt).toBeUndefined();
  });

  it('收到 llm_stats 后 → 真实统计（source=stats，带 updatedAt）', async () => {
    const id = await createSession();
    await postMessage(id, '你好');
    const res = await req('GET', `/sessions/${id}/context`);
    const body = (await res.json()) as ContextBody;
    expect(body.source).toBe('stats');
    expect(body.contextTokens).toBe(12000);
    expect(body.maxTokens).toBe(200000);
    expect(body.threshold).toBe(160000);
    expect(body.percent).toBe(6);
    expect(typeof body.updatedAt).toBe('string');
  });

  it('maxTokens<=0 → percent=0（不除零）', async () => {
    const id = await createSession();
    await postMessage(id, `估算${'x'.repeat(400)}`);
    const saved = config.memory.working.maxTokens;
    config = {
      ...config,
      memory: {
        ...config.memory,
        working: { ...config.memory.working, maxTokens: 0 },
      },
    };
    try {
      const res = await req('GET', `/sessions/${id}/context`);
      const body = (await res.json()) as ContextBody;
      expect(body.maxTokens).toBe(0);
      expect(body.percent).toBe(0);
    } finally {
      config = {
        ...config,
        memory: { ...config.memory, working: { ...config.memory.working, maxTokens: saved } },
      };
    }
  });
});
