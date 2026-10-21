// /sessions 与 /sessions/:id 的 CRUD 处理器
//
// POST /sessions 支持 { title?, workspacePath? }（原型-20261017-004）：
// - 同空间：直接创建空会话
// - 异空间：校验目录 → 直接在目标空间的 runtime 创建（task-04 起不再全局 busy 互斥；
//   仅做"当前空间指针刷新"，不 chdir、不影响其他空间运行中的 run）
// - GET /fs/dirs：服务端目录浏览（新建会话选择工作空间；纯 Web 拿不到本地绝对路径）
// - GET /sessions/:id / DELETE /sessions/:id：按 sessionId 定位归属 runtime（D17），
//   跨空间会话只读/删除均不再切换"当前空间"
//
// 解耦（Task-20261021-010-03/04）：每个空间由 registry 懒建不可变 runtime
// （store/configLoader/configWriter/skillLoader/sessions/pool 均为该 runtime 的实例）；
// "当前空间"退化为 registry 的最近使用指针（D9），/workspaces 的 current 由它标注。
//
// 路径归一（Task-20261021-010-01 L2）：'D:' 盘符特例与绝对化统一由 session/path-utils 提供，
// 本文件不再保留私有实现——展示型回显用 lexicalWorkspacePath（取值与改造前一致），
// 空间身份比较用 canonicalWorkspacePath + isSameWorkspace。

import { type Dirent } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { ensureDirUsable, type WorkspaceRuntime } from '../workspace-runtime.js';
import { locateSession, resolveCurrentRuntime } from '../session-locator.js';
import { canonicalWorkspacePath, isSameWorkspace, lexicalWorkspacePath } from '../../session/path-utils.js';
import { SessionStore, workspaceId } from '../../session/index.js';
import { defaultBootstrapPaths, ensureScaffold } from '../../bootstrap/index.js';
import { readJournal, dropJournal } from '../run-journal.js';

/** 枚举本机盘符（Windows；返回 'C:\' 形式，非 Windows 返回空） */
async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const found: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:\\`;
    try {
      await access(drive);
      found.push(drive);
    } catch {
      // 盘符不存在：跳过
    }
  }
  return found;
}

/** GET /fs/dirs?path=：列出目录下的子目录；path 缺省为当前空间，盘根 parent=null，drives 供跳盘 */
export async function handleListDirs(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const target = lexicalWorkspacePath(query.get('path')?.trim() || ctx.deps.sessionStore.path);
  let isDir: boolean;
  try {
    isDir = (await stat(target)).isDirectory();
  } catch {
    throw new ApiHttpError('not_found', `目录不存在: ${target}`);
  }
  if (!isDir) throw new ApiHttpError('not_found', `不是目录: ${target}`);
  let entries: Dirent[];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    throw new ApiHttpError('forbidden', `无权读取目录: ${target}`);
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const isRoot = /^[A-Za-z]:\\$/.test(target);
  sendJson(res, 200, {
    path: target,
    parent: isRoot ? null : dirname(target),
    dirs,
    drives: await listDrives(),
  });
}

/**
 * 切换"当前空间指针"（Task-20261021-010-03 D7；task-04 D9 退化语义）：
 * registry 为目标空间懒建不可变 runtime，handler 侧六项依赖整体指向它——
 * 不 chdir、不原地重绑、不重置记忆/池、不干预其他空间运行中的 run。
 * task-04 起不再做全局 busy 互斥（per-space 互斥由归属 runtime 的 sessions 保证）。
 */
export async function switchWorkspace(ctx: HandlerContext, target: string): Promise<WorkspaceRuntime> {
  const registry = ctx.registry;
  if (!registry) {
    throw new ApiHttpError('internal', '工作空间注册表未初始化，无法切换工作空间');
  }
  const root = await registry.ensureRoot(target);
  const rt = await registry.getCanonical(root);

  // 指针刷新：以下字段均来自 runtime（实例本身不可变，仅替换 handler 的引用）
  ctx.deps.sessionStore = rt.store;
  ctx.deps.runAgent = (sessionId, input, options) => rt.runAgent(sessionId, input, options);
  // 鉴权 token / 模型名等随当前空间配置生效
  ctx.deps.getConfig = () => rt.configLoader.load().config;
  ctx.sessions = rt.sessions;
  ctx.configLoader = rt.configLoader;
  ctx.configWriter = rt.configWriter;
  ctx.skillLoader = rt.skillLoader;
  ctx.createMemoryKit = () => rt.getMemoryKit();

  // 初始化新空间目录骨架：两级 skills 目录 + 工作空间配置骨架文件（幂等，已存在跳过）
  try {
    await ensureScaffold(defaultBootstrapPaths(rt.root));
  } catch (e) {
    ctx.log(`[api] 工作空间初始化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return rt;
}

