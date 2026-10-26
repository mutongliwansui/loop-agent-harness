/**
 * 模型性能测试端点端到端测试（需求 20261027-003 / 设计方案 §8）
 *
 * 手法：createApiServer 注入假 configLoader + 假 runBench（runtime seam），
 * 引擎层不触网、历史写临时目录，端点契约与 SSE 事件流全链路可断言。
 *
 * 覆盖：
 * - GET /models/bench 自述（档位/提示词/上限/历史根）
 * - POST /models/bench 参数校验（缺 aliases / 未知别名 / 未配 apiKey / 未知档位 / 未知提示词 / 超上限）
 * - POST 202 → runId + planTotal；SSE 事件顺序与载荷（start/model_start/round_start/first_token/token/round_end/model_done/done）
 * - 多模型服务端串行（D3）：第二个模型在第一个 model_done 之后才开始
 * - 历史落盘：GET /models/bench/history 读回、?alias= 过滤、不含 apiKey
 * - POST stop：中断在跑的 run（202 + SSE done.aborted），重复 stop 幂等
 * - GET stream 未知 runId → 404
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { summarize, type BenchOptions, type BenchRunner, type BenchSummary } from '../src/llm/bench.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-bench-api');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const BENCH_ROOT = join(TEST_DIR, 'model-bench');

interface BenchEventFrame {
  event: string;
  data: Record<string, unknown>;
}

let config: AgentConfig;
let server: ApiServer;
let base = '';
let store: SessionStore;

/** 假引擎：默认返回 1 轮成功样本；用例可替换 */
let runBenchImpl: BenchRunner;
/** 假引擎收到的 options（断言参数透传） */
let lastOptions: BenchOptions | null = null;

function fakeSummary(alias: string): BenchSummary {
  const s = summarize([
    { prompt: 'short', round: 1, ok: true, ttftMs: 123, decodeTps: 45.6, tpotMs: 21.9, e2eTps: 40, itlP90Ms: 25, outTokens: 30 },
  ]);
  s.wallMs = 800;
  // 用 alias 派生不同数值，便于断言「结果与模型对得上」
  const bump = alias.length;
  s.ttft.p50 = 100 + bump;
  return s;
}

/** 默认假引擎：串行回调所有钩子后返回成功汇总 */
function defaultRunner(opts: BenchOptions): Promise<BenchSummary> {
  lastOptions = opts;
  const prompts = opts.prompts ?? ['short'];
  const rounds = opts.rounds ?? 1;
  for (const p of prompts) {
    for (let r = 1; r <= rounds; r++) {
      opts.onRoundStart?.({ round: r, total: rounds, prompt: p });
      opts.onFirstToken?.(42, { round: r, prompt: p });
      opts.onToken?.(5, 60, { round: r, prompt: p });
      opts.onToken?.(12, 120, { round: r, prompt: p });
      opts.onSample?.({ prompt: p, round: r, ok: true, ttftMs: 42, decodeTps: 45, outTokens: 12 });
    }
  }
  return Promise.resolve(fakeSummary(opts.model.name));
}

