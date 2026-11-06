// REST API 封装（Task-20261017-001 D5/D6）
// - 自动注入 Bearer（token 存 localStorage）
// - 401 → 清 token + 置 needAuth（TokenGate 弹出）
// - 非 2xx → 解析 {error:{code,message}} 抛 ApiError

import { ref } from 'vue';
import type { ApiDocsPayload } from '../api-docs-ui';

export class AuthError extends Error {
  constructor() {
    super('需要访问令牌');
    this.name = 'AuthError';
  }
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'loop_agent_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 401 全局信号：TokenGate 据此弹出令牌输入门 */
export const needAuth = ref(false);

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function throwFor(res: Response): Promise<never> {
  if (res.status === 401) {
    clearToken();
    needAuth.value = true;
    throw new AuthError();
  }
  let code = 'http_error';
  let message = `请求失败（HTTP ${res.status}）`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // 非 JSON 响应保留默认消息
  }
  throw new ApiError(code, message, res.status);
}

/** 通用 JSON API 调用：init.json 存在时序列化为请求体 */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
    const res = await fetch(path, { ...init, headers, body });
  if (res.status === 204) return undefined as T; // 204 无响应体（如 POST /sessions/:id/stop 幂等空态）
  if (!res.ok) await throwFor(res);
  return (await res.json()) as T;
}

/** 通用 JSON API 调用（不解析响应体），返回 HTTP 状态码：供需区分 202/204 等语义的端点使用 */
export async function apiStatus(path: string, init: RequestInit & { json?: unknown } = {}): Promise<number> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body });
  if (res.status === 401) {
    clearToken();
    needAuth.value = true;
    throw new AuthError();
  }
  if (!res.ok) await throwFor(res);
  return res.status;
}

/** 原始文件下载（GET /fs/raw：自动注入 Bearer；供 pdf iframe / Office 文档前端解析）
 *  ws 为会话所属工作空间绝对路径（后端据此切换根；缺省回落启动空间） */
export async function fetchRaw(path: string, ws?: string): Promise<Blob> {
  const wsParam = ws ? `&ws=${encodeURIComponent(ws)}` : '';
  const res = await fetch(`/fs/raw?path=${encodeURIComponent(path)}${wsParam}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await throwFor(res);
  return await res.blob();
}

/** 原始字节上传（POST /uploads/raw：body=文件字节，X-File-Name=encodeURIComponent 文件名）
 *  fileName 可选：仅替换 X-File-Name 头（body 仍是原 file），供粘贴链路上传重命名后的名字
 *  （task-20261028-005 D5：不构造新 File，避免 blob 复制与 lastModified 脱钩） */
export async function uploadRaw(
  file: File,
  sessionId: string,
  fileName?: string,
): Promise<{ fileName: string; bytes: number; contextNote: string }> {
  const res = await fetch(`/uploads/raw?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent(fileName ?? file.name), ...authHeaders() },
    body: file,
  });
  if (!res.ok) await throwFor(res);
  const body = (await res.json()) as {
    entries: { fileName: string; bytes: number }[];
    contextNote: string;
  };
  const entry = body.entries[0];
  if (!entry) throw new ApiError('empty_response', '上传响应缺少条目', res.status);
  return { fileName: entry.fileName, bytes: entry.bytes, contextNote: body.contextNote };
}

/* ================= 工作空间文件写操作与下载（优化建议 20261021-005） ================= */

/** ws 查询参数（文件面板跟随活跃会话所属工作空间） */
function wsParam(ws?: string): string {
  return ws ? `&ws=${encodeURIComponent(ws)}` : '';
}

