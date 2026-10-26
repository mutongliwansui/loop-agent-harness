// /memory/dream 定时与历史端点（Task-20261026-003-01 / 方案 D9）
//
// 为什么单独开文件而不塞进 handlers/memory.ts：后者已有 7 个端点，本组是「cron 定时 + 运行历史」
// 的独立关注点，且与 scheduler / cron 引擎强耦合，独立文件便于单测与后续演进（如多空间独立 cron）。
//
// 端点：
//   PUT    /memory/dream/schedule  校验 → 落 workspace 配置 → reschedule() 热重排（免重启）
//   GET    /memory/dream/preview   只算不存，输入期防抖预览未来 5 次
//   GET    /memory/dream/history   最近运行记录（新 → 旧）
//   DELETE /memory/dream/history   清空历史（不触碰 .dreaming-state.json 的增量进度）
//
// 边界（方案 §六 6.5）：
// - 非法 cron → 400 且**不写盘、不打断现有排期**（先校验后写盘）
// - preview 的非法 cron 返回 200 {ok:false,error}（输入期预览不属于错误请求，前端单分支处理）
// - 记忆未启用时仍允许保存（配置先存着），响应带 warning 提示「定时不会执行」

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DreamRunLog } from '../../memory/dream-runs.js';
import type { DreamRunRecord } from '../../memory/dream-runs.js';
import type { PartialAgentConfig } from '../../config/schema.js';
import { ConfigWriter } from '../../config/writer.js';
import { describeCron, nextFireTimes, parseCron } from '../cron.js';
import type { CronFields } from '../cron.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';

/** 历史文件名（与 DreamScheduler 保持一致；两处都指向 {L2 记忆目录}/.dreaming-runs.json） */
const RUNS_FILE = '.dreaming-runs.json';
/** 默认历史条数（与 types.ts 默认值一致） */
const DEFAULT_HISTORY_LIMIT = 20;
/** misfireGraceMin 的允许上限（一天，再大就等同于「总是补跑」） */
const MAX_GRACE_MIN = 1440;

/** 解析 query 正整数（缺省/非法回落 fallback，夹在 [1, max]） */
function queryInt(url: URL, key: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(key));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

/** 读当前生效的历史保留条数（0 = 不留历史） */
function historyLimitOf(ctx: HandlerContext): number {
  const cfg = ctx.configLoader.load().config.memory.dreaming.historyLimit;
  return typeof cfg === 'number' && Number.isFinite(cfg) && cfg >= 0
    ? Math.floor(cfg)
    : DEFAULT_HISTORY_LIMIT;
}

/** 运行历史读写器（调度器未注入或 runtime 未装载时，直接读记忆目录下的文件兜底） */
async function makeRunLog(ctx: HandlerContext): Promise<DreamRunLog | null> {
  const limit = historyLimitOf(ctx);
  if (limit <= 0) return null;
  const kit = await ctx.createMemoryKit();
  return new DreamRunLog({ file: join(kit.episodic.getMemoryDir(), RUNS_FILE), limit });
}

/**
 * PUT /memory/dream/schedule
 * body: `{ enabled?: boolean; cron?: string; misfireGraceMin?: number }`
 *
 * 三步顺序不可换：先校验（非法即 400，磁盘与现有排期零改动）→ 落 workspace 配置 → reschedule()。
 * 响应里的 nextRunAt / nextRunTimes 取自调度器 statusFor（权威值），避免「写盘成功但调度器没接住」
 * 时给前端一个假的下次时间（多工作空间下会出现，见任务文档 E5）。
 */
