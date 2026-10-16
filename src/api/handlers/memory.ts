// /memory 命令资源化端点（Task-20261016-002 §3.7）
//
// 经 MemoryKit（memory-kit.ts，与 ReactAgent.initMemory 同口径组装）直调记忆子系统，
// 不复用共享 agent（001 D5）。getGateThresholds 为 D3 补导出复用。
// 边界：memory.enabled=false 时 status 恒 200 {enabled: false}，其余端点 409；
// dream 异步整理（202 即走即忘），任务内部检查 dreaming.enabled。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getGateThresholds } from '../../memory/gate.js';
import type { CuratedFileKey } from '../../memory/index.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import type { MemoryKit } from '../memory-kit.js';

/** 解析 query 正整数（缺省/非法回落 fallback，夹在 [1, max]） */
function queryInt(url: URL, key: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(key));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

/** 取可用 MemoryKit（未启用 → 409） */
async function requireMemoryKit(ctx: HandlerContext): Promise<MemoryKit> {
  const { config: cfg } = ctx.configLoader.load();
  if (!cfg.memory.enabled) {
    throw new ApiHttpError('conflict', '记忆系统未启用（memory.enabled=false），可经 PUT /config/memory.enabled 开启');
  }
  return ctx.createMemoryKit();
}

/** GET /memory/status：分层目录 + 计数（未启用恒 200，不报错） */
async function handleMemoryStatus(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  if (!cfg.memory.enabled) {
    sendJson(res, 200, { enabled: false, layers: {}, counts: {} });
    return;
  }
  const kit = await ctx.createMemoryKit();
  sendJson(res, 200, {
    enabled: true,
    layers: {
      episodic: { dir: kit.episodic.getMemoryDir() },
      curated: { workspace: kit.curated.getWorkspaceDir(), files: kit.curated.getFilePaths() },
    },
    counts: {
      episodicDays: (await kit.episodic.listDays()).length,
      gatePending: kit.gate.listPending().length,
      gateApproved: kit.gate.listApproved().length,
    },
  });
}

/** GET /memory/curated：三层 Curated 文件全文 */
async function handleCurated(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kit = await requireMemoryKit(ctx);
  const files = kit.curated.getFilePaths();
  const entries = await Promise.all(
    (Object.keys(files) as CuratedFileKey[]).map(async (key) => ({
      key,
      path: files[key],
      content: await kit.curated.read(key),
    })),
  );
  sendJson(res, 200, { entries });
}

/** GET /memory/episodic?limit=：最近 N 天 daily notes（默认 7，上限 90） */
async function handleEpisodic(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kit = await requireMemoryKit(ctx);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = queryInt(url, 'limit', 7, 90);
  const entries = await kit.episodic.readRecentDays(limit);
  sendJson(res, 200, { entries });
}

/** GET /memory/search?q=&limit=：L2 检索（q 必填 400；结果标 layer=episodic） */
async function handleMemorySearch(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kit = await requireMemoryKit(ctx);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) throw new ApiHttpError('bad_request', '缺少必填查询参数 q');
  const topK = queryInt(url, 'limit', 5, 50);
  const results = await kit.episodic.search(q, topK);
  sendJson(res, 200, { results: results.map((r) => ({ ...r, layer: 'episodic' })) });
}

/** GET /memory/gate：晋升阈值 + 待定/已批准决策清单 */
async function handleGate(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kit = await requireMemoryKit(ctx);
  sendJson(res, 200, {
    thresholds: getGateThresholds(),
    recentDecisions: {
      pending: kit.gate.listPending(),
      approved: kit.gate.listApproved(),
    },
  });
}

/** POST /memory/dream：异步整理（202 即走即忘，任务内部检查 dreaming.enabled） */
async function handleDream(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 202, { accepted: true });
  void (async () => {
    try {
      const { config: cfg } = ctx.configLoader.load();
      if (!cfg.memory.dreaming.enabled) {
        ctx.log('[api] memory dream: dreaming.enabled=false，跳过');
        return;
      }
      const kit = await ctx.createMemoryKit();
      const result = await kit.dream.run(cfg.memory.dreaming.daysBack, undefined, {
        dedupeEnabled: cfg.memory.curated.dedupe.enabled,
        batchByDay: cfg.memory.dreaming.batchByDay,
        incremental: cfg.memory.dreaming.incremental,
      });
      ctx.log(`[api] memory dream 完成: 晋升 ${result.promoted.length}，跳过 ${result.skipped.length}，错误 ${result.errors.length}`);
    } catch (e) {
      ctx.log(`[api] memory dream 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}

/** POST /memory/init：幂等初始化（MemoryKit 工厂内已完成各层 init/loadState） */
async function handleMemoryInit(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  if (!cfg.memory.enabled) {
    throw new ApiHttpError('conflict', '记忆系统未启用（memory.enabled=false）');
  }
  await ctx.createMemoryKit();
  sendJson(res, 200, { initialized: true });
}

export function memoryRoutes(): Route[] {
  return [
    { method: 'GET', path: '/memory/status', handler: (ctx, _req, res) => handleMemoryStatus(ctx, _req, res) },
    { method: 'GET', path: '/memory/curated', handler: (ctx, _req, res) => handleCurated(ctx, _req, res) },
    { method: 'GET', path: '/memory/episodic', handler: (ctx, req, res) => handleEpisodic(ctx, req, res) },
    { method: 'GET', path: '/memory/search', handler: (ctx, req, res) => handleMemorySearch(ctx, req, res) },
    { method: 'GET', path: '/memory/gate', handler: (ctx, _req, res) => handleGate(ctx, _req, res) },
    { method: 'POST', path: '/memory/dream', handler: (ctx, req, res) => handleDream(ctx, req, res) },
    { method: 'POST', path: '/memory/init', handler: (ctx, _req, res) => handleMemoryInit(ctx, _req, res) },
  ];
}
