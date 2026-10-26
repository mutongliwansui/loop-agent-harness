// 模型性能测试引擎（需求 20261027-003 / 设计方案 §5.2）
//
// 只做三件事：发流式请求 → 采时间点 → 汇成分位数。不碰 HTTP、不碰 UI、不碰落盘，
// 因此 CLI / 脚本 / 单测都能直接复用。
//
// 口径三条纪律（设计方案 §3）：
// 1. token 数以 usage 为权威，服务商不回 usage 时才估算并标 `estimated`
// 2. 样本 < 3 轮不出 p90（nearest-rank，无插值，避免假精确）
// 3. 固定 max_tokens / 固定提示词 / temperature:0，否则输出长度不同会让 TPOT 不可比

import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { normalizeUsage, type LLMUsageLike, type RawUsage } from './usage.js';
import type { ModelCandidate } from './connectivity.js';

/** 提示词档位键 */
export type BenchPromptKey = 'short' | 'medium' | 'code';

export interface BenchPrompt {
  key: BenchPromptKey;
  /** 展示名（面板上显示） */
  label: string;
  /** 实际发给模型的用户消息 */
  text: string;
}

/**
 * 固定提示词集（D10）：三档都写死，不随用户输入变化，
 * 保证「同一时刻两个模型拿到的是同一份输入」。
 */
export const BENCH_PROMPTS: Record<BenchPromptKey, BenchPrompt> = {
  short: {
    key: 'short',
    label: '短问答',
    text: '用三句话说明：流式输出相比一次性返回，在哪些场景下体感更好？',
  },
  medium: {
    key: 'medium',
    label: '中文写作',
    text:
      '请写一段约 300 字的中文说明，解释为什么端到端时延要用「首 token 时延 + 输出 token 数 × 单 token 间隔」来解释，' +
      '并为其中每一项各举一个日常生活中的类比。',
  },
  code: {
    key: 'code',
    label: '代码改写',
    text:
      '把下面的函数改写为 TypeScript：加上类型标注与边界判断，并在每处改动上方加一行中文注释说明理由。\n\n' +
      'function pick(list, key) { var out = {}; for (var i = 0; i < list.length; i++) out[list[i][key]] = list[i]; return out; }',
  },
};

/** 档位预设（快速用于日常体检，标准用于横向对比） */
export const BENCH_TIERS = {
  quick: { label: '快速', prompts: ['short'] as BenchPromptKey[], rounds: 1 },
  standard: { label: '标准', prompts: ['short', 'medium'] as BenchPromptKey[], rounds: 3 },
} as const;

export type BenchTier = keyof typeof BENCH_TIERS;

/** 错误分类（UI 据此给文案与颜色） */
export type BenchErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'aborted'
  | 'unknown';

/** 单轮采样（纯数据，可 JSON 化后随 SSE 下发与落盘） */
export interface BenchSample {
  prompt: BenchPromptKey;
  round: number;
  ok: boolean;
  /** 首个非空 delta（含 reasoning）到达时间；D5 口径 */
  ttftMs?: number;
  /** 首个 reasoning_content 非空 delta */
  firstReasoningMs?: number;
  /** 首个答案 content 非空 delta（排除 reasoning） */
  firstContentMs?: number;
  tpotMs?: number;
  itlP90Ms?: number;
  decodeTps?: number;
  e2eTps?: number;
  totalMs?: number;
  outTokens?: number;
  promptTokens?: number;
  cacheHitTokens?: number;
  /** outTokens 来自估算（服务商未回 usage） */
  estimated?: boolean;
  /** 非空 delta 数 */
  chunkCount?: number;
  /** 疑似被网关攒包（坑 ③） */
  suspectBuffered?: boolean;
  errorKind?: BenchErrorKind;
  error?: string;
}