/** POST /sessions：创建空会话；body 可带 { title?, workspacePath? }
 *  task-04：带 workspacePath 时直接在目标空间创建（只刷新当前空间指针，无 busy 判定）；
 *  响应 workspace.switched 字段保留但恒 false（L2，task-05 前端移除依赖）。 */
export async function handleCreateSession(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const title = typeof body.title === 'string' ? body.title : '';
  const requested = typeof body.workspacePath === 'string' ? body.workspacePath.trim() : '';

  let rt: WorkspaceRuntime | null = null;
  if (requested) {
    // 空间身份按 canonical 形式比较（'D:' 特例 + 绝对化 + win32 真实大小写，D2/L2）
    const target = await canonicalWorkspacePath(requested);
    const current = await canonicalWorkspacePath(ctx.deps.sessionStore.path);
    if (!isSameWorkspace(target, current)) {
      // 目录校验先于创建（保持改造前错误优先级）
      if (ctx.registry) await ctx.registry.ensureRoot(target);
      else await ensureDirUsable(target);
      rt = await switchWorkspace(ctx, target);
    }
  } else if (ctx.registry) {
    // 缺省建在"最近使用空间"（D9）：registry.currentRoot 优先，回落注入 store 所在空间
    rt = await resolveCurrentRuntime(ctx.registry, ctx.deps.sessionStore.path);
  }

  const sessions = rt?.sessions ?? ctx.sessions;
  const store = rt?.store ?? ctx.deps.sessionStore;
  const meta = await sessions.createSessionSafe(title, []);
  sessions.set(meta.id, { history: [], inFlight: null });
  ctx.log(`[api] 会话已创建: ${meta.id}${rt ? `（目标工作空间: ${store.path}）` : ''}`);
  sendJson(res, 201, {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    workspace: { path: store.path, id: store.id, switched: false },
  });
}

/** GET /sessions：当前空间（D9 最近使用指针）的会话列表 */
export async function handleListSessions(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const store = ctx.registry
    ? (await resolveCurrentRuntime(ctx.registry, ctx.deps.sessionStore.path)).store
    : ctx.deps.sessionStore;
  const list = await store.listSessions();
  sendJson(res, 200, { sessions: list });
}

/** run journal 概要（列表用，D7：只暴露 status/finishedAt 控制体量） */
async function readJournalSummary(
  store: SessionStore,
  id: string,
): Promise<{ status: string; finishedAt?: number } | null> {
  const jr = await readJournal(store, id);
  return jr ? { status: jr.status, finishedAt: jr.finishedAt } : null;
}

/** GET /workspaces：跨工作空间聚合（名称 + 会话列表；当前空间置顶；注入 running 与 lastRun 概要供侧栏标记）
 *  task-04（D9）：current 标记改由 registry 的"最近使用指针"覆写，不再依赖单一 store 视角。 */
