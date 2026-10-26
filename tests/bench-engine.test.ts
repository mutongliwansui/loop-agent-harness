/**
 * 模型性能测试引擎单测（需求 20261027-003 / 设计方案 §8）
 *
 * 覆盖：
 * - 分位数口径（nearest-rank、样本 < 3 不出 p90）
 * - 汇总纯函数（成功率、错误分类计数、estimated / suspectBuffered 传播、失败样本不进统计）
 * - 错误分类（401/404/429/5xx/中断/超时/网络/其它）
 * - runBench 真实流式循环（mock openai SDK，不触网）：
 *   空 delta 不计数、reasoning 与 content 分别记首 token、usage 权威计数、
 *   bustCache 注入 nonce、不重试、中断提前结束、concurrency 出 totalTps
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BENCH_PROMPTS,
  BENCH_TIERS,
  classifyBenchError,
  percentile,
  runBench,
  summarize,
  type BenchSample,
} from '../src/llm/bench.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    constructor(_opts: unknown) {}
  }
  return { default: FakeOpenAI };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 构造一个可控的「流式响应」：按 parts 顺序 yield，可插入延迟 */
function streamOf(parts: { delayMs?: number; chunk: unknown }[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) {
        if (p.delayMs) await sleep(p.delayMs);
        yield p.chunk;
      }
    },
  };
}

/** 内容 chunk */
function contentChunk(text: string): unknown {
  return { choices: [{ delta: { content: text } }] };
}

/** reasoning chunk（推理模型） */
function reasoningChunk(text: string): unknown {
  return { choices: [{ delta: { reasoning_content: text } }] };
}

/** 仅带 usage 的尾块（include_usage） */
function usageChunk(completionTokens: number, promptTokens = 40, cacheHit?: number): unknown {
  return {
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(cacheHit !== undefined ? { prompt_cache_hit_tokens: cacheHit } : {}),
    },
  };
}

const MODEL = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', name: 'test-model' };

beforeEach(() => {
  createMock.mockReset();
});

describe('分位数口径（D11）', () => {
  it('空数组 → null（不编造 0）', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 90)).toBeNull();
  });

  it('nearest-rank 无插值：p50(4 个样本) 取第 2 个', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 90)).toBe(40);
  });

  it('样本 < 3 时 p90 → null（1~2 个样本的 90 分位是假精确），p50 照出', () => {
    expect(percentile([100], 50)).toBe(100);
    expect(percentile([100], 90)).toBeNull();
    expect(percentile([100, 200], 90)).toBeNull();
    expect(percentile([100, 200, 300], 90)).toBe(300);
  });

  it('非有限值被忽略（NaN / Infinity 不进统计）', () => {
    expect(percentile([Number.NaN, 5, Number.POSITIVE_INFINITY], 50)).toBe(5);
  });
});

describe('summarize 汇总纯函数', () => {
  const ok = (n: number, extra: Partial<BenchSample> = {}): BenchSample => ({
    prompt: 'short',
    round: n,
    ok: true,
    ttftMs: 100 * n,
    decodeTps: 10 * n,
    tpotMs: 50,
    e2eTps: 5,
    itlP90Ms: 60,
    outTokens: 20,
    ...extra,
  });
  const fail = (errorKind: BenchSample['errorKind'], extra: Partial<BenchSample> = {}): BenchSample => ({
    prompt: 'short',
    round: 9,
    ok: false,
    errorKind,
    error: 'x',
    ...extra,
  });

  it('成功率 = 成功 / 总数；失败样本不进指标统计', () => {
    const s = summarize([ok(1), ok(2), fail('auth')]);
    expect(s.total).toBe(3);
    expect(s.okCount).toBe(2);
    expect(s.successRate).toBeCloseTo(2 / 3, 5);
    expect(s.ttft.count).toBe(2);
    expect(s.ttft.p50).toBe(100);
    expect(s.ttft.min).toBe(100);
    expect(s.ttft.max).toBe(200);
  });

  it('errorKinds 按类别计数', () => {
    const s = summarize([fail('auth'), fail('auth'), fail('timeout')]);
    expect(s.errorKinds).toEqual({ auth: 2, timeout: 1 });
    expect(s.successRate).toBe(0);
    expect(s.ttft.p50).toBeNull();
  });

  it('estimated / suspectBuffered 只要任一轮命中就置位', () => {
    const s = summarize([ok(1), ok(2, { estimated: true, suspectBuffered: true })]);
    expect(s.estimated).toBe(true);
    expect(s.suspectBuffered).toBe(true);
  });

  it('空样本：成功率 0 且各分位 null（不抛错）', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.ttft.p50).toBeNull();
  });
});