function makeConfig(): AgentConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = { ...cfg.api, port: 0 };
  cfg.models = {
    active: 'alpha',
    profiles: {
      alpha: { name: 'gpt-alpha', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-alpha-secret' },
      beta: { name: 'gpt-beta', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-beta-secret' },
      nokey: { name: 'gpt-nokey', baseUrl: 'https://api.example.com/v1', apiKey: '' },
    },
  };
  return cfg;
}

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * 读 SSE 直到收到 stopOn 指定事件（或待收事件数达 expect 上限 / 超时）。
 * 事件按 "\n\n" 分帧，`:` 开头的注释帧（keep-alive）忽略。
 */
async function readSse(
  path: string,
  opts: { stopOn?: string; minEvents?: number; timeoutMs?: number } = {},
): Promise<BenchEventFrame[]> {
  const { stopOn = 'done', minEvents = 1, timeoutMs = 5000 } = opts;
  const res = await fetch(`${base}${path}`);
  if (!res.body) throw new Error('SSE 响应没有 body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: BenchEventFrame[] = [];
  let buf = '';
  const started = Date.now();
  try {
    while (true) {
      if (Date.now() - started > timeoutMs) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        idx = buf.indexOf('\n\n');
        if (!raw.startsWith('event:')) continue; // 跳过 `: ping` 注释帧
        const evLine = raw.split('\n').find((l) => l.startsWith('event:')) ?? '';
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:')) ?? 'data:{}';
        frames.push({
          event: evLine.slice(6).trim(),
          data: JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>,
        });
      }
      if (frames.some((f) => f.event === stopOn) && frames.length >= minEvents) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = new SessionStore(TEST_WORKSPACE, false, TEST_DIR);
  await store.init();
  config = makeConfig();

  server = createApiServer({
    runAgent: async () => {
      throw new Error('bench 测试不涉及会话 run');
    },
    sessionStore: store,
    getConfig: () => config,
    runtime: {
      configLoader: { load: () => ({ config }) } as never,
      benchRoot: BENCH_ROOT,
      runBench: (opts) => runBenchImpl(opts),
    },
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  config = makeConfig();
  lastOptions = null;
  runBenchImpl = defaultRunner;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /models/bench 自述', () => {
  it('返回档位 / 提示词 / 上限 / 历史根（前端与脚本据此渲染）', async () => {
    const res = await req('GET', '/models/bench');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tiers: { key: string; rounds: number }[];
      prompts: { key: string; label: string }[];
      maxAliases: number;
      historyRoot: string;
    };
    expect(body.tiers.map((t) => t.key)).toEqual(['quick', 'standard']);
    expect(body.prompts.map((p) => p.key)).toEqual(['short', 'medium', 'code']);
    expect(body.maxAliases).toBe(4);
    expect(body.historyRoot).toBe(BENCH_ROOT);
  });
});

describe('POST /models/bench 参数校验', () => {
  it('缺 aliases → 400', async () => {
    const res = await req('POST', '/models/bench', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('aliases');
  });

  it('别名不存在 → 404（启动前整体校验，不跑一半才报错）', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['alpha', 'ghost'] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('ghost');
    expect(lastOptions).toBeNull(); // 引擎没被调用
  });

  it('别名未配 apiKey → 400', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['nokey'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('apiKey');
  });

  it('未知档位 / 未知提示词档位 → 400', async () => {
    const bad1 = await req('POST', '/models/bench', { aliases: ['alpha'], tier: 'turbo' });
    expect(bad1.status).toBe(400);
    const bad2 = await req('POST', '/models/bench', { aliases: ['alpha'], prompts: ['long'] });
    expect(bad2.status).toBe(400);
  });

  it('一次超过 4 个模型 → 400（上限与文档一致）', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('4');
  });

  it('档位取默认值 + 显式字段覆盖（rounds/maxTokens 越界被 clamp）', async () => {
    const res = await req('POST', '/models/bench', {
      aliases: ['alpha'],
      tier: 'quick',
      rounds: 999,
      maxTokens: 1,
      concurrency: 9,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; plan: { rounds: number; maxTokens: number; concurrency: number } };
    expect(body.plan.rounds).toBe(10); // clamp 到上限
    expect(body.plan.maxTokens).toBe(32); // clamp 到下限
    expect(body.plan.concurrency).toBe(4);
    // 清场：把 run 跑完，避免残留定时器
    await readSse(`/models/bench/${body.runId}/stream`);
  });
});

describe('POST /models/bench + SSE 进度', () => {
  it('202 返回 runId 与 planTotal（模型数 × 提示词数 × 轮数）', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['alpha'], prompts: ['short', 'medium'], rounds: 2 });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; plan: { planTotal: number } };
    expect(body.runId).toMatch(/^bench_/);
    expect(body.plan.planTotal).toBe(4);
  });

  it('事件顺序：start → model_start → round_start → first_token → token → round_end → model_done → done', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['alpha'], prompts: ['short'], rounds: 1 });
    const { runId } = (await res.json()) as { runId: string };
    const frames = await readSse(`/models/bench/${runId}/stream`);
    // token 事件按 100ms 节流（每个 delta 都推会把 SSE 打满），故连续 token 合并后再比顺序
    const collapsed = frames.map((f) => f.event).filter((e, i, arr) => !(e === 'token' && arr[i - 1] === 'token'));
    expect(collapsed).toEqual([
      'start',
      'model_start',
      'round_start',
      'first_token',
      'token',
      'round_end',
      'model_done',
      'done',
    ]);
    // 节流确实生效：假引擎连发两个 token，100ms 内只透出 1 个
    expect(frames.filter((f) => f.event === 'token')).toHaveLength(1);

    const start = frames[0].data as { aliases: string[]; planTotal: number };
    expect(start.aliases).toEqual(['alpha']);
    expect(start.planTotal).toBe(1);

    const modelStart = frames[1].data as { alias: string; model: string; baseUrlHost: string; index: number; total: number };
    expect(modelStart).toMatchObject({ alias: 'alpha', model: 'gpt-alpha', baseUrlHost: 'api.example.com', index: 1, total: 1 });

    const first = frames[3].data as { alias: string; ms: number };
    expect(first.alias).toBe('alpha');
    expect(first.ms).toBe(42);
    const done = frames[frames.length - 1].data as { results: { alias: string; summary: { okCount: number } }[]; aborted: boolean };
    expect(done.aborted).toBe(false);
    expect(done.results[0].alias).toBe('alpha');
    expect(done.results[0].summary.okCount).toBe(1);
  });

  it('参数透传到引擎：prompts/rounds/maxTokens/bustCache/timeoutMs 与请求一致', async () => {
    const res = await req('POST', '/models/bench', {
      aliases: ['alpha'],
      prompts: ['code'],
      rounds: 3,
      maxTokens: 128,
      bustCache: false,
      timeoutMs: 30_000,
    });
    const { runId } = (await res.json()) as { runId: string };
    await readSse(`/models/bench/${runId}/stream`);
    expect(lastOptions).toMatchObject({
      prompts: ['code'],
      rounds: 3,
      maxTokens: 128,
      bustCache: false,
      timeoutMs: 30_000,
      concurrency: 1,
    });
    expect(lastOptions?.model).toEqual({ name: 'gpt-alpha', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-alpha-secret' });
  });

  it('多模型服务端串行（D3）：beta 的 model_start 在 alpha 的 model_done 之后', async () => {
    const order: string[] = [];
    runBenchImpl = async (opts) => {
      order.push(`call:${opts.model.name}`);
      opts.onSample?.({ prompt: 'short', round: 1, ok: true, ttftMs: 10, outTokens: 5 });
      return fakeSummary(opts.model.name);
    };
    const res = await req('POST', '/models/bench', { aliases: ['alpha', 'beta'], prompts: ['short'], rounds: 1 });
    const { runId } = (await res.json()) as { runId: string };
    const frames = await readSse(`/models/bench/${runId}/stream`, { minEvents: 6 });
    expect(order).toEqual(['call:gpt-alpha', 'call:gpt-beta']);
    const seq = frames.filter((f) => ['model_start', 'model_done'].includes(f.event)).map((f) => `${f.event}:${String(f.data.alias)}`);
    expect(seq).toEqual(['model_start:alpha', 'model_done:alpha', 'model_start:beta', 'model_done:beta']);
  });

  it('引擎抛错 → failed 事件 + 流关闭（不挂死）', async () => {
    runBenchImpl = async () => {
      throw new Error('引擎内部爆炸');
    };
    const res = await req('POST', '/models/bench', { aliases: ['alpha'], prompts: ['short'], rounds: 1 });
    const { runId } = (await res.json()) as { runId: string };
    const frames = await readSse(`/models/bench/${runId}/stream`, { stopOn: 'failed' });
    const last = frames[frames.length - 1];
    expect(last.event).toBe('failed');
    expect(String(last.data.error)).toContain('引擎内部爆炸');
  });

  it('未知 runId 的 SSE → 404', async () => {
    const res = await fetch(`${base}/models/bench/bench_nope/stream`);
    expect(res.status).toBe(404);
  });
});

