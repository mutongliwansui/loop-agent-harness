/**
 * 自定义 REST API 服务测试（Task-20261016-001）
 *
 * 测试内容：
 * 1. D6 鉴权三态：无 token 仅本机放行；有 token 强制 Bearer；非回环绑定且无 token 拒绝启动
 * 2. 健康探针与会话资源 CRUD（POST/GET/DELETE /sessions，404/405 边界）
 * 3. 非流式消息：resetHistory / 显式 messages 隔离、多会话隔离、持久化落盘
 * 4. SSE 流式：15 钩子事件序列与载荷、合成终态 done/fatal、error 非致命透传
 * 5. 边界码：400（缺字段/非法 JSON）、413（2MB 上限 + 排空策略）、409（会话级互斥 + in-flight 删除）
 * 6. 重启恢复：close 后同 SessionStore 新建 server，历史从落盘恢复注入 runAgent
 *
 * D9：全部通过 createApiServer(deps) 依赖注入，起真实 http server（port 0），fetch 断言。
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { AgentOptions, AgentResult, ChatMessage, CompactionInfo, LLMResponse, LLMStats, LLMStatsSummary } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-server');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

type Res = Awaited<ReturnType<typeof fetch>>;

// ===== 测试依赖（fake runAgent + 临时目录 SessionStore + 可变配置） =====

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);

/** 默认 runAgent：构造单步结果并按顺序触发全部 15 个事件钩子 */
const defaultImpl = async (input: string, options: AgentOptions): Promise<AgentResult> => {
  const result = makeResult(`回复:${input}`, input, options.messages ?? []);
  await emitAll(input, options, result);
  return result;
};

let runAgentImpl: (input: string, options: AgentOptions) => Promise<AgentResult> = defaultImpl;

/** 记录每次 runAgent 调用的入参 */
const calls: { input: string; options: AgentOptions }[] = [];

const runAgent = async (input: string, options: AgentOptions): Promise<AgentResult> => {
  calls.push({ input, options });
  return runAgentImpl(input, options);
};

// ===== 构造工具 =====

/** 构造 AgentResult：1 步 + user/assistant 两条消息（拼在 prior 之后，模拟真实追加语义） */
function makeResult(answer: string, input: string, priorMessages: ChatMessage[] = []): AgentResult {
  return {
    answer,
    steps: [{ thought: `思考:${input}` }],
    iterations: 1,
    messages: [...priorMessages, { role: 'user', content: input }, { role: 'assistant', content: answer }],
  };
}

const LLM_RESPONSE: LLMResponse = {
  content: '部分回答',
  finish_reason: 'stop',
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const LLM_STATS: LLMStats = {
  iteration: 1,
  maxIterations: 25,
  contextTokens: 100,
  contextMaxTokens: 64000,
  contextThreshold: 48000,
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  elapsedMs: 20,
};

const LLM_SUMMARY: LLMStatsSummary = {
  iterations: 1,
  totalPrompt: 10,
  totalCompletion: 5,
  totalTokens: 15,
  totalCacheHit: 0,
  peakContextTokens: 100,
  peakContextMaxTokens: 64000,
};

const COMPACTION: CompactionInfo = {
  threshold: 48000,
  contextTokens: 50000,
  flushedChars: 1200,
  keptMessages: 8,
};

/** 按顺序触发全部 15 个 AgentEvents 钩子（含非致命 onError） */
async function emitAll(input: string, options: AgentOptions, result: AgentResult): Promise<void> {
  for (const ev of options.events ?? []) {
    await ev.onStart?.(input);
    await ev.onIterationStart?.(1, 25);
    await ev.onLLMStream?.('你好');
    await ev.onLLMStream?.('！');
    await ev.onLLMEnd?.(LLM_RESPONSE, 1);
    await ev.onLLMStats?.(LLM_STATS);
    await ev.onLLMStatsSummary?.(LLM_SUMMARY);
    await ev.onToolStart?.('echo', { x: 1 });
    await ev.onToolEnd?.('echo', 'ok');
    await ev.onToolProgress?.('echo', 100);
    await ev.onToolCallDelta?.('echo', 10, 50);
    await ev.onCompaction?.(COMPACTION);
    await ev.onFinal?.(result.answer);
    await ev.onError?.(new Error('非致命内部错误'));
    await ev.onEnd?.(result);
  }
}

/** 解析 SSE 响应体为事件数组（帧格式：event: X\ndata: {...}\n\n） */
async function readSse(res: Res): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      return { event, data: JSON.parse(data) };
    });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== HTTP 辅助 =====

