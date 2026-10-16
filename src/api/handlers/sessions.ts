// /sessions 与 /sessions/:id 的 CRUD 处理器

import type { ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import { SessionStore } from '../../session/index.js';

/** POST /sessions：创建空会话 */
export async function handleCreateSession(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const meta = await ctx.sessions.createSessionSafe('', [], []);
  ctx.sessions.set(meta.id, { history: [], inFlight: null });
  ctx.log(`[api] 会话已创建: ${meta.id}`);
  sendJson(res, 201, {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
  });
}

/** GET /sessions：会话列表 */
export async function handleListSessions(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const list = await ctx.deps.sessionStore.listSessions();
  sendJson(res, 200, { sessions: list });
}

/** GET /sessions/:id：会话详情（恢复视图，不含 system） */
export async function handleGetSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  const metas = await ctx.deps.sessionStore.listSessions();
  const meta = metas.find((s) => s.id === id);
  if (!meta) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  const data = await ctx.deps.sessionStore.loadSession(id);
  sendJson(res, 200, { meta, messages: SessionStore.getRestoreMessages(data) });
}

/** DELETE /sessions/:id：删除会话并清缓存；存在 in-flight run 时拒绝 */
export async function handleDeleteSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  const entry = ctx.sessions.get(id);
  if (entry?.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理消息，暂不能删除`);
  }
  const metas = await ctx.deps.sessionStore.listSessions();
  if (!metas.some((s) => s.id === id)) {
    throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  }
  await ctx.deps.sessionStore.deleteSession(id);
  ctx.sessions.delete(id);
  ctx.log(`[api] 会话已删除: ${id}`);
  sendJson(res, 200, { deleted: true });
}
