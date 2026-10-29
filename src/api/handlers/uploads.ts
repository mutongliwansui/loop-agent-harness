// /upload 命令资源化端点（Task-20261016-002 §3.1）
//
// 直调 src/upload/manager.ts（copyToUploads / listUploads / cleanUploads / buildContextNote），CLI 命令层零改动。
// D5 显式会话绑定：sessionId 必填且必须已存在（404），不隐式建会话；
// contextNote 返回不注入共享 agent，由客户端决定随下轮 /messages 发送（延续 001 D5 隔离哲学）。
//
// GET /uploads/view（20261028-006 D5）：uploads 目录受控只读端点，供对话流工具卡片
// 路径 chip 预览视觉工具的图片落点（~/.loop-agent/uploads/{sessionId}/）。
// 与 /fs/* 的关系：uploads 在工作空间外，/fs/* 一律 403，故单设端点；只读、
// resolveInWs 词法校验 + assertRealInside 符号链接校验 + 只读读取，越界一律 403。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, readRawBody, sendJson } from '../http-utils.js';
import { serveControlledView } from './controlled-view.js';
import {
  buildContextNote,
  cleanUploads,
  copyToUploads,
  formatBytes,
  listUploads,
  MAX_UPLOAD_BYTES,
  writeUpload,
} from '../../upload/manager.js';

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

/**
 * POST /uploads/raw?sessionId=：原始字节上传（WebUI 对话内上传，Task-20261017-001 §3.1b）。
 * 浏览器 File API 拿不到本地完整路径，故 body 直接为文件字节，X-File-Name 头携带
 * encodeURIComponent 后的文件名；复用 writeUpload 落盘规则（时间戳前缀 / 冲突链 / 上限）。
 */
export async function handleUploadRaw(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = await requireSessionId(ctx, querySessionId(req));

  const encoded = req.headers['x-file-name'];
  if (typeof encoded !== 'string' || !encoded.trim()) {
    throw new ApiHttpError('bad_request', '缺少 X-File-Name 请求头（encodeURIComponent 后的文件名）');
  }
  let fileName: string;
  try {
    fileName = decodeURIComponent(encoded);
  } catch {
    throw new ApiHttpError('bad_request', 'X-File-Name 不是合法的 encodeURIComponent 编码');
  }
  fileName = fileName.split(/[\\/]/).pop() ?? ''; // 防路径穿越：仅保留末段纯文件名
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new ApiHttpError('bad_request', '文件名非法');
  }
  if (Buffer.byteLength(fileName, 'utf8') > 200) {
    throw new ApiHttpError('bad_request', '文件名过长（>200 字节）');
  }

  let bytes: Buffer;
  try {
    bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch (e) {
    if (e instanceof ApiHttpError && e.code === 'payload_too_large') {
      throw new ApiHttpError('payload_too_large', `超过单文件上限 ${formatBytes(MAX_UPLOAD_BYTES)}`);
    }
    throw e;
  }

  const entry = await writeUpload(fileName, bytes, { sessionKey: sessionId, uploadsRoot: ctx.uploadsRoot });
  ctx.log(`[api] 会话 ${sessionId} raw 上传成功 ${entry.fileName}（${formatBytes(entry.bytes)}）`);
  sendJson(res, 201, {
    sessionId,
    entries: [{ originalPath: '', targetPath: entry.targetPath, fileName: entry.fileName, bytes: entry.bytes }],
    contextNote: buildContextNote(entry),
  });
}

/** GET /uploads?sessionId=：列出会话上传目录 */
export async function handleListUploads(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = await requireSessionId(ctx, querySessionId(req));
  const entries = await listUploads(ctx.uploadsRoot, sessionId);
  sendJson(res, 200, { sessionId, entries });
}

/* ================= GET /uploads/view（20261028-006 D5/D6；20261028-007 收敛到 controlled-view） ================= */

// 常量与 Content-Type 表上移至 controlled-view.ts，此处 re-export 以免影响既有 import。
export {
  MAX_VIEW_TEXT_BYTES,
  MAX_VIEW_RAW_BYTES,
  VIEW_BINARY_SNIFF_BYTES,
  VIEW_CONTENT_TYPES,
  expandHomeInput,
} from './controlled-view.js';

/** 从 query 取参数（req.url 仅含 path+query） */
function viewQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams;
}

/**
 * GET /uploads/view?path=&disp=file|raw：uploads 根内文件受控只读。
 * - path：相对 uploads 根（如 `<sessionId>/<file>`）、绝对路径或 `~` 字面量——归一后必须位于 uploads 根内；
 *   `~` 开头输入先按 homedir 展开（20261028-007 D3，修复 `~/.loop-agent/...` 解析到 `<root>/~/...` 的 404 缺口）；
 * - disp=file：文本预览（utf-8、>512KB 截断、含 NUL 判二进制拒绝），响应与 /fs/file 同构；
 * - disp=raw：原始字节（图片/文档），Content-Type 按扩展名，上限 100MB。
 * 校验链统一在 controlled-view.ts：词法防穿越 → 符号链接防逃逸 → 只读读取。
 */
export async function handleUploadView(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = viewQuery(req);
  const input = query.get('path')?.trim() ?? '';
  if (!input) throw new ApiHttpError('bad_request', '缺少 path 参数');
  const disp = query.get('disp') === 'raw' ? 'raw' : 'file';
  await serveControlledView(ctx.uploadsRoot, input, disp, res);
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
    { method: 'POST', path: '/uploads/raw', handler: (ctx, req, res) => handleUploadRaw(ctx, req, res) },
    { method: 'GET', path: '/uploads/view', handler: (ctx, req, res) => handleUploadView(ctx, req, res) },
    { method: 'POST', path: '/uploads', handler: (ctx, req, res) => handleUpload(ctx, req, res) },
    { method: 'GET', path: '/uploads', handler: (ctx, req, res) => handleListUploads(ctx, req, res) },
    { method: 'DELETE', path: '/uploads', handler: (ctx, req, res) => handleCleanUploads(ctx, req, res) },
  ];
}