describe('历史落盘与查询', () => {
  it('跑完自动落盘：GET history 读回该模型记录，且不含 apiKey', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['alpha'], prompts: ['short'], rounds: 1 });
    const { runId } = (await res.json()) as { runId: string };
    await readSse(`/models/bench/${runId}/stream`);

    const hist = await req('GET', '/models/bench/history?alias=alpha');
    expect(hist.status).toBe(200);
    const body = (await hist.json()) as {
      root: string;
      count: number;
      runs: { alias: string; runId: string; summary: { okCount: number }; baseUrlHost: string }[];
    };
    expect(body.root).toBe(BENCH_ROOT);
    expect(body.count).toBeGreaterThanOrEqual(1);
    expect(body.runs[0].alias).toBe('alpha');
    expect(body.runs[0].summary.okCount).toBe(1);
    expect(body.runs[0].baseUrlHost).toBe('api.example.com');
    expect(JSON.stringify(body)).not.toContain('sk-alpha-secret');
  });

  it('不带 alias → 每模型最近一次（模型页「性能」列首屏）', async () => {
    const res = await req('POST', '/models/bench', { aliases: ['alpha', 'beta'], prompts: ['short'], rounds: 1 });
    const { runId } = (await res.json()) as { runId: string };
    await readSse(`/models/bench/${runId}/stream`, { minEvents: 4 });

    const hist = await req('GET', '/models/bench/history');
    const body = (await hist.json()) as { runs: { alias: string }[] };
    const aliases = body.runs.map((r) => r.alias);
    expect(aliases).toContain('alpha');
    expect(aliases).toContain('beta');
    expect(new Set(aliases).size).toBe(aliases.length); // 每模型只出现一次
  });
});

