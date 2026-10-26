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

import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
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
import { aggregateRunHistory, clearRunHistory, listMemoryWorkspaces, toWorkspaceId } from '../memory-workspaces.js';

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

/** 记忆/会话索引根目录（与 handlers/memory.ts 同口径；ctx.userDir 可覆盖，单测注入） */
function memoryBaseDir(ctx: HandlerContext): string {
  const dir = ctx.configLoader.load().config.memory.episodic.dir;
  if (dir && /^([A-Za-z]:[\\/]|\/)/.test(dir)) return dir;
  return join(ctx.userDir ?? join(homedir(), '.loop-agent'), 'memory');
}
function sessionsBaseDir(ctx: HandlerContext): string {
  return join(ctx.userDir ?? join(homedir(), '.loop-agent'), 'sessions');
}

/**
 * 解析 history 端点的目标空间根：
 * - 缺省 ?ws= → 启动空间（现行为不变）；
 * - 绝对路径 → registry.ensureRoot 校验（not_found/forbidden 与 fs 组同语义）；
 * - wsId → 经 sessions 索引反查 path（查不到 → not_found，无法定位增量状态目录）。
 * 无 registry（单测/嵌入）时仅允许缺省/绝对路径走 ensureRoot 失败回落——
 * 为保持既有单测零改动，无 registry 一律回落启动空间。
 */
async function resolveHistoryTargetRoot(ctx: HandlerContext, wsParam: string): Promise<string> {
  if (!wsParam) return ctx.deps.sessionStore.path;
  const registry = ctx.registry;
  if (!registry) return ctx.deps.sessionStore.path;
  if (/^[A-Za-z]:[\\/]/.test(wsParam) || wsParam.startsWith('/')) {
    return registry.ensureRoot(wsParam);
  }
  if (/^[0-9a-f]{8,64}$/i.test(wsParam)) {
    const hit = (await listMemoryWorkspaces({ sessionsDir: sessionsBaseDir(ctx), memoryDir: memoryBaseDir(ctx) }))
      .find((w) => w.id === wsParam.toLowerCase());
    if (!hit?.path) throw new ApiHttpError('not_found', `无法定位该空间路径: ${wsParam.slice(0, 8)}`);
    return hit.path;
  }
  throw new ApiHttpError('bad_request', 'ws 参数须为 16 位工作空间 id 或绝对路径');
}

/**
 * 单空间直读运行历史（调度器不可用时的文件兜底）。
 * 与 DreamScheduler.logFor 同构：读 {L2 记忆目录}/.dreaming-runs.json，环形上限照配置。
 */
function readRunsForRoot(ctx: HandlerContext, root: string): DreamRunRecord[] {
  const limit = historyLimitOf(ctx);
  if (limit <= 0) return [];
  const wsId = toWorkspaceId(root);
  const memoryDir = join(memoryBaseDir(ctx), wsId);
  const log = new DreamRunLog({ file: join(memoryDir, RUNS_FILE), limit });
  return log.list(limit);
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

/** GET /memory/dream/history?limit=&scope=&ws=：运行记录（新 → 旧）
 *  scope=ws（缺省）：启动空间单文件读取（现行为不变，20261026-004 起支持 ?ws= 指定空间）；
 *  scope=all：纯文件扫描聚合各空间记忆目录下的 .dreaming-runs.json（方案 D5），
 *  每条附 workspaceId/Name/Path——修复「读取恒为启动空间」的失真问题。 */
async function handleHistory(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = queryInt(url, 'limit', DEFAULT_HISTORY_LIMIT, 200);
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'ws';

  // ---- 聚合模式：纯文件扫描，不依赖 runtime 装载状态（含未装载/未访问过的空间）----
  if (scope === 'all') {
    const runs = aggregateRunHistory({
      memoryDir: memoryBaseDir(ctx),
      sessionsDir: sessionsBaseDir(ctx),
    }).slice(0, limit);
    sendJson(res, 200, { runs, scope });
    return;
  }

  // ---- 单空间模式：可经 ?ws= 指定目标空间（缺省=启动空间，现行为不变）----
  const wsParam = (url.searchParams.get('ws') ?? '').trim();
  const targetRoot = await resolveHistoryTargetRoot(ctx, wsParam);

  // 优先经调度器（与写入端共用同一套路径/上限解析）
  const viaScheduler = await ctx.dreamScheduler?.historyFor(targetRoot, limit).catch((e: unknown) => {
    ctx.log(`[api] 读取运行历史失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (viaScheduler) {
    sendJson(res, 200, { runs: viaScheduler, scope });
    return;
  }

  // 调度器未注入 / runtime 未装载：直接读文件（记忆未启用时也允许查看历史）
  let runs: DreamRunRecord[] = [];
  try {
    runs = readRunsForRoot(ctx, targetRoot).slice(0, limit);
  } catch {
    runs = [];
  }
  sendJson(res, 200, { runs, scope });
}

/** DELETE /memory/dream/history?scope=&ws=：清空（返回删除条数）
 *  范围语义与 GET 对齐（方案 D6）：scope=ws 清指定空间（缺省启动空间），
 *  scope=all 遍历清空各空间文件内记录（文件保留，内容清空）。 */
async function handleClearHistory(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'ws';

  // ---- 聚合清空：遍历 memory 目录下全部空间 ----
  if (scope === 'all') {
    let deleted = 0;
    try {
      const ids = readdirSync(memoryBaseDir(ctx), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      deleted = clearRunHistory({ memoryDir: memoryBaseDir(ctx), wsIds: ids });
    } catch (e: unknown) {
      ctx.log(`[api] 聚合清空运行历史失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    ctx.log(`[api] 运行历史已清空（全部空间）：${deleted} 条`);
    sendJson(res, 200, { deleted, scope });
    return;
  }

  // ---- 单空间清空：可经 ?ws= 指定目标空间 ----
  const wsParam = (url.searchParams.get('ws') ?? '').trim();
  const targetRoot = await resolveHistoryTargetRoot(ctx, wsParam);

  const viaScheduler = await ctx.dreamScheduler?.clearHistory(targetRoot).catch((e: unknown) => {
    ctx.log(`[api] 清空运行历史失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (viaScheduler !== null && viaScheduler !== undefined) {
    ctx.log(`[api] 运行历史已清空：${viaScheduler} 条`);
    sendJson(res, 200, { deleted: viaScheduler, scope });
    return;
  }

  let deleted = 0;
  try {
    const wsId = toWorkspaceId(targetRoot);
    deleted = clearRunHistory({ memoryDir: memoryBaseDir(ctx), wsIds: [wsId] });
  } catch {
    deleted = 0;
  }
  ctx.log(`[api] 运行历史已清空：${deleted} 条`);
  sendJson(res, 200, { deleted, scope });
}

export function memoryDreamRoutes(): Route[] {
  return [
    { method: 'PUT', path: '/memory/dream/schedule', handler: (ctx, req, res) => handlePutSchedule(ctx, req, res) },
    { method: 'GET', path: '/memory/dream/preview', handler: (ctx, req, res) => handlePreview(ctx, req, res) },
    { method: 'GET', path: '/memory/dream/history', handler: (ctx, req, res) => handleHistory(ctx, req, res) },
    { method: 'DELETE', path: '/memory/dream/history', handler: (ctx, req, res) => handleClearHistory(ctx, req, res) },
  ];
}