export interface BenchOptions {
  model: ModelCandidate;
  /** 默认 ['short'] */
  prompts?: BenchPromptKey[];
  /** 每个提示词跑几轮，默认 1 */
  rounds?: number;
  /** 输出上限，默认 256（D10） */
  maxTokens?: number;
  /** 单轮超时，默认 60s */
  timeoutMs?: number;
  /** 默认 true：每轮注入随机 nonce 破坏前缀缓存（坑 ②） */
  bustCache?: boolean;
  /** 并发数，默认 1（>1 时只测总吞吐，P2） */
  concurrency?: number;
  /** 采样温度，默认 0（D10） */
  temperature?: number;
  signal?: AbortSignal;
  onRoundStart?: (info: { round: number; total: number; prompt: BenchPromptKey }) => void;
  /** 首 token 到达（ms，相对本轮请求发出时刻） */
  onFirstToken?: (ms: number, info: { round: number; prompt: BenchPromptKey }) => void;
  /** 每个非空 delta 到达（节流由调用方做） */
  onToken?: (outTokens: number, elapsedMs: number, info: { round: number; prompt: BenchPromptKey }) => void;
  /** 每轮结束（成功或失败都会回调） */
  onSample?: (sample: BenchSample) => void;
}

/** 汇总统计（供 handler 与单测共用同一签名，便于注入 fake） */
export type BenchRunner = (opts: BenchOptions) => Promise<BenchSummary>;

/** 分位统计（样本不足时为 null，而不是硬凑一个数） */
export interface Percentiles {
  p50: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface BenchSummary {
  samples: BenchSample[];
  total: number;
  okCount: number;
  successRate: number;
  ttft: Percentiles;
  decodeTps: Percentiles;
  tpot: Percentiles;
  e2eTps: Percentiles;
  itlP90Ms: Percentiles;
  outTokens: Percentiles;
  /** 任一轮的 outTokens 为估算值 */
  estimated: boolean;
  /** 任一轮疑似被网关缓冲（TPS 不可信） */
  suspectBuffered: boolean;
  /** 并发 > 1 时的系统总吞吐（总输出 token / 墙钟） */
  totalTps: number | null;
  /** 整个 run 的墙钟耗时 */
  wallMs: number;
  /** 被用户中断 */
  aborted: boolean;
  /** 各类错误计数（key 为 errorKind） */
  errorKinds: Partial<Record<BenchErrorKind, number>>;
}

/** 出 p90 所需的最小样本数（D11） */
export const MIN_SAMPLES_FOR_P90 = 3;

/**
 * nearest-rank 百分位（无插值）：
 * - 空数组 → null
 * - p ≥ 90 且样本 < MIN_SAMPLES_FOR_P90 → null（1~2 个样本的「90 分位」等于最大值，是假精确）
 */
export function percentile(values: number[], p: number): number | null {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  if (p >= 90 && arr.length < MIN_SAMPLES_FOR_P90) return null;
  const rank = Math.ceil((p / 100) * arr.length);
  const idx = Math.min(arr.length - 1, Math.max(0, rank - 1));
  return arr[idx];
}

function stats(values: number[]): Percentiles {
  const arr = values.filter((v) => Number.isFinite(v));
  return {
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    min: arr.length ? Math.min(...arr) : null,
    max: arr.length ? Math.max(...arr) : null,
    count: arr.length,
  };
}

/** 汇总纯函数：给样本数组出 p50/p90（便于单测与历史回放） */
export function summarize(samples: BenchSample[]): BenchSummary {
  const ok = samples.filter((s) => s.ok);
  const pick = (f: (s: BenchSample) => number | undefined): number[] =>
    ok.map(f).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  const errorKinds: Partial<Record<BenchErrorKind, number>> = {};
  for (const s of samples) {
    if (!s.ok && s.errorKind) errorKinds[s.errorKind] = (errorKinds[s.errorKind] ?? 0) + 1;
  }

  return {
    samples,
    total: samples.length,
    okCount: ok.length,
    successRate: samples.length ? ok.length / samples.length : 0,
    ttft: stats(pick((s) => s.ttftMs)),
    decodeTps: stats(pick((s) => s.decodeTps)),
    tpot: stats(pick((s) => s.tpotMs)),
    e2eTps: stats(pick((s) => s.e2eTps)),
    itlP90Ms: stats(pick((s) => s.itlP90Ms)),
    outTokens: stats(pick((s) => s.outTokens)),
    estimated: ok.some((s) => s.estimated === true),
    suspectBuffered: ok.some((s) => s.suspectBuffered === true),
    totalTps: null,
    wallMs: 0,
    aborted: false,
    errorKinds,
  };
}

/** 错误 → 分类 + 人话（401/404/429/超时/网络/中断） */
export function classifyBenchError(err: unknown): { kind: BenchErrorKind; message: string } {
  const status = (err as { status?: number } | null | undefined)?.status;
  const name = err instanceof Error ? err.name : '';
  const raw = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403) return { kind: 'auth', message: 'apiKey 无效或无权限' };
  if (status === 404) return { kind: 'not_found', message: '模型名或服务地址可能有误' };
  if (status === 429) return { kind: 'rate_limit', message: '被服务商限流（429），样本不足' };
  if (typeof status === 'number' && status >= 500) return { kind: 'server', message: `服务端错误（${status}）` };
  if (typeof status === 'number' && status >= 400) return { kind: 'server', message: `服务返回错误（${status}）` };

