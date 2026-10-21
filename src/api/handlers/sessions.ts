// /sessions 与 /sessions/:id 的 CRUD 处理器
//
// POST /sessions 支持 { title?, workspacePath? }（原型-20261017-004）：
// - 同空间：直接创建空会话
// - 异空间：校验目录 → 全局无 in-flight → process.chdir + store 原地重绑 + 配置跟随 + scaffold 初始化
//   + 重置记忆缓存 + 重建 agent 记忆 → 创建
// - GET /fs/dirs：服务端目录浏览（新建会话选择工作空间；纯 Web 拿不到本地绝对路径）
// - GET /sessions/:id：跨空间会话自动切换到会话所在空间（switchWorkspace 导出供 messages 兜底复用）
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
import { resetMemoryKitCache } from '../memory-kit.js';
import { ensureDirUsable } from '../workspace-runtime.js';
import { canonicalWorkspacePath, isSameWorkspace, lexicalWorkspacePath } from '../../session/path-utils.js';
import { SessionStore } from '../../session/index.js';
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

/** POST /sessions：创建空会话；body 可带 { title?, workspacePath? }，异空间时切换服务端工作空间 */
export async function handleCreateSession(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const title = typeof body.title === 'string' ? body.title : '';
  const requested = typeof body.workspacePath === 'string' ? body.workspacePath.trim() : '';

  let switched = false;
  if (requested) {
    // 空间身份按 canonical 形式比较（'D:' 特例 + 绝对化 + win32 真实大小写，D2/L2）
    const target = await canonicalWorkspacePath(requested);
    const current = await canonicalWorkspacePath(ctx.deps.sessionStore.path);
    if (!isSameWorkspace(target, current)) {
      await ensureDirUsable(target);
      if (ctx.sessions.hasInFlight()) {
        throw new ApiHttpError('busy', '存在正在处理的会话，暂不能切换工作空间');
      }
      await switchWorkspace(ctx, target);
      switched = true;
    }
  }

  const meta = await ctx.sessions.createSessionSafe(title, []);
  ctx.sessions.set(meta.id, { history: [], inFlight: null });
  ctx.log(`[api] 会话已创建: ${meta.id}${switched ? `（已切换工作空间: ${ctx.deps.sessionStore.path}）` : ''}`);
  sendJson(res, 201, {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    workspace: { path: ctx.deps.sessionStore.path, id: ctx.deps.sessionStore.id, switched },
  });
}

/** 切换服务端工作空间：chdir + store 原地重绑 + 配置分层跟随 + 目录初始化（scaffold）+ 重置记忆缓存 + 重建 agent 实例记忆；rebind 失败时回滚 chdir */
export async function switchWorkspace(ctx: HandlerContext, target: string): Promise<void> {
  const prevCwd = process.cwd();
  process.chdir(target);
  try {
    await ctx.deps.sessionStore.rebindWorkspace(target);
  } catch (e) {
    process.chdir(prevCwd);
    throw new ApiHttpError('internal', `切换工作空间失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 配置分层跟随：loader/writer 的 workspace 层指向新空间（全局层不变），后续 /config 读写即生效
  ctx.configLoader.setWorkspacePath(target);
  ctx.configWriter.setWorkspacePath(target);
  resetMemoryKitCache();
  // 初始化新空间目录骨架：两级 skills 目录 + 工作空间配置骨架文件（幂等，已存在跳过；失败不阻断已成功的切换）
  try {
    await ensureScaffold(defaultBootstrapPaths());
  } catch (e) {
    ctx.log(`[api] 工作空间初始化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 记忆/池重建（Task-20261021-002-05 D6）：清共享 kit 缓存 + 重置 AgentPool
  //（池内实例的记忆绑定旧 workspaceId，整体重建最稳妥）；失败不阻断已成功的切换，仅记日志
  try {
    await ctx.reinitMemory?.(target);
  } catch (e) {
    ctx.log(`[api] 切换后记忆/实例池重建失败（沿用旧实例直至重启）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** GET /sessions：会话列表 */
export async function handleListSessions(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const list = await ctx.deps.sessionStore.listSessions();
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

/** GET /workspaces：跨工作空间聚合（名称 + 会话列表；当前空间置顶；注入 running 与 lastRun 概要供侧栏标记） */
export async function handleListWorkspaces(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const workspaces = await ctx.deps.sessionStore.listAllWorkspaces();
  const enriched = await Promise.all(
    workspaces.map(async (w) => ({
      ...w,
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

/** GET /sessions/:id：会话详情（完整历史，不含 system；支持跨工作空间会话——点击时自动切换到会话所在空间） */
export async function handleGetSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  const owner = (await ctx.deps.sessionStore.listAllWorkspaces()).find((w) =>
    w.sessions.some((s) => s.id === id),
  );
  if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  const meta = owner.sessions.find((s) => s.id === id);
  const data = await ctx.deps.sessionStore.loadSession(id);

  // 跨空间会话：自动切换到会话所在空间（无 in-flight 才切；失败静默记日志，不阻断只读查看）
  let switched = false;
  if (!owner.current && !ctx.sessions.hasInFlight()) {
    try {
      await switchWorkspace(ctx, owner.path);
      switched = true;
    } catch (e) {
      ctx.log(`[api] 查看会话自动切换空间失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 展示层：返回全量历史 data.messages（单一真源，含 system 与压缩总结消息）。
  // system 与压缩总结消息带 is_show=false，前端据此过滤；用户消息的 content 为原始输入
  // （存量会话可能残留 L2 记忆前缀），前端用 show_content 兜底还原。
  const messages = SessionStore.getAllAvailableMessages(data);
  sendJson(res, 200, {
    meta,
    messages,
    run: ctx.runs.snapshot(id), // 运行中概览（前端决定是否 attach 续传）
    // run journal 磁盘态（Task-20261021-002-06）：与内存 run 并列；重启后 run=null 但 lastRun 仍在
    lastRun: await readJournal(ctx.deps.sessionStore, id),
    workspace: { path: ctx.deps.sessionStore.path, id: ctx.deps.sessionStore.id, switched },
  });
}

/** DELETE /sessions/:id：删除会话并清缓存；存在 in-flight run 时拒绝（支持跨工作空间会话） */
export async function handleDeleteSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  const entry = ctx.sessions.get(id);
  if (entry?.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理消息，暂不能删除`);
  }
  const owner = (await ctx.deps.sessionStore.listAllWorkspaces()).find((w) =>
    w.sessions.some((s) => s.id === id),
  );
  if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  await ctx.deps.sessionStore.deleteSession(id);
  ctx.sessions.delete(id);
  ctx.runs.drop(id);
  // journal 联动删除（Task-20261021-002-06）：会话删除后 runs/<id>.json 一并清掉
  await dropJournal(ctx.deps.sessionStore, id);
  ctx.log(`[api] 会话已删除: ${id}`);
  sendJson(res, 200, { deleted: true });
}
