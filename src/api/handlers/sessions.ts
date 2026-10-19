// /sessions 与 /sessions/:id 的 CRUD 处理器
//
// POST /sessions 支持 { title?, workspacePath? }（原型-20261017-004）：
// - 同空间：直接创建空会话
// - 异空间：校验目录 → 全局无 in-flight → process.chdir + store 原地重绑 + 配置跟随 + scaffold 初始化
//   + 重置记忆缓存 + 重建 agent 记忆 → 创建
// - GET /fs/dirs：服务端目录浏览（新建会话选择工作空间；纯 Web 拿不到本地绝对路径）
// - GET /sessions/:id：跨空间会话自动切换到会话所在空间（switchWorkspace 导出供 messages 兜底复用）

import { constants, type Dirent } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { resetMemoryKitCache } from '../memory-kit.js';
import { SessionStore } from '../../session/index.js';
import { stripMemorySection } from '../../memory/memory-section.js';
import { isEphemeral } from '../../memory/working.js';
import { defaultBootstrapPaths, ensureScaffold } from '../../bootstrap/index.js';

/** 归一化目录输入：'D:' → 'D:\'；其余走 resolve（相对路径基于服务端 cwd 展开） */
function normalizeDirPath(input: string): string {
  const p = input.trim();
  const m = p.match(/^([A-Za-z]:)\\?$/);
  if (m) return m[1].toUpperCase() + '\\';
  return resolve(p);
}

/** Windows 路径比较忽略大小写与分隔符差异 */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

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
  const target = normalizeDirPath(query.get('path')?.trim() || ctx.deps.sessionStore.path);
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
    const target = normalizeDirPath(requested);
    if (!samePath(target, ctx.deps.sessionStore.path)) {
      await ensureDirUsable(target);
      if (ctx.sessions.hasInFlight()) {
        throw new ApiHttpError('busy', '存在正在处理的会话，暂不能切换工作空间');
      }
      await switchWorkspace(ctx, target);
      switched = true;
    }
  }

  const meta = await ctx.sessions.createSessionSafe(title, [], []);
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

/** 校验目标目录存在且可进入（stat + access R|X） */
async function ensureDirUsable(target: string): Promise<void> {
  let isDir: boolean;
  try {
    isDir = (await stat(target)).isDirectory();
  } catch {
    throw new ApiHttpError('not_found', `目录不存在: ${target}`);
  }
  if (!isDir) throw new ApiHttpError('not_found', `不是目录: ${target}`);
  try {
    await access(target, constants.R_OK | constants.X_OK);
  } catch {
    throw new ApiHttpError('forbidden', `无权访问目录: ${target}`);
  }
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
  // 重建 agent 实例记忆（L1/L2/L3 绑定新空间）；失败不阻断已成功的切换，仅记日志
  try {
    await ctx.reinitMemory?.(target);
  } catch (e) {
    ctx.log(`[api] 切换后 agent 记忆重建失败（沿用旧空间记忆直至重启）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** GET /sessions：会话列表 */
export async function handleListSessions(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const list = await ctx.deps.sessionStore.listSessions();
  sendJson(res, 200, { sessions: list });
}

/** GET /workspaces：跨工作空间聚合（名称 + 会话列表；当前空间置顶） */
export async function handleListWorkspaces(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const workspaces = await ctx.deps.sessionStore.listAllWorkspaces();
  sendJson(res, 200, { workspaces });
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

  // 压缩状态：lastSummary 存在或 archivedCount > 0 表示历史已被压缩，恢复视图只保留最近 N 轮
  const compacted = Boolean(data.lastSummary) || (data.archivedCount ?? 0) > 0;
  sendJson(res, 200, {
    meta,
    compaction: {
      compacted,
      archivedCount: data.archivedCount ?? 0,
      hasSummary: Boolean(data.lastSummary),
    },
    // 完整历史供前端渲染（data.messages 为全量字段，updateSession 每轮持久化；异常缺失时兜底恢复视图）。
    // 展示层永不渲染 ephemeral 占位（兜底恢复视图会带出「历史摘要」占位，见三视图统一方案 4.3）。
    // user 消息统一剥离 L2 记忆前缀：修复前的存量数据已把前缀写进持久化历史，展示层清洗一次到位
    messages: (data.messages?.length ? data.messages : SessionStore.getRestoreMessages(data))
      .filter((m) => !isEphemeral(m))
      .map((m) =>
        m.role === 'user' && typeof m.content === 'string'
          ? { ...m, content: stripMemorySection(m.content) }
          : m,
      ),
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
  ctx.log(`[api] 会话已删除: ${id}`);
  sendJson(res, 200, { deleted: true });
}