describe('classifyBenchError 错误分类', () => {
  const cases: [string, unknown, string][] = [
    ['401 → auth', { status: 401 }, 'auth'],
    ['403 → auth', { status: 403 }, 'auth'],
    ['404 → not_found', { status: 404 }, 'not_found'],
    ['429 → rate_limit', { status: 429 }, 'rate_limit'],
    ['500 → server', { status: 500 }, 'server'],
    ['418 → server（其余 4xx）', { status: 418 }, 'server'],
    ['AbortError → aborted', Object.assign(new Error('x'), { name: 'AbortError' }), 'aborted'],
    ['超时文案 → timeout', new Error('Request timed out.'), 'timeout'],
    ['连接中断 → network', new Error('Premature close'), 'network'],
    ['末知 → unknown', new Error('boom'), 'unknown'],
  ];

  for (const [label, err, kind] of cases) {
    it(label, () => {
      expect(classifyBenchError(err).kind).toBe(kind);
    });
  }

  it('错误文案是人话（不含原始堆栈）', () => {
    expect(classifyBenchError({ status: 429 }).message).toContain('限流');
    expect(classifyBenchError(new Error('Premature close')).message).toContain('连接异常');
  });
});

describe('runBench 流式测量（mock SDK，不触网）', () => {
  it('正常一轮：TTFT 取首个非空 chunk，decodeTps 按 usage token 数算', async () => {
    createMock.mockImplementation(async () =>
      streamOf([
        { delayMs: 5, chunk: { choices: [{ delta: { role: 'assistant', content: '' } }] } }, // 空 delta 不算首 token
        { delayMs: 10, chunk: contentChunk('你好') },
        { delayMs: 10, chunk: contentChunk('世界') },
        { delayMs: 10, chunk: contentChunk('！') },
        { chunk: usageChunk(30) },
      ]),
    );

    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1, maxTokens: 64 });
    expect(summary.okCount).toBe(1);
    const s = summary.samples[0];
    expect(s.ok).toBe(true);
    // 首个非空 chunk 在 ~10ms 之后（空 role delta 不计）
    expect(s.ttftMs).toBeGreaterThanOrEqual(5);
    expect(s.chunkCount).toBe(3);
    expect(s.outTokens).toBe(30); // usage 权威
    expect(s.estimated).toBeUndefined();
    expect(s.decodeTps).toBeGreaterThan(0);
    expect(s.tpotMs).toBeGreaterThan(0);
    expect(s.totalMs).toBeGreaterThan(s.ttftMs ?? 0);
    expect(summary.wallMs).toBeGreaterThan(0);
  });

  it('usage 缺失时按「非空 chunk 数 / 1.7 字」估算并标 estimated', async () => {
    createMock.mockImplementation(async () =>
      streamOf([{ delayMs: 5, chunk: contentChunk('abcd') }, { delayMs: 5, chunk: contentChunk('efgh') }]),
    );
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    const s = summary.samples[0];
    expect(s.ok).toBe(true);
    expect(s.estimated).toBe(true);
    expect(s.outTokens).toBeGreaterThan(0);
    expect(summary.estimated).toBe(true);
  });

  it('reasoning 首 token 单列（firstReasoningMs ≤ firstContentMs）', async () => {
    createMock.mockImplementation(async () =>
      streamOf([
        { delayMs: 5, chunk: reasoningChunk('思考中') },
        { delayMs: 15, chunk: contentChunk('答案') },
        { chunk: usageChunk(8) },
      ]),
    );
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    const s = summary.samples[0];
    expect(s.firstReasoningMs).toBeDefined();
    expect(s.firstContentMs).toBeDefined();
    expect(s.firstReasoningMs!).toBeLessThan(s.firstContentMs!);
    // D5：TTFT 含 reasoning，故等于 firstReasoningMs
    expect(s.ttftMs).toBe(s.firstReasoningMs);
  });

  it('bustCache 默认开：请求体带 bench-nonce 系统消息；关闭时只发用户消息', async () => {
    createMock.mockImplementation(async () => streamOf([{ chunk: contentChunk('好') }, { chunk: usageChunk(3) }]));
    await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    const withNonce = createMock.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    expect(withNonce.messages[0].role).toBe('system');
    expect(withNonce.messages[0].content).toMatch(/^bench-nonce: /);
    expect(withNonce.messages[1].content).toBe(BENCH_PROMPTS.short.text);

    createMock.mockClear();
    await runBench({ model: MODEL, prompts: ['short'], rounds: 1, bustCache: false });
    const noNonce = createMock.mock.calls[0][0] as { messages: unknown[] };
    expect(noNonce.messages).toHaveLength(1);
  });

  it('固定参数：max_tokens / temperature 0 / stream_options.include_usage 都下发', async () => {
    createMock.mockImplementation(async () => streamOf([{ chunk: contentChunk('好') }, { chunk: usageChunk(3) }]));
    await runBench({ model: MODEL, prompts: ['short'], rounds: 1, maxTokens: 128 });
    const body = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe('test-model');
  });

  it('失败不重试：一次失败请求只记一轮失败样本', async () => {
    createMock.mockImplementation(async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 2 });
    expect(createMock).toHaveBeenCalledTimes(2); // 2 轮各 1 次，无重试
    expect(summary.okCount).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.errorKinds).toEqual({ auth: 2 });
    expect(summary.samples[0].error).toContain('apiKey');
  });

  it('流为空（无任何 delta）→ 记一轮失败而不是 0 token 成功', async () => {
    createMock.mockImplementation(async () => streamOf([{ chunk: { choices: [] } }]));
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    expect(summary.samples[0].ok).toBe(false);
    expect(summary.samples[0].errorKind).toBe('unknown');
  });

  it('攒包判定：单 chunk 却出 20 token → suspectBuffered', async () => {
    createMock.mockImplementation(async () => streamOf([{ delayMs: 5, chunk: contentChunk('一次性到达') }, { chunk: usageChunk(20) }]));
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    expect(summary.samples[0].suspectBuffered).toBe(true);
    expect(summary.suspectBuffered).toBe(true);
  });

  it('攒包判定：多 chunk 但几乎同瞬间到达（间隔 < 1ms）也算缓冲（E2E 实测抖动 0.1ms）', async () => {
    // 同步连发 8 块 → 间隔为 0 或亚毫秒抖动，真实网关攒包就是这个形态
    createMock.mockImplementation(async () => {
      const parts = Array.from({ length: 8 }, () => ({ chunk: contentChunk('块') }));
      return streamOf([...parts, { chunk: usageChunk(64) }]);
    });
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    const s = summary.samples[0];
    expect(s.ok).toBe(true);
    expect(s.chunkCount).toBe(8);
    expect(s.suspectBuffered).toBe(true);
  });

  it('正常流式（间隔 ≥ 十几 ms）不会被误判为缓冲', async () => {
    createMock.mockImplementation(async () =>
      streamOf([
        { delayMs: 10, chunk: contentChunk('a') },
        { delayMs: 20, chunk: contentChunk('b') },
        { delayMs: 20, chunk: contentChunk('c') },
        { chunk: usageChunk(12) },
      ]),
    );
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 1 });
    expect(summary.samples[0].suspectBuffered).toBeUndefined();
    expect(summary.suspectBuffered).toBe(false);
  });

  it('已中断的 signal → 不发起请求，aborted 置位', async () => {
    const controller = new AbortController();
    controller.abort();
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 3, signal: controller.signal });
    expect(createMock).not.toHaveBeenCalled();
    expect(summary.aborted).toBe(true);
    expect(summary.total).toBe(0);
  });

  it('concurrency > 1 时额外给 totalTps（总 token / 墙钟），且计划轮次全跑', async () => {
    createMock.mockImplementation(async () =>
      streamOf([{ delayMs: 5, chunk: contentChunk('a') }, { delayMs: 5, chunk: contentChunk('b') }, { chunk: usageChunk(10) }]),
    );
    const summary = await runBench({ model: MODEL, prompts: ['short'], rounds: 2, concurrency: 2 });
    expect(summary.total).toBe(2);
    expect(summary.okCount).toBe(2);
    expect(summary.totalTps).toBeGreaterThan(0);
  });

  it('onRoundStart / onFirstToken / onToken / onSample 回调按序触发', async () => {
    createMock.mockImplementation(async () =>
      streamOf([{ delayMs: 5, chunk: contentChunk('a') }, { delayMs: 5, chunk: contentChunk('b') }, { chunk: usageChunk(5) }]),
    );
    const events: string[] = [];
    await runBench({
      model: MODEL,
      prompts: ['short'],
      rounds: 2,
      onRoundStart: (i) => events.push(`start:${i.round}`),
      onFirstToken: (ms) => events.push(`first:${ms > 0 ? 'pos' : 'zero'}`),
      onToken: (n) => events.push(`tok:${n}`),
      onSample: (s) => events.push(`sample:${s.ok}`),
    });
    expect(events.slice(0, 4)).toEqual(['start:1', 'first:pos', 'tok:1', 'tok:2']);
    expect(events).toContain('sample:true');
    expect(events.filter((e) => e.startsWith('start:')).length).toBe(2);
  });

  it('多提示词 × 多轮：总轮次 = 提示词数 × 轮数，样本带正确 prompt/round', async () => {
    createMock.mockImplementation(async () => streamOf([{ delayMs: 2, chunk: contentChunk('x') }, { chunk: usageChunk(4) }]));
    const summary = await runBench({ model: MODEL, prompts: ['short', 'medium'], rounds: 2, bustCache: false });
    expect(summary.total).toBe(4);
    expect(new Set(summary.samples.map((s) => s.prompt))).toEqual(new Set(['short', 'medium']));
    expect(summary.samples.map((s) => s.round).sort()).toEqual([1, 1, 2, 2]);
  });

  it('档位预设与提示词档位对外可用（前端/文档依赖其形状）', () => {
    expect(Object.keys(BENCH_TIERS)).toEqual(['quick', 'standard']);
    expect(BENCH_TIERS.quick.rounds).toBe(1);
    expect(BENCH_TIERS.standard.prompts).toEqual(['short', 'medium']);
    expect(Object.keys(BENCH_PROMPTS)).toEqual(['short', 'medium', 'code']);
    expect(BENCH_PROMPTS.medium.text.length).toBeGreaterThan(50);
  });
});
