// SSE 流式消费（Task-20261017-001 D5）
// EventSource 无法携带 Authorization 头 → fetch + ReadableStream 手动分帧。
// 服务端帧格式（src/api/sse.ts sseFrame）：`[id: <seq>\n]event: <name>\ndata: <json>\n\n`
// POST /sessions/:id/messages 为 POST 流；GET /sessions/:id/stream 为 attach 续传流（204 = 无运行）。

import { AuthError, getToken, needAuth, clearToken } from './client.js';

export interface SseEvent {
  event: string;
  data: unknown;
  /** 服务端事件序号（方案-20261021-001：断线续传 cursor） */
  id?: number;
}

/** 解析单帧：id 行 + event 行 + data 行（多行 data 按 SSE 规则以 \n 拼接） */
function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  let id: number | undefined;
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) id = n;
    } else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  const text = dataLines.join('\n');
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON data 原样传递
  }
  return id === undefined ? { event, data } : { event, data, id };
}

/** 非 2xx → 401 抛 AuthError（清 token 弹门），其余抛带 code/status 的错误 */
async function raiseHttpError(res: Response): Promise<never> {
  if (res.status === 401) {
    clearToken();
    needAuth.value = true;
    throw new AuthError();
  }
  let code = 'http_error';
  let message = `请求失败（HTTP ${res.status}）`;
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    if (j.error?.code) code = j.error.code;
    if (j.error?.message) message = j.error.message;
  } catch {
    // 保留默认消息
  }
  const err = new Error(message) as Error & { code: string; status: number };
  err.code = code;
  err.status = res.status;
  throw err;
}

/** 逐帧消费响应体（读到流关闭为止） */
async function consume(res: Response, onEvent: (ev: SseEvent) => void): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) onEvent(ev);
    }
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * POST JSON + 逐帧消费 SSE 响应。
 * 正常结束（服务端 done 帧后关流）返回；401 抛 AuthError；其余非 2xx 抛带 code/status 的错误。
 */
export async function sseFetch(
  path: string,
  body: unknown,
  onEvent: (ev: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) await raiseHttpError(res);
  await consume(res, onEvent);
}

/**
 * GET + 逐帧消费 SSE 响应（attach 续传）。
 * 204 表示没有运行中的 run（无响应体）；其他非 2xx 抛错。
 */
export async function sseGet(
  path: string,
  onEvent: (ev: SseEvent) => void,
  signal?: AbortSignal,
): Promise<{ status: number }> {
  const res = await fetch(path, { headers: authHeaders(), signal });
  if (res.status === 204) return { status: 204 };
  if (!res.ok || !res.body) await raiseHttpError(res);
  await consume(res, onEvent);
  return { status: res.status };
}