  if (name === 'AbortError' || /abort/i.test(name) || /aborted/i.test(raw)) {
    return { kind: 'aborted', message: '已中断' };
  }
  if (/timeout|timed out/i.test(raw)) return { kind: 'timeout', message: '单轮超时' };
  if (/premature|closed|reset|terminated|fetch failed|network|socket|econn/i.test(raw)) {
    return { kind: 'network', message: `连接异常：${raw}` };
  }
  return { kind: 'unknown', message: raw };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 采样时使用的时间点（相对本轮 t0，单位 ms） */
interface Timing {
  firstReasoningMs?: number;
  firstContentMs?: number;
  lastTokenMs?: number;
  tokenTimes: number[];
  chars: number;
  usage?: LLMUsageLike;
}

/**
 * 单轮测量：发一次流式请求，只记录时间点与 usage，不在循环里做任何计算。
 *
 * 关键细节（对齐设计方案 §5.2）：
 * - 空 `delta.content`（仅 role）与纯 usage chunk 一律不计为输出（坑 ①）
 * - `reasoning_content` 与 `content` 分别记首个时间（D5：TTFT 含 reasoning）
 * - 末块只有 usage 时，`lastTokenMs` 定格在最后一个非空 delta，不把 usage chunk 当输出
 */
async function measureOnce(args: {
  client: OpenAI;
  model: ModelCandidate;
  prompt: BenchPromptKey;
  round: number;
  maxTokens: number;
  bustCache: boolean;
  temperature: number;
  signal?: AbortSignal;
  onFirstToken?: BenchOptions['onFirstToken'];
  onToken?: BenchOptions['onToken'];
}): Promise<BenchSample> {
  const spec = BENCH_PROMPTS[args.prompt];
  const messages: { role: 'system' | 'user'; content: string }[] = [];
  // 坑 ②：每轮换 nonce 前缀，破坏服务商的前缀缓存，测出来的才是冷启动 TTFT
  if (args.bustCache) messages.push({ role: 'system', content: `bench-nonce: ${randomUUID()}` });
  messages.push({ role: 'user', content: spec.text });

  const timing: Timing = { tokenTimes: [], chars: 0 };
  const t0 = performance.now();
  const info = { round: args.round, prompt: args.prompt };

  try {
    const stream = (await args.client.chat.completions.create(
      {
        model: args.model.name,
        messages,
        max_tokens: args.maxTokens,
        temperature: args.temperature,
        stream: true,
        stream_options: { include_usage: true },
      } as never,
      args.signal ? { signal: args.signal } : undefined,
    )) as unknown as AsyncIterable<{
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
      usage?: RawUsage;
    }>;

    for await (const chunk of stream) {
      if (args.signal?.aborted) break;
      const now = performance.now() - t0;
      const delta = chunk?.choices?.[0]?.delta;
      const reasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
      const content = typeof delta?.content === 'string' ? delta.content : '';

      if (reasoning.length > 0) {
        if (timing.firstReasoningMs === undefined) timing.firstReasoningMs = now;
        timing.tokenTimes.push(now);
        timing.chars += reasoning.length;
      }
      if (content.length > 0) {
        if (timing.firstContentMs === undefined) timing.firstContentMs = now;
        timing.tokenTimes.push(now);
        timing.chars += content.length;
      }
      if (reasoning.length > 0 || content.length > 0) {
        const n = timing.tokenTimes.length;
        if (n === 1) args.onFirstToken?.(round1(now), info);
        args.onToken?.(n, round1(now), info);
      }
      // include_usage：末尾专门有一个 choices 为空、仅带 usage 的 chunk
      if (chunk?.usage) timing.usage = normalizeUsage(chunk.usage);
    }
  } catch (err) {
    if (args.signal?.aborted) {
      return { prompt: args.prompt, round: args.round, ok: false, errorKind: 'aborted', error: '已中断' };
    }
    const { kind, message } = classifyBenchError(err);
    return { prompt: args.prompt, round: args.round, ok: false, errorKind: kind, error: message };
  }

  if (args.signal?.aborted) {
    return { prompt: args.prompt, round: args.round, ok: false, errorKind: 'aborted', error: '已中断' };
  }
  if (timing.tokenTimes.length === 0) {
    return {
      prompt: args.prompt,
      round: args.round,
      ok: false,
      errorKind: 'unknown',
      error: '服务端未返回任何内容（流为空）',
    };
  }

  const tFirst = timing.tokenTimes[0];
  const tLast = timing.tokenTimes[timing.tokenTimes.length - 1];
  timing.lastTokenMs = tLast;
  const chunkCount = timing.tokenTimes.length;

  // token 数以 usage 为权威；服务商不回 usage 才估算（并标 estimated）
  const usageTokens = timing.usage?.completion_tokens ?? 0;
  const estimated = !(usageTokens > 0);
  const outTokens = estimated ? Math.max(chunkCount, Math.round(timing.chars / 1.7)) : usageTokens;

  const spanMs = tLast - tFirst;
  const decodeTps = outTokens > 1 && spanMs > 0 ? ((outTokens - 1) / spanMs) * 1000 : null;
  const e2eTps = tLast > 0 ? (outTokens / tLast) * 1000 : null;
  const tpotMs = outTokens > 1 ? spanMs / (outTokens - 1) : null;

  const intervals: number[] = [];
  for (let i = 1; i < timing.tokenTimes.length; i++) {
    intervals.push(timing.tokenTimes[i] - timing.tokenTimes[i - 1]);
  }
  const itlP90 = percentile(intervals, 90);

  // 坑 ③：攒包判定——只有一个 chunk 却出了不少 token，或所有 chunk 几乎同一瞬间到达。
  // 注意阈值不能写成 itlP90 === 0：真实网关攒包时仍可能有个别 0.1ms 抖动（E2E 实测），
  // 而任何真流式模型的分块间隔都不可能 < 1ms（那等于每秒 1000 token 的物理上限之上）。
  const suspectBuffered =
    (chunkCount <= 1 && outTokens > 8) || (intervals.length >= 2 && itlP90 !== null && itlP90 < 1);

  return {
    prompt: args.prompt,
    round: args.round,
    ok: true,
    ttftMs: round1(tFirst),
    ...(timing.firstReasoningMs !== undefined ? { firstReasoningMs: round1(timing.firstReasoningMs) } : {}),
    ...(timing.firstContentMs !== undefined ? { firstContentMs: round1(timing.firstContentMs) } : {}),
    ...(tpotMs !== null ? { tpotMs: round1(tpotMs) } : {}),
    ...(itlP90 !== null ? { itlP90Ms: round1(itlP90) } : {}),
    ...(decodeTps !== null ? { decodeTps: round1(decodeTps) } : {}),
    ...(e2eTps !== null ? { e2eTps: round1(e2eTps) } : {}),
    totalMs: round1(tLast),
    outTokens,
    ...(timing.usage ? { promptTokens: timing.usage.prompt_tokens } : {}),
    ...(timing.usage?.prompt_cache_hit_tokens !== undefined
      ? { cacheHitTokens: timing.usage.prompt_cache_hit_tokens }
      : {}),
    ...(estimated ? { estimated: true } : {}),
    chunkCount,
    ...(suspectBuffered ? { suspectBuffered: true } : {}),
  };
}

/**
 * 跑完一个档位（一个模型 × 若干提示词 × 若干轮）。
 *
 * - 失败不抛错：只有用户中断才会提前结束，已采集样本照常汇总
 * - 并发 = 1 时严格串行（多模型对比 / 多轮都在同一连接上顺序跑，避免抢带宽，D3）
 * - 并发 > 1 时按批并发，额外给出 `totalTps`（总输出 token / 墙钟，P2）
 */
export async function runBench(opts: BenchOptions): Promise<BenchSummary> {
  const prompts = opts.prompts && opts.prompts.length > 0 ? opts.prompts : (['short'] as BenchPromptKey[]);
  const rounds = Math.max(1, Math.floor(opts.rounds ?? 1));
  const maxTokens = Math.min(1024, Math.max(32, Math.floor(opts.maxTokens ?? 256)));
  const timeoutMs = Math.max(5000, Math.min(180_000, Math.floor(opts.timeoutMs ?? 60_000)));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const temperature = opts.temperature ?? 0;

  // 与 connectivity.ts 同款注入：显式 fetch + maxRetries 0
  // （bench 绝不能自动重试——重试会污染统计，失败就记一轮失败）
  const client = new OpenAI({
    apiKey: opts.model.apiKey,
    baseURL: opts.model.baseUrl,
    timeout: timeoutMs,
    maxRetries: 0,
    fetch: globalThis.fetch,
  });

  const jobs: { prompt: BenchPromptKey; round: number }[] = [];
  for (const p of prompts) for (let r = 1; r <= rounds; r++) jobs.push({ prompt: p, round: r });

  const samples: BenchSample[] = [];
  const startedAt = performance.now();
  let aborted = false;

  for (let i = 0; i < jobs.length; i += concurrency) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    const batch = jobs.slice(i, i + concurrency);
    for (const job of batch) {
      opts.onRoundStart?.({ round: job.round, total: rounds, prompt: job.prompt });
    }
    const results = await Promise.all(
      batch.map((job) =>
        measureOnce({
          client,
          model: opts.model,
          prompt: job.prompt,
          round: job.round,
          maxTokens,
          bustCache: opts.bustCache !== false,
          temperature,
          signal: opts.signal,
          onFirstToken: opts.onFirstToken,
          onToken: opts.onToken,
        }),
      ),
    );
    for (const s of results) {
      samples.push(s);
      opts.onSample?.(s);
    }
    if (results.some((s) => s.errorKind === 'aborted')) {
      aborted = true;
      break;
    }
  }

  const wallMs = Math.round(performance.now() - startedAt);
  const summary = summarize(samples);
  summary.wallMs = wallMs;
  summary.aborted = aborted;
  if (concurrency > 1) {
    const totalTokens = samples.filter((s) => s.ok).reduce((acc, s) => acc + (s.outTokens ?? 0), 0);
    summary.totalTps = wallMs > 0 && totalTokens > 0 ? round1((totalTokens / wallMs) * 1000) : null;
  }
  return summary;
}
