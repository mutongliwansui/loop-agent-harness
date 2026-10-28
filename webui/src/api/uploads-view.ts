// /uploads/view 前端取数（20261028-006 D5）：独立小模块，避免 FilesView 直接 fetch
// 鉴权与错误处理对齐 client.ts（401 触发全局令牌门，非 2xx 抛 ApiError）。
// client.ts 的 throwFor 未导出，这里按同款语义内联（错误 JSON 结构 {error:{code,message}}）。
import { ApiError, AuthError, clearToken, getToken, needAuth } from './client.js';

async function throwForUploads(res: Response): Promise<never> {
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

/** fetchRaw 的 uploads 变体：GET /uploads/view?path=&disp=raw（Bearer 注入，blob 返回） */
export async function fetchRawUploads(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/uploads/view?path=${encodeURIComponent(path)}&disp=raw`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) await throwForUploads(res);
  return await res.blob();
}
