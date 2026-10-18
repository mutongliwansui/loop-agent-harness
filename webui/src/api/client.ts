// REST API 封装（Task-20261017-001 D5/D6）
// - 自动注入 Bearer（token 存 localStorage）
// - 401 → 清 token + 置 needAuth（TokenGate 弹出）
// - 非 2xx → 解析 {error:{code,message}} 抛 ApiError

import { ref } from 'vue';

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
  if (!res.ok) await throwFor(res);
  return (await res.json()) as T;
}

/** 原始文件下载（GET /fs/raw：自动注入 Bearer；供 pdf iframe / Office 文档前端解析） */
export async function fetchRaw(path: string): Promise<Blob> {
  const res = await fetch(`/fs/raw?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
  if (!res.ok) await throwFor(res);
  return await res.blob();
}

/** 原始字节上传（POST /uploads/raw：body=文件字节，X-File-Name=encodeURIComponent 文件名） */
export async function uploadRaw(
  file: File,
  sessionId: string,
): Promise<{ fileName: string; bytes: number; contextNote: string }> {
  const res = await fetch(`/uploads/raw?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent(file.name), ...authHeaders() },
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
