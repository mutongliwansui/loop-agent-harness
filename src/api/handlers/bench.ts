// 模型性能测试端点（需求 20261027-003 / 设计方案 §5.3）
//
// 端点组（D6：静态段 `bench` 先于 `/models/:alias` 注册）：
// - POST /models/bench                        建 run，立即 202 返回 runId
// - GET  /models/bench/:runId/stream          SSE 进度（round_start / first_token / token / round_end / model_done / done）
// - POST /models/bench/:runId/stop            中断（幂等）
// - GET  /models/bench/history?alias=&limit=  历史（不带 alias → 每模型最近一次）
//
// 纪律：
// - 只在后端测（D1）：浏览器测量会把前端渲染抖动算进 TTFT
// - 多模型对比服务端串行（D3）：并行会互抢出口带宽，测出来的是「互相拖累后的数字」
// - 结果落 ~/.loop-agent/model-bench/history.json，只存 baseUrlHost 不存 apiKey（D9）

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BENCH_PROMPTS, BENCH_TIERS, type BenchPromptKey, type BenchTier } from '../../llm/bench.js';
import {
  appendBenchHistory,
  hostOf,
  queryHistory,
  readBenchHistory,
  type BenchHistoryEntry,
  type BenchRunConfig,
} from '../../llm/bench-store.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { sseFrame } from '../sse.js';
import { BenchRun, newBenchRunId, type BenchModelResult } from '../bench-hub.js';