/** 删除文件/目录（目录必须 recursive=true；根目录与 .git/.loop-agent 后端拒绝） */
export async function deleteFsEntry(
  path: string,
  recursive: boolean,
  ws?: string,
): Promise<{ path: string; type: 'dir' | 'file' }> {
  const qs = `path=${encodeURIComponent(path)}${recursive ? '&recursive=1' : ''}${wsParam(ws)}`;
  const res = await fetch(`/fs/entry?${qs}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) await throwFor(res);
  return (await res.json()) as { path: string; type: 'dir' | 'file' };
}

/** 重命名/移动（同空间内相对路径；目标已存在 409） */
export async function renameFsEntry(
  from: string,
  to: string,
  ws?: string,
): Promise<{ from: string; to: string; type: 'dir' | 'file' }> {
  const res = await fetch(`/fs/rename?ws=${encodeURIComponent(ws ?? '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) await throwFor(res);
  return (await res.json()) as { from: string; to: string; type: 'dir' | 'file' };
}

/** 新建目录（父目录必须存在） */
export async function mkdirFs(path: string, ws?: string): Promise<{ path: string }> {
  const res = await fetch(`/fs/mkdir?ws=${encodeURIComponent(ws ?? '')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) await throwFor(res);
  return (await res.json()) as { path: string };
}

/** 上传单个文件到工作空间目录（X-Relative-Path 支持目录上传的层级；冲突策略默认 rename） */
export async function uploadToWorkspace(
  file: File,
  dir: string,
  opts: { relativePath?: string; conflict?: 'rename' | 'overwrite' | 'skip'; ws?: string } = {},
): Promise<{ path: string; bytes: number; skipped?: boolean }> {
  const headers = new Headers(authHeaders());
  headers.set('x-file-name', encodeURIComponent(file.name));
  if (opts.relativePath) headers.set('x-relative-path', encodeURIComponent(opts.relativePath));
  if (opts.conflict) headers.set('x-conflict', opts.conflict);
  const res = await fetch(`/fs/upload?path=${encodeURIComponent(dir)}${wsParam(opts.ws)}`, {
    method: 'POST',
    headers,
    body: file,
  });
  if (!res.ok) await throwFor(res);
  return (await res.json()) as { path: string; bytes: number; skipped?: boolean };
}

/** 从 Content-Disposition 解析文件名：优先 filename*=UTF-8''，回退 filename="" */
function dispositionName(cd: string): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // 非法编码回退 ASCII 分支
    }
  }
  const plain = /filename="([^"]*)"/i.exec(cd);
  return plain?.[1] ?? '';
}

/** 下载文件或目录 zip：返回 Blob 与建议文件名（Bearer 走请求头，故不能直接用 <a href>） */export async function downloadFsEntry(path: string, ws?: string): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(`/fs/download?path=${encodeURIComponent(path)}${wsParam(ws)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await throwFor(res);
  const fallback = (path.split('/').pop() || 'download').replace(/\/+$/, '');
  const name = dispositionName(res.headers.get('content-disposition') ?? '') || fallback;
  return { blob: await res.blob(), name };
}

/* ================= 开发者中心（需求 20261104-002） ================= */

/**
 * 反射式 API 文档：后端从路由表反射出端点全集，叠加中文说明与分组后返回。
 * 页面统计口径以返回的 stats 为准（total / documented），不在前端自行计数。
 */
export async function fetchApiDocs(): Promise<ApiDocsPayload> {
  return await api<ApiDocsPayload>('/dev/api-docs');
}

/* ================= 会话上下文用量与手动压缩（需求 20261106-005） ================= */

/** 上下文用量（GET /sessions/:id/context）：真实统计优先，历史会话为估算 */
export interface SessionContextUsage {
  contextTokens: number;
  maxTokens: number;
  threshold: number;
  /** 0–100，1 位小数 */
  percent: number;
  source: 'stats' | 'estimate';
  /** source='stats' 的采集时间（ISO） */
  updatedAt?: string;
}

export async function fetchSessionContext(id: string): Promise<SessionContextUsage> {
  return await api<SessionContextUsage>(`/sessions/${encodeURIComponent(id)}/context`);
}

/** 手动压缩结果（POST /sessions/:id/compact）；ok=false 也是 200，用 reason 区分原因 */
export interface CompactSessionResult {
  ok: boolean;
  reason?: 'memory_disabled' | 'nothing_to_compact' | 'flush_failed';
  fallback?: 'skip' | 'archive';
  beforeTokens?: number;
  afterTokens?: number;
  droppedCount?: number;
  keptMessages?: number;
  contextTokens?: number;
  maxTokens?: number;
  threshold?: number;
}

export async function compactSession(id: string): Promise<CompactSessionResult> {
  return await api<CompactSessionResult>(`/sessions/${encodeURIComponent(id)}/compact`, {
    method: 'POST',
  });
}
