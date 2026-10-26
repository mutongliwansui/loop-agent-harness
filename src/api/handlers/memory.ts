// /memory 命令资源化端点（Task-20261016-002 §3.7；20261026-004 跨空间扩展）
//
// 经 MemoryKit（memory-kit.ts，与 ReactAgent.initMemory 同口径组装）直调记忆子系统，
// 不复用共享 agent（001 D5）。getGateThresholds 为 D3 补导出复用。
// 边界：memory.enabled=false 时 status 恒 200 {enabled: false}，其余端点 409；
// dream 异步整理（202 即走即忘），任务内部检查 dreaming.enabled。
//
// 20261026-004：/memory/episodic 与 /memory/curated 支持 ?ws=<id|绝对路径> 按空间读取
// （方案 D4），新增 GET /memory/workspaces 聚合空间清单（D2）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getGateThresholds } from '../../memory/gate.js';
import { CuratedMemory } from '../../memory/curated.js';
import { EpisodicMemory } from '../../memory/episodic.js';
import type { CuratedFileKey } from '../../memory/index.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import type { MemoryKit } from '../memory-kit.js';
import { listMemoryWorkspaces, resolveMemorySpace, toWorkspaceId } from '../memory-workspaces.js';

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

/** 记忆根目录（与 memory-kit.ts 同口径：memory.episodic.dir 绝对配置优先，默认 {userDir}/memory） */
function memoryBaseDir(ctx: HandlerContext): string {
  const dir = ctx.configLoader.load().config.memory.episodic.dir;
  if (dir && /^([A-Za-z]:[\\/]|\/)/.test(dir)) return dir;
  return join(ctx.userDir ?? join(homedir(), '.loop-agent'), 'memory');
}

/** sessions 索引根目录（meta.json 明文，供空间名映射；默认 {userDir}/sessions） */
function sessionsBaseDir(ctx: HandlerContext): string {
  return join(ctx.userDir ?? join(homedir(), '.loop-agent'), 'sessions');
}

/** wsId 形态（workspaceId 产出 16 位十六进制；放宽 8-64 容纳测试） */
const WS_ID_RE = /^[0-9a-f]{8,64}$/i;

/**
 * 跨空间读取基座（方案 D4）：解析 ?ws= 得到「记忆目录 + 空间根」。
 *
 * 三种形态：
 * - 缺省 → 返回 null，调用方走启动空间（现行为不变）；
 * - 绝对路径（盘符/posix 根开头）→ registry.ensureRoot 校验后 canonical 化为 wsId；
 * - wsId → 直接定位 {memoryBase}/{id} 目录。
 *
 * 单测/嵌入用法（无 registry）时返回 null 回落启动空间——与「不隐式回落 cwd」的
 * 既有约定不冲突：这里显式声明为「不支持跨空间」而非静默错误。
 */
async function resolveWsTarget(
  ctx: HandlerContext,
  url: URL,
): Promise<{ memoryDir: string; wsId: string; wsRoot: string | null } | null> {
  const raw = (url.searchParams.get('ws') ?? '').trim();
  if (!raw) return null;
  const registry = ctx.registry;
  if (!registry) return null;

  let root: string | null = null;
  let wsId: string;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) {
    root = await registry.ensureRoot(raw); // 目录不存在 → not_found；不可进入 → forbidden
    wsId = toWorkspaceId(root);
  } else if (WS_ID_RE.test(raw)) {
    wsId = raw.toLowerCase();
  } else {
    throw new ApiHttpError('bad_request', 'ws 参数须为 16 位工作空间 id 或绝对路径');
  }

  const target = resolveMemorySpace(memoryBaseDir(ctx), wsId, sessionsBaseDir(ctx));
  if (!target) throw new ApiHttpError('not_found', `该工作空间暂无记忆数据: ${wsId.slice(0, 8)}`);

  // wsId 形态时反查空间根（供 CuratedMemory 定位 workspace 级 MEMORY.md 等）；
  // 定位不到（孤儿空间）不在此报错——episodic 只需 memoryDir，404 由 curated 分支按需抛出
  let wsRoot = root;
  if (!wsRoot) {
    const hit = (await listMemoryWorkspaces({ sessionsDir: sessionsBaseDir(ctx), memoryDir: memoryBaseDir(ctx) }))
      .find((w) => w.id === wsId);
    wsRoot = hit?.path || null;
  }
  return { memoryDir: target.dir, wsId, wsRoot };
}

/** GET /memory/workspaces：聚合「有会话 ∪ 有记忆」的空间清单（方案 D2） */
async function handleMemoryWorkspaces(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspaces = await listMemoryWorkspaces({
    sessionsDir: sessionsBaseDir(ctx),
    memoryDir: memoryBaseDir(ctx),
  });
  sendJson(res, 200, { workspaces });
}