let base = '';

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function jsonOf(res: Res): Promise<any> {
  return res.json();
}

/** 起一个测试 server；传入 cfgOverride 时冻结该配置（需自带 port:0），否则读活配置 */
async function startTestServer(cfgOverride?: AgentConfig): Promise<{ server: ApiServer; port: number }> {
  const server = createApiServer({
    runAgent,
    sessionStore: store,
    getConfig: () => cfgOverride ?? config,
    version: 'test-0.0.0',
  });
  const { port } = await server.start();
  return { server, port };
}

/** POST /sessions 创建会话，返回 id */
async function createSessionViaApi(): Promise<string> {
  const res = await req('POST', '/sessions');
  expect(res.status).toBe(201);
  return ((await jsonOf(res)) as { id: string }).id;
}

// ===== 全局夹具 =====

let store: SessionStore;
let server: ApiServer;

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // 加密关闭（避免 keychain 依赖），userDir 指向临时目录避免污染真实会话数据
  store = new SessionStore(TEST_WORKSPACE, 3, false, TEST_DIR);
  await store.init();

  // 主实例绑随机端口，避免占用默认 3000
  config = { ...config, api: { ...config.api, port: 0 } };
  const started = await startTestServer();
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  config = structuredClone(DEFAULT_CONFIG);
  runAgentImpl = defaultImpl;
  calls.length = 0;
});

// ===== 1. 鉴权（D6） =====

