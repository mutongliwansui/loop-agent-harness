// /upload 命令资源化端点（Task-20261016-002 §3.1）
//
// 直调 src/upload/manager.ts（copyToUploads / listUploads / cleanUploads / buildContextNote），CLI 命令层零改动。
// D5 显式会话绑定：sessionId 必填且必须已存在（404），不隐式建会话；
// contextNote 返回不注入共享 agent，由客户端决定随下轮 /messages 发送（延续 001 D5 隔离哲学）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { buildContextNote, cleanUploads, copyToUploads, listUploads } from '../../upload/manager.js';

/** 校验并返回会话 id：缺失 → 400；会话不存在 → 404（复用 SessionManager 恢复逻辑） */
async function requireSessionId(ctx: HandlerContext, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiHttpError('bad_request', 'sessionId 必填');
  }
  await ctx.sessions.ensureEntry(raw); // 缓存 miss → store 恢复；不存在抛 404
  return raw;
}

/** 从 query string 取 sessionId */
function querySessionId(req: IncomingMessage): unknown {
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId');
}

/** POST /uploads：复制文件到会话上传目录（部分成功语义：至少一个成功即 201，全败 400） */
export async function handleUpload(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = await requireSessionId(ctx, body.sessionId);
  if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.some((p) => typeof p !== 'string')) {
    throw new ApiHttpError('bad_request', 'paths 必须为非空字符串数组');
  }

  const result = await copyToUploads(body.paths as string[], { sessionKey: sessionId, uploadsRoot: ctx.uploadsRoot });
  if (result.succeeded.length === 0) {
    const detail = result.failed.map((f) => `${f.path}（${f.reason}）`).join('; ');
    throw new ApiHttpError('bad_request', `全部文件上传失败: ${detail}`);
  }

  ctx.log(`[api] 会话 ${sessionId} 上传成功 ${result.succeeded.length}/${body.paths.length} 个文件`);
  sendJson(res, 201, {
    sessionId,
    entries: result.succeeded.map((e) => ({ originalPath: e.originalPath, targetPath: e.targetPath, bytes: e.bytes })),
    contextNote: result.succeeded.map(buildContextNote).join('\n'),
    failed: result.failed,
  });
}

/** GET /uploads?sessionId=：列出会话上传目录 */
export async function handleListUploads(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = await requireSessionId(ctx, querySessionId(req));
  const entries = await listUploads(ctx.uploadsRoot, sessionId);
  sendJson(res, 200, { sessionId, entries });
}

/** DELETE /uploads?sessionId=：清理会话上传目录（removed 表示是否删除了内容） */
export async function handleCleanUploads(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = await requireSessionId(ctx, querySessionId(req));
  const removed = await cleanUploads(ctx.uploadsRoot, sessionId);
  ctx.log(`[api] 会话 ${sessionId} 上传目录清理: ${removed ? '已删除' : '目录为空或不存在'}`);
  sendJson(res, 200, { sessionId, removed });
}

export function uploadRoutes(): Route[] {
  return [
    { method: 'POST', path: '/uploads', handler: (ctx, req, res) => handleUpload(ctx, req, res) },
    { method: 'GET', path: '/uploads', handler: (ctx, req, res) => handleListUploads(ctx, req, res) },
    { method: 'DELETE', path: '/uploads', handler: (ctx, req, res) => handleCleanUploads(ctx, req, res) },
  ];
}