describe('POST /models/bench/:runId/stop 中断', () => {
  it('中断在跑的 run：202 + SSE done.aborted=true；重复 stop 幂等', async () => {
    let sawSignal: AbortSignal | null = null;
    runBenchImpl = (opts) =>
      new Promise<BenchSummary>((resolve) => {
        sawSignal = opts.signal ?? null;
        const finish = (): void => resolve({ ...fakeSummary('aborted'), aborted: true, okCount: 0 });
        if (opts.signal?.aborted) finish();
        else opts.signal?.addEventListener('abort', finish, { once: true });
      });

    const res = await req('POST', '/models/bench', { aliases: ['alpha'], prompts: ['short'], rounds: 1 });
    const { runId } = (await res.json()) as { runId: string };
    // 等引擎真正拿到 signal（模型已开始）
    for (let i = 0; i < 50 && !sawSignal; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sawSignal).toBeTruthy();

    const stop1 = await req('POST', `/models/bench/${runId}/stop`);
    expect(stop1.status).toBe(202);
    expect(((await stop1.json()) as { stopped: boolean }).stopped).toBe(true);

    const frames = await readSse(`/models/bench/${runId}/stream`, { stopOn: 'done' });
    const done = frames[frames.length - 1];
    expect(done.event).toBe('done');
    expect(done.data.aborted).toBe(true);

    const stop2 = await req('POST', `/models/bench/${runId}/stop`);
    expect(stop2.status).toBe(202);
    expect(((await stop2.json()) as { stopped: boolean }).stopped).toBe(false);
  });

  it('未知 runId 的 stop → 404', async () => {
    const res = await req('POST', '/models/bench/bench_nope/stop');
    expect(res.status).toBe(404);
  });
});