export async function handleListWorkspaces(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const workspaces = await ctx.deps.sessionStore.listAllWorkspaces();
  const currentId = ctx.registry?.currentRoot ? workspaceId(ctx.registry.currentRoot) : null;
  const enriched = await Promise.all(
    workspaces.map(async (w) => ({
      ...w,
      current: currentId ? w.id === currentId : w.current,
      sessions: await Promise.all(
        w.sessions.map(async (s) => ({
          ...s,
          running: ctx.runs.isRunning(s.id),
          // run journal 概要（Task-20261021-002-06 D7）：仅 status/finishedAt 两个字段，控制列表体量
          lastRun: await readJournalSummary(ctx.deps.sessionStore, s.id),
        })),
      ),
    })),
  );
  sendJson(res, 200, { workspaces: enriched });
}

/** GET /sessions/:id：会话详情（完整历史，不含 system；task-04 起按 id 定位归属空间，不再自动切换） */
export async function handleGetSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  if (ctx.registry) {
    // 按 sessionId 定位归属 runtime（D17：新 id 段解析 / 老 id 映射缓存 + 全扫回退）；
    // 不切换"当前空间"，读取/续聊都在会话所属 runtime 内完成
    const rt = await locateSession(ctx.registry, id);
    const meta = (await rt.store.listSessions()).find((s) => s.id === id);
    const data = await rt.store.loadSession(id);
    // 展示层：返回全量历史 data.messages（单一真源，含 system 与压缩总结消息）。
    // system 与压缩总结消息带 is_show=false，前端据此过滤；用户消息的 content 为原始输入
    // （存量会话可能残留 L2 记忆前缀），前端用 show_content 兜底还原。
    const messages = SessionStore.getAllAvailableMessages(data);
    sendJson(res, 200, {
      meta,
      messages,
      run: ctx.runs.snapshot(id), // 运行中概览（前端决定是否 attach 续传）
      // run journal 磁盘态（Task-20261021-002-06）：与内存 run 并列；重启后 run=null 但 lastRun 仍在
      lastRun: await readJournal(rt.store, id),
      // switched 字段保留但恒 false（L2，task-05 前端移除依赖）
      workspace: { path: rt.store.path, id: rt.store.id, switched: false },
    });
    return;
  }

  // 无 registry 的嵌入形态：保持旧逻辑（跨空间只读查看，不切换空间）
  const owner = (await ctx.deps.sessionStore.listAllWorkspaces()).find((w) =>
    w.sessions.some((s) => s.id === id),
  );
  if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  const meta = owner.sessions.find((s) => s.id === id);
  const data = await ctx.deps.sessionStore.loadSession(id);
  const messages = SessionStore.getAllAvailableMessages(data);
  sendJson(res, 200, {
    meta,
    messages,
    run: ctx.runs.snapshot(id),
    lastRun: await readJournal(ctx.deps.sessionStore, id),
    workspace: { path: ctx.deps.sessionStore.path, id: ctx.deps.sessionStore.id, switched: false },
  });
}

/** DELETE /sessions：按 id 定位归属空间后删除；归属空间内存在 in-flight run 时拒绝（per-space 互斥） */
export async function handleDeleteSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  let store = ctx.deps.sessionStore;
  let sessions = ctx.sessions;
  if (ctx.registry) {
    const rt = await locateSession(ctx.registry, id);
    store = rt.store;
    sessions = rt.sessions;
  } else {
    // 无 registry：保持旧 not_found 校验（跨空间全扫）
    const owner = (await store.listAllWorkspaces()).find((w) => w.sessions.some((s) => s.id === id));
    if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  }
  // per-space 互斥：仅当归属空间内该会话正在跑才拒绝（其他空间的 run 不影响）
  const entry = sessions.get(id);
  if (entry?.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理消息，暂不能删除`);
  }
  await store.deleteSession(id);
  sessions.delete(id);
  ctx.runs.drop(id);
  // journal 联动删除（Task-20261021-002-06）：会话删除后 runs/<id>.json 一并清掉
  await dropJournal(store, id);
  ctx.log(`[api] 会话已删除: ${id}`);
  sendJson(res, 200, { deleted: true });
}