describe('鉴权（D6）', () => {
  it('未配置 token 时本机请求放行', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
  });

  it('配置 token 后：无 Bearer → 401', async () => {
    config = { ...config, api: { ...config.api, token: 'secret-token' } };
    const res = await req('GET', '/health');
    expect(res.status).toBe(401);
    const body = await jsonOf(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('配置 token 后：错误 Bearer → 401', async () => {
    config = { ...config, api: { ...config.api, token: 'secret-token' } };
    const res = await req('GET', '/health', undefined, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('配置 token 后：正确 Bearer → 200', async () => {
    config = { ...config, api: { ...config.api, token: 'secret-token' } };
    const res = await req('GET', '/health', undefined, { authorization: 'Bearer secret-token' });
    expect(res.status).toBe(200);
  });

  it('非回环绑定且无 token → start() 拒绝启动', async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.api = { port: 0, host: '0.0.0.0', token: '' };
    const { server: bare } = { server: createApiServer({ runAgent, sessionStore: store, getConfig: () => cfg }) };
    await expect(bare.start()).rejects.toThrow(/拒绝启动/);
  });
});

// ===== 2. 健康探针与会话资源 =====

describe('健康探针与会话资源', () => {
  it('GET /health 返回状态、版本与模型名', async () => {
    config = { ...config, model: { ...config.model, name: 'test-model' } };
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ status: 'ok', version: 'test-0.0.0', model: 'test-model' });
  });

  it('POST /sessions 创建空会话（201）并可查询列表与详情', async () => {
    const created = await createSessionViaApi();
    expect(created).toMatch(/^sess_/);

    const list = await req('GET', '/sessions');
    expect(list.status).toBe(200);
    const { sessions } = (await jsonOf(list)) as { sessions: { id: string }[] };
    expect(sessions.some((s) => s.id === created)).toBe(true);

    const detail = await req('GET', `/sessions/${created}`);
    expect(detail.status).toBe(200);
    const body = await jsonOf(detail);
    expect(body.meta.id).toBe(created);
    expect(body.messages).toEqual([]); // 空会话预填缓存
  });

  it('GET 不存在的会话 → 404', async () => {
    const res = await req('GET', '/sessions/sess_unknown');
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe('not_found');
  });

  it('DELETE 会话成功后 GET/DELETE 均 404', async () => {
    const id = await createSessionViaApi();
    const del = await req('DELETE', `/sessions/${id}`);
    expect(del.status).toBe(200);
    expect(await jsonOf(del)).toEqual({ deleted: true });

    expect((await req('GET', `/sessions/${id}`)).status).toBe(404);
    expect((await req('DELETE', `/sessions/${id}`)).status).toBe(404);
  });

  it('不支持的 method → 405；未知路径 → 404', async () => {
    expect((await req('GET', '/sessions/abc/messages')).status).toBe(405);
    expect((await req('PUT', '/sessions')).status).toBe(405);
    expect((await req('POST', '/health')).status).toBe(405);
    expect((await req('GET', '/nope')).status).toBe(404);
  });
});

// ===== 3. 非流式消息 =====

describe('非流式消息（stream:false）', () => {
  it('首条消息 resetHistory:true，返回完整 JSON 结果并落盘', async () => {
    const id = await createSessionViaApi();
    const res = await req('POST', `/sessions/${id}/messages`, { message: '第一问', stream: false });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      sessionId: id,
      answer: '回复:第一问',
      iterations: 1,
      durationMs: expect.any(Number),
    });
    expect(body.steps).toHaveLength(1);
    expect(calls[0].options.resetHistory).toBe(true);

    // 持久化：store 中 recentMessages 含答案
    const metas = await store.listSessions();
    expect(metas.some((m) => m.id === id)).toBe(true);
    const data = await store.loadSession(id);
    const contents = (data.recentMessages ?? []).map((m) => m.content);
    expect(contents).toContain('第一问');
    expect(contents).toContain('回复:第一问');
  });

  it('次条消息携带上一轮历史（messages 注入，无 resetHistory）', async () => {
    const id = await createSessionViaApi();
    await req('POST', `/sessions/${id}/messages`, { message: '第一问', stream: false });
    const res = await req('POST', `/sessions/${id}/messages`, { message: '第二问', stream: false });
    expect(res.status).toBe(200);

    expect(calls[1].options.resetHistory).toBeUndefined();
    const messages = calls[1].options.messages ?? [];
    expect(messages.map((m) => m.content)).toEqual(['第一问', '回复:第一问']);
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('多会话历史隔离：B 会话调用不带 A 会话历史', async () => {
    const idA = await createSessionViaApi();
    const idB = await createSessionViaApi(); // 同秒冲突由 createSessionSafe 串行 + 间隔规避
    await req('POST', `/sessions/${idA}/messages`, { message: 'A 的问题', stream: false });
    const res = await req('POST', `/sessions/${idB}/messages`, { message: 'B 的问题', stream: false });
    expect(res.status).toBe(200);

    const last = calls[calls.length - 1];
    expect(last.input).toBe('B 的问题');
    expect(last.options.messages ?? []).toEqual([]); // B 首条：空历史 → resetHistory 路径
    expect(last.options.resetHistory).toBe(true);
  });

  it('message 缺失/空串/非法 JSON/非对象 → 400', async () => {
    expect((await req('POST', '/sessions/any/messages', {})).status).toBe(400);
    expect((await req('POST', '/sessions/any/messages', { message: '   ' })).status).toBe(400);
    expect((await req('POST', '/sessions/any/messages', 'not-json')).status).toBe(400);
    expect((await req('POST', '/sessions/any/messages', '[1,2]')).status).toBe(400);
    expect(calls).toHaveLength(0); // 未触达 runAgent
  });

  it('超过 2MB 请求体 → 413（排空策略保证客户端收到响应而非连接重置）', async () => {
    const res = await req('POST', '/sessions/any/messages', { message: 'x'.repeat(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect((await jsonOf(res)).error.code).toBe('payload_too_large');
  });

  it('运行失败（非流式）→ 500，失败轮不污染会话历史', async () => {
    const id = await createSessionViaApi();
    await req('POST', `/sessions/${id}/messages`, { message: '成功问', stream: false });

    runAgentImpl = async () => {
      throw new Error('模型崩溃');
    };
    const fail = await req('POST', `/sessions/${id}/messages`, { message: '失败问', stream: false });
    expect(fail.status).toBe(500);
    expect((await jsonOf(fail)).error).toMatchObject({ code: 'internal', message: '模型崩溃' });

    // 失败轮不持久化：落盘历史仍只有第一轮内容
    const data = await store.loadSession(id);
    const contents = (data.recentMessages ?? []).map((m) => m.content);
    expect(contents).toContain('成功问');
    expect(contents).not.toContain('失败问');
  });
});

// ===== 4. SSE 流式（D3/D4） =====

describe('SSE 流式（D3/D4：15 钩子全量透传 + 合成终态）', () => {
  it('默认流式：15 钩子事件按序透传，done 合成终态收尾', async () => {
    const id = await createSessionViaApi();
    const res = await req('POST', `/sessions/${id}/messages`, { message: '流式问' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readSse(res);
    const events = frames.map((f) => f.event);
    expect(events).toEqual([
      'start',
      'iteration_start',
      'llm_stream',
      'llm_stream',
      'llm_end',
      'llm_stats',
      'llm_stats_summary',
      'tool_start',
      'tool_end',
      'tool_progress',
      'tool_call_delta',
      'compaction',
      'final',
      'error', // 非致命透传，非终态
      'end',
      'done', // API 层合成终态
    ]);

    // 关键载荷断言
    const byEvent = new Map(frames.map((f) => [f.event, f.data]));
    expect(byEvent.get('start')).toEqual({ input: '流式问' });
    expect(byEvent.get('iteration_start')).toEqual({ iteration: 1, maxIterations: 25 });
    expect(byEvent.get('llm_stream')).toEqual({ text: '！' }); // 取最后一个同名事件
    expect(byEvent.get('llm_end').response.finish_reason).toBe('stop');
    expect(byEvent.get('llm_stats').stats.contextTokens).toBe(100);
    expect(byEvent.get('llm_stats_summary').summary.iterations).toBe(1);
    expect(byEvent.get('tool_start')).toEqual({ tool: 'echo', args: { x: 1 } });
    expect(byEvent.get('tool_end')).toEqual({ tool: 'echo', result: 'ok' });
    expect(byEvent.get('tool_progress')).toEqual({ tool: 'echo', elapsedMs: 100 });
    expect(byEvent.get('tool_call_delta')).toEqual({ tool: 'echo', accumulatedBytes: 10, elapsedMs: 50 });
    expect(byEvent.get('compaction').info.flushedChars).toBe(1200);
    expect(byEvent.get('final')).toEqual({ answer: '回复:流式问' });
    expect(byEvent.get('error')).toEqual({ name: 'Error', message: '非致命内部错误' }); // Error 序列化特例
    expect(byEvent.get('end').result.answer).toBe('回复:流式问');

    const done = byEvent.get('done');
    expect(done).toMatchObject({ sessionId: id, iterations: 1, steps: 1 });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('run 抛错：SSE 收到 fatal 合成终态后关流', async () => {
    const id = await createSessionViaApi();
    runAgentImpl = async () => {
      throw new Error('上游连接中断');
    };
    const res = await req('POST', `/sessions/${id}/messages`, { message: '会炸的问' });
    expect(res.status).toBe(200); // SSE 已开流

    const frames = await readSse(res);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('fatal');
    expect(frames[0].data).toEqual({ message: '上游连接中断' });
  });

  it('stream:false 显式关闭流式 → 返回 JSON', async () => {
    const id = await createSessionViaApi();
    const res = await req('POST', `/sessions/${id}/messages`, { message: '关流问', stream: false });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await jsonOf(res)).answer).toBe('回复:关流问');
  });
});

// ===== 5. 会话级互斥（409） =====

describe('会话级互斥（409 busy）', () => {
  it('同会话并发消息 → 409；跨会话并行正常；in-flight 会话拒绝删除', async () => {
    const idA = await createSessionViaApi();
    const idB = await createSessionViaApi();

    let releaseHang: ((r: AgentResult) => void) | undefined;
    runAgentImpl = (input, options) => {
      if (input === '挂起') {
        return new Promise<AgentResult>((resolve) => {
          releaseHang = (r) => resolve(r);
        });
      }
      return defaultImpl(input, options);
    };

    // A 会话首条消息挂起（不 await，保持 in-flight）
    const p1 = req('POST', `/sessions/${idA}/messages`, { message: '挂起', stream: false });
    await waitFor(() => calls.length === 1);

    // A 会话第二条 → 409
    const busyRes = await req('POST', `/sessions/${idA}/messages`, { message: '第二条', stream: false });
    expect(busyRes.status).toBe(409);
    expect((await jsonOf(busyRes)).error.code).toBe('busy');

    // in-flight 会话拒绝删除 → 409
    const delRes = await req('DELETE', `/sessions/${idA}`);
    expect(delRes.status).toBe(409);

    // B 会话并行不受影响
    const okRes = await req('POST', `/sessions/${idB}/messages`, { message: 'B 会话消息', stream: false });
    expect(okRes.status).toBe(200);
    expect(calls[calls.length - 1].input).toBe('B 会话消息');

    // 释放挂起请求，正常完成
    releaseHang?.(makeResult('恢复回复', '挂起', []));
    const r1 = await p1;
    expect(r1.status).toBe(200);
    expect((await jsonOf(r1)).answer).toBe('恢复回复');
  });
});

// ===== 6. 重启恢复（D5：内存缓存 miss → SessionStore 恢复） =====

describe('重启恢复（D5）', () => {
  it('close 后同 SessionStore 新建 server，历史从落盘恢复注入 runAgent', async () => {
    // 主 server 上一秒内可能刚建过会话，等过秒避免 store 层同秒 id 覆盖
    await delay(1100);

    // 显式冻结 port:0 快照（重启测试内不变更配置，冻结安全）
    const port0Cfg: AgentConfig = { ...config, api: { ...config.api, port: 0 } };
    const { server: s1, port } = await startTestServer(port0Cfg);
    const base1 = `http://127.0.0.1:${port}`;
    const created = await fetch(`${base1}/sessions`, { method: 'POST' });
    const id = ((await created.json()) as { id: string }).id;

    await fetch(`${base1}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '第一轮问题', stream: false }),
    });
    await s1.close();

    // 新实例：全新内存缓存，仅共享 store
    const { server: s2, port: port2 } = await startTestServer(port0Cfg);
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '第二轮问题', stream: false }),
      });
      expect(res.status).toBe(200);

      // runAgent 收到从 store 恢复的历史（含前轮 user+assistant，无 system）
      expect(calls).toHaveLength(2);
      const messages = calls[1].options.messages ?? [];
      expect(messages.map((m) => m.content)).toEqual(['第一轮问题', '回复:第一轮问题']);
      expect(messages.every((m) => m.role !== 'system')).toBe(true);
      expect(calls[1].options.resetHistory).toBeUndefined();
    } finally {
      await s2.close();
    }
  });
});