async function handlePutSchedule(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const { config: eff } = ctx.configLoader.load();
  const cur = eff.memory.dreaming.schedule;

  // ---- 1. 校验（全部通过后才动磁盘）----
  let enabled = cur?.enabled !== false;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new ApiHttpError('bad_request', 'enabled 必须为布尔值');
    enabled = body.enabled;
  }

  let cron = (cur?.cron ?? '').trim();
  if (body.cron !== undefined) {
    if (typeof body.cron !== 'string') throw new ApiHttpError('bad_request', 'cron 必须为字符串');
    cron = body.cron.trim();
  }

  let grace = typeof cur?.misfireGraceMin === 'number' ? cur.misfireGraceMin : 60;
  if (body.misfireGraceMin !== undefined) {
    const g = body.misfireGraceMin;
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 0 || g > MAX_GRACE_MIN) {
      throw new ApiHttpError('bad_request', `misfireGraceMin 必须为 0-${MAX_GRACE_MIN} 的整数（分钟）`);
    }
    grace = g;
  }

  const nowMs = Date.now();
  let fields: CronFields | undefined;
  let preview: number[] = [];
  if (cron) {
    const parsed = parseCron(cron);
    // 空 cron 表示「不用 cron、回落间隔模式」；非空则必须可解析且能算出下一次
    if (!parsed.ok) throw new ApiHttpError('bad_request', parsed.error);
    preview = nextFireTimes(parsed.fields, nowMs, 3);
    if (preview.length === 0) {
      throw new ApiHttpError('bad_request', '该表达式不会触发（请检查「日」与「月」的组合，如 2 月 30 日）');
    }
    fields = parsed.fields;
  }

  // ---- 2. 落 workspace 配置（按点路径写入，由 ConfigWriter 深合并）----
  const partial: Record<string, unknown> = {};
  ConfigWriter.setByKey(partial, 'memory.dreaming.schedule.enabled', enabled);
  ConfigWriter.setByKey(partial, 'memory.dreaming.schedule.cron', cron);
  ConfigWriter.setByKey(partial, 'memory.dreaming.schedule.misfireGraceMin', grace);
  await ctx.configWriter.updateScope('workspace', partial as PartialAgentConfig);
  ctx.log(`[api] 记忆定时已更新：enabled=${enabled} cron="${cron}" grace=${grace}min`);

  // ---- 3. 热重排（不重启即生效）----
  ctx.dreamScheduler?.reschedule();
  const status = await ctx.dreamScheduler?.statusFor(ctx.deps.sessionStore.path).catch(() => null);

  sendJson(res, 200, {
    ok: true,
    enabled,
    cron,
    misfireGraceMin: grace,
    describe: fields ? describeCron(fields) : undefined,
    // 权威值优先（调度器视角），缺失时回落本次校验算出的值
    nextRunAt: status?.nextRunAt ?? (preview[0] !== undefined ? new Date(preview[0]).toISOString() : undefined),
    nextRunTimes: status?.nextRunTimes ?? preview.map((t) => new Date(t).toISOString()),
    intervalMode: status?.intervalMode ?? (cron ? 'cron' : 'interval'),
    ...(eff.memory.enabled ? {} : { warning: '当前记忆未启用，定时不会执行' }),
  });
}

/** GET /memory/dream/preview?cron=：只算不存（输入期防抖预览；合法/非法都 200） */
async function handlePreview(
  _ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = (url.searchParams.get('cron') ?? '').trim();
  if (!raw) {
    sendJson(res, 200, { ok: false, error: '缺少查询参数 cron' });
    return;
  }
  const parsed = parseCron(raw);
  if (!parsed.ok) {
    sendJson(res, 200, { ok: false, error: parsed.error, fieldIndex: parsed.fieldIndex });
    return;
  }
  const next = nextFireTimes(parsed.fields, Date.now(), 5);
  if (next.length === 0) {
    sendJson(res, 200, { ok: false, error: '该表达式不会触发（请检查「日」与「月」的组合）' });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    describe: describeCron(parsed.fields),
    next: next.map((t) => new Date(t).toISOString()),
    // 预览以服务器本地时区计算，前端据此标注「UTC+08:00」等
    timezoneOffsetMin: -new Date().getTimezoneOffset(),
  });
}

/** GET /memory/dream/history?limit=：运行记录（新 → 旧） */
async function handleHistory(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = queryInt(url, 'limit', DEFAULT_HISTORY_LIMIT, 200);
  const root = ctx.deps.sessionStore.path;

  // 优先经调度器（与写入端共用同一套路径/上限解析）
  const viaScheduler = await ctx.dreamScheduler?.historyFor(root, limit).catch((e: unknown) => {
    ctx.log(`[api] 读取运行历史失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (viaScheduler) {
    sendJson(res, 200, { runs: viaScheduler });
    return;
  }

  // 调度器未注入 / runtime 未装载：直接读文件（记忆未启用时也允许查看历史）
  let runs: DreamRunRecord[] = [];
  try {
    const log = await makeRunLog(ctx);
    runs = log ? log.list(limit) : [];
  } catch {
    runs = [];
  }
  sendJson(res, 200, { runs });
}

/** DELETE /memory/dream/history：清空（返回删除条数） */
async function handleClearHistory(
  ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const root = ctx.deps.sessionStore.path;
  const viaScheduler = await ctx.dreamScheduler?.clearHistory(root).catch((e: unknown) => {
    ctx.log(`[api] 清空运行历史失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (viaScheduler !== null && viaScheduler !== undefined) {
    ctx.log(`[api] 运行历史已清空：${viaScheduler} 条`);
    sendJson(res, 200, { deleted: viaScheduler });
    return;
  }

  let deleted = 0;
  try {
    const log = await makeRunLog(ctx);
    deleted = log ? log.clear() : 0;
  } catch {
    deleted = 0;
  }
  ctx.log(`[api] 运行历史已清空：${deleted} 条`);
  sendJson(res, 200, { deleted });
}

export function memoryDreamRoutes(): Route[] {
  return [
    { method: 'PUT', path: '/memory/dream/schedule', handler: (ctx, req, res) => handlePutSchedule(ctx, req, res) },
    { method: 'GET', path: '/memory/dream/preview', handler: (ctx, req, res) => handlePreview(ctx, req, res) },
    { method: 'GET', path: '/memory/dream/history', handler: (ctx, req, res) => handleHistory(ctx, req, res) },
    { method: 'DELETE', path: '/memory/dream/history', handler: (ctx, req, res) => handleClearHistory(ctx, req, res) },
  ];
}