/** GET /memory/curated：三层 Curated 文件全文（?ws= 按空间读取，缺省启动空间） */
async function handleCurated(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const target = await resolveWsTarget(ctx, url);
  if (target) {
    const { config: cfg } = ctx.configLoader.load();
    if (!cfg.memory.enabled) {
      throw new ApiHttpError('conflict', '记忆系统未启用（memory.enabled=false），可经 PUT /config/memory.enabled 开启');
    }
    // 跨空间直读：全局目录与 memory-kit 同口径（{userDir}/curated，默认 ~/.loop-agent/curated）；
    // SOUL/USER 全局区不随 ws 变化（方案 D9）。孤儿空间（仅有记忆、无法锚定空间根）
    // 在 curated 维度 404——workspace 级文件无从定位；episodic 不受影响（只需记忆目录）
    if (!target.wsRoot) {
      throw new ApiHttpError('not_found', `无法定位该空间路径（仅有记忆数据）: ${target.wsId.slice(0, 8)}`);
    }
    const curated = new CuratedMemory(
      target.wsRoot,
      null,
      join(ctx.userDir ?? join(homedir(), '.loop-agent'), 'curated'),
    );
    const files = curated.getFilePaths();
    const entries = await Promise.all(
      (Object.keys(files) as CuratedFileKey[]).map(async (key) => ({
        key,
        path: files[key],
        content: await curated.read(key),
      })),
    );
    sendJson(res, 200, { entries, ws: { id: target.wsId, path: target.wsRoot } });
    return;
  }
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

/** GET /memory/episodic?limit=&ws=：最近 N 天 daily notes（默认 7，上限 90） */
async function handleEpisodic(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kit = await requireMemoryKit(ctx);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limit = queryInt(url, 'limit', 7, 90);
  const target = await resolveWsTarget(ctx, url);
  const entries = target
    ? await readEpisodicDirect(target.memoryDir, limit)
    : await kit.episodic.readRecentDays(limit);
  sendJson(res, 200, {
    entries,
    ...(target ? { ws: { id: target.wsId, path: target.wsRoot } } : {}),
  });
}

/** 跨空间直读：脱离 runtime 用 EpisodicMemory 读文件（init 幂等：建目录 + 索引连接） */
async function readEpisodicDirect(memoryDir: string, days: number): Promise<{ day: string; content: string }[]> {
  const epi = new EpisodicMemory(memoryDir);
  await epi.init();
  return epi.readRecentDays(days);
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

/**
 * POST /memory/dream：异步整理（202 即走即忘，任务内部检查 dreaming.enabled）
 *
 * Task-20261026-002 D11：调度器在时改走调度器，与定时轮/关停兜底共用同一把进程内单飞锁；
 * 已在跑则立即回 `accepted:false`（仍 202：语义是「已受理 / 无需受理」，不引入新错误码）。
 * 调度器未注入（既有单测、嵌入用法）时回落原「即走即忘」行为。
 */
async function handleDream(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const scheduler = ctx.dreamScheduler;
  if (scheduler) {
    const root = ctx.deps.sessionStore.path;
    if (scheduler.isRunning(root)) {
      sendJson(res, 202, { accepted: false, reason: 'manual', skippedBecause: 'already-running' });
      return;
    }
    sendJson(res, 202, { accepted: true, reason: 'manual' });
    // 即走即忘：并发竞态由调度器自身单飞锁兜底（后到者直接跳过，不会重复晋升）
    void scheduler.runFor(root, 'manual').catch((e: unknown) => {
      ctx.log(`[api] memory dream 失败: ${e instanceof Error ? e.message : String(e)}`);
    });
    return;
  }

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

/** GET /memory/status：分层目录 + 计数（未启用恒 200，不报错） */
async function handleMemoryStatus(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  if (!cfg.memory.enabled) {
    sendJson(res, 200, { enabled: false, layers: {}, counts: {} });
    return;
  }
  const kit = await ctx.createMemoryKit();
  // Task-20261026-002 D9：附带自动晋升状态（调度器未注入或该空间未装载时不返回该字段）
  const dreaming = await ctx.dreamScheduler?.statusFor(ctx.deps.sessionStore.path).catch(() => null);
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
    ...(dreaming ? { dreaming } : {}),
  });
}

export function memoryRoutes(): Route[] {
  return [
    { method: 'GET', path: '/memory/status', handler: (ctx, _req, res) => handleMemoryStatus(ctx, _req, res) },
    { method: 'GET', path: '/memory/workspaces', handler: (ctx, _req, res) => handleMemoryWorkspaces(ctx, _req, res) },
    { method: 'GET', path: '/memory/curated', handler: (ctx, _req, res) => handleCurated(ctx, _req, res) },
    { method: 'GET', path: '/memory/episodic', handler: (ctx, req, res) => handleEpisodic(ctx, req, res) },
    { method: 'GET', path: '/memory/search', handler: (ctx, req, res) => handleMemorySearch(ctx, req, res) },
    { method: 'GET', path: '/memory/gate', handler: (ctx, _req, res) => handleGate(ctx, _req, res) },
    { method: 'POST', path: '/memory/dream', handler: (ctx, req, res) => handleDream(ctx, req, res) },
    { method: 'POST', path: '/memory/init', handler: (ctx, _req, res) => handleMemoryInit(ctx, _req, res) },
  ];
}