/** 单次最多对比几个模型（再多用户也读不过来，且总耗时线性增长） */
const MAX_ALIASES = 4;
/** token 事件节流：每个 delta 都推会把 SSE 打满，100ms 足够做读数动画 */
const TOKEN_THROTTLE_MS = 100;
/** SSE keep-alive 注释帧间隔 */
const KEEP_ALIVE_MS = 15_000;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function intIn(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parsePrompts(raw: unknown): BenchPromptKey[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiHttpError('bad_request', 'prompts 必须为非空数组');
  const out: BenchPromptKey[] = [];
  for (const v of raw) {
    const key = str(v) as BenchPromptKey;
    if (!(key in BENCH_PROMPTS)) {
      throw new ApiHttpError('bad_request', `未知提示词档位「${String(v)}」，可选：${Object.keys(BENCH_PROMPTS).join(' / ')}`);
    }
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** 解析请求体为 run 计划（tier 给默认值，显式字段覆盖） */
function parsePlan(raw: Record<string, unknown>): { aliases: string[]; config: BenchRunConfig } {
  const aliasRaw = raw.aliases;
  if (!Array.isArray(aliasRaw) || aliasRaw.length === 0) {
    throw new ApiHttpError('bad_request', 'aliases 必须为非空数组（模型别名）');
  }
  const aliases: string[] = [];
  for (const v of aliasRaw) {
    const a = str(v);
    if (!a) throw new ApiHttpError('bad_request', 'aliases 中不允许空字符串');
    if (!aliases.includes(a)) aliases.push(a);
  }
  if (aliases.length > MAX_ALIASES) {
    throw new ApiHttpError('bad_request', `一次最多对比 ${MAX_ALIASES} 个模型`);
  }

  let tier: BenchTier | undefined;
  const tierRaw = str(raw.tier);
  if (tierRaw) {
    if (!(tierRaw in BENCH_TIERS)) {
      throw new ApiHttpError('bad_request', `未知档位「${tierRaw}」，可选：${Object.keys(BENCH_TIERS).join(' / ')}`);
    }
    tier = tierRaw as BenchTier;
  }
  const preset = tier ? BENCH_TIERS[tier] : BENCH_TIERS.standard;

  const config: BenchRunConfig = {
    ...(tier ? { tier } : {}),
    prompts: raw.prompts === undefined ? [...preset.prompts] : parsePrompts(raw.prompts),
    rounds: intIn(raw.rounds, preset.rounds, 1, 10),
    maxTokens: intIn(raw.maxTokens, 256, 32, 1024),
    // D8：默认破坏前缀缓存
    bustCache: raw.bustCache === undefined ? true : raw.bustCache !== false,
    timeoutMs: intIn(raw.timeoutMs, 60_000, 5_000, 180_000),
    concurrency: intIn(raw.concurrency, 1, 1, 4),
  };
  return { aliases, config };
}

/** 取别名对应的 profile；不存在或没配 apiKey 直接报错（测试前就拦住比跑一半失败好） */
function resolveProfile(ctx: HandlerContext, alias: string): { name: string; baseUrl: string; apiKey: string } {
  const { config: cfg } = ctx.configLoader.load();
  const profile = cfg.models.profiles[alias];
  if (!profile) throw new ApiHttpError('not_found', `未找到模型「${alias}」`);
  if (!profile.apiKey) throw new ApiHttpError('bad_request', `模型「${alias}」未配置 apiKey，无法测速`);
  return profile;
}

/** POST /models/bench：建 run 并立即返回（D7：进度走 SSE） */
async function handleStartBench(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const { aliases, config } = parsePlan(body);
  // 先整体校验，任一别名不存在就不启动（避免「跑一半才发现第 3 个模型拼错」）
  const profiles = aliases.map((alias) => ({ alias, profile: resolveProfile(ctx, alias) }));

  const runId = newBenchRunId();
  const planTotal = aliases.length * config.prompts.length * config.rounds;
  const run = ctx.benchRuns.add(new BenchRun(runId, aliases, config, planTotal));
  void execute(ctx, run, profiles, config);

  sendJson(res, 202, {
    runId,
    plan: { aliases, ...config, planTotal },
  });
}

/** 后台执行体：串行逐模型跑（D3），每完成一轮就推事件 */
async function execute(
  ctx: HandlerContext,
  run: BenchRun,
  profiles: { alias: string; profile: { name: string; baseUrl: string; apiKey: string } }[],
  config: BenchRunConfig,
): Promise<void> {
  const { runId, aliases } = run;
  run.emit('start', { runId, aliases, config, planTotal: run.planTotal, startedAt: run.startedAt.toISOString() });
  let aliasIndex = 0;

  try {
    for (const { alias, profile } of profiles) {
      if (run.status !== 'running') break;
      aliasIndex += 1;
      const baseUrlHost = hostOf(profile.baseUrl);
      run.emit('model_start', { alias, model: profile.name, baseUrlHost, index: aliasIndex, total: aliases.length });

      const startedAt = new Date();
      let lastTokenAt = 0;
      const summary = await ctx.runBench({
        model: profile,
        prompts: config.prompts,
        rounds: config.rounds,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        bustCache: config.bustCache,
        concurrency: config.concurrency,
        signal: run.controller.signal,
        onRoundStart: (info) => run.emit('round_start', { alias, ...info }),
        onFirstToken: (ms, info) => {
          // 不在这里记 lastTokenAt：首个 token 事件应当立刻透出（否则极快的模型整轮一个 token 事件都没有），
          // 节流从第一个 token 事件之后才开始计时。
          run.emit('first_token', { alias, ms, ...info });
        },
        onToken: (outTokens, elapsedMs, info) => {
          const now = Date.now();
          if (now - lastTokenAt < TOKEN_THROTTLE_MS) return;
          lastTokenAt = now;
          run.emit('token', { alias, outTokens, elapsedMs, ...info });
        },
        onSample: (sample) => run.emit('round_end', { alias, sample }),
      });

      const result: BenchModelResult = { alias, model: profile.name, baseUrlHost, summary };
      run.results.push(result);
      run.emit('model_done', result);

      // 落盘失败不影响本次结果（历史是附属能力，不阻断测试）
      const entry: BenchHistoryEntry = {
        runId,
        alias,
        model: profile.name,
        baseUrlHost,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        config,
        summary,
      };
      try {
        await appendBenchHistory(ctx.benchRoot, entry);
      } catch (e) {
        ctx.log(`[bench] 历史写入失败（不影响本次结果）：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const status = run.aborted ? 'aborted' : 'done';
    run.emit('done', { runId, aborted: run.aborted, results: run.results });
    run.finish(status);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.log(`[bench] run ${runId} 异常：${message}`);
    run.emit('failed', { runId, error: message });
    run.finish('error', message);
  }
}

/** GET /models/bench/:runId/stream：SSE 进度（先回放已有事件，断线重连幂等） */
async function handleBenchStream(
  ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = ctx.benchRuns.get(runId);
  if (!run) throw new ApiHttpError('not_found', `未找到测试任务：${runId}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let closed = false;
  // 先声明再赋值：run 已结束时 subscribe 会同步回调 onEnd，此时 cleanup 会被调用，
  // 用 const 声明 unsubscribe 会撞上 TDZ。
  let unsubscribe = (): void => {};
  const keepAlive = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, KEEP_ALIVE_MS);
  keepAlive.unref?.();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
  };
  unsubscribe = run.subscribe({
    onEvent: (e) => {
      if (!closed) sseFrame(res, e.event, e.data);
    },
    onEnd: () => {
      if (closed) return;
      cleanup();
      res.end();
    },
  });
  res.on('close', cleanup);
}

/** POST /models/bench/:runId/stop：中断（幂等：已结束返回当前状态） */
async function handleStopBench(
  ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = ctx.benchRuns.get(runId);
  if (!run) throw new ApiHttpError('not_found', `未找到测试任务：${runId}`);
  const running = run.status === 'running';
  if (running) run.stop();
  sendJson(res, 202, { runId, stopped: running, status: run.status });
}

/** GET /models/bench/history：历史记录（?alias= 取该模型 N 次；缺省每模型最近一次） */
async function handleBenchHistory(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const alias = str(url.searchParams.get('alias')) || undefined;
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
  const all = await readBenchHistory(ctx.benchRoot);
  const runs = queryHistory(all, { ...(alias ? { alias } : {}), ...(limit ? { limit } : {}) });
  sendJson(res, 200, { root: ctx.benchRoot, count: all.runs.length, runs });
}

export function benchRoutes(): Route[] {
  return [
    // D6：静态段先于 /models/:alias 注册（bench 永不会被当成模型别名）
    { method: 'POST', path: '/models/bench', handler: (ctx, req, res) => handleStartBench(ctx, req, res) },
    { method: 'GET', path: '/models/bench/history', handler: (ctx, req, res) => handleBenchHistory(ctx, req, res) },
    { method: 'GET', path: '/models/bench/:runId/stream', handler: (ctx, req, res, p) => handleBenchStream(ctx, req, res, p.runId) },
    { method: 'POST', path: '/models/bench/:runId/stop', handler: (ctx, req, res, p) => handleStopBench(ctx, req, res, p.runId) },
    // 端点自述（便于前端/脚本探活，也避免 GET /models/bench 落到 404）
    {
      method: 'GET',
      path: '/models/bench',
      handler: async (ctx, _req, res) => {
        sendJson(res, 200, {
          tiers: Object.entries(BENCH_TIERS).map(([key, v]) => ({ key, label: v.label, prompts: v.prompts, rounds: v.rounds })),
          prompts: Object.values(BENCH_PROMPTS).map((p) => ({ key: p.key, label: p.label })),
          maxAliases: MAX_ALIASES,
          historyRoot: ctx.benchRoot,
        });
      },
    },
  ];
}
