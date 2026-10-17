// SSE 流式消费（Task-20261017-001 D5）
// EventSource 无法携带 Authorization 头 → fetch POST + ReadableStream 手动分帧。
// 服务端帧格式（src/api/sse.ts sseFrame）：`event: <name>\ndata: <json>\n\n`

import { AuthError, getToken, needAuth, clearToken } from './client.js';

export interface SseEvent {
  event: string;
  data: unknown;
}

/** 解析单帧：event 行 + data 行（多行 data 按 SSE 规则以 \n 拼接） */
function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('event:')) event = line.slice(6).trim();
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
  return { event, data };
}

/**
 * POST JSON + 逐帧消费 SSE 响应。
 * 正常结束（服务端 done 帧后关流）返回；401 抛 AuthError；其余非 2xx 抛 ApiError。
 */
export async function sseFetch(
  path: string,
  body: unknown,
  onEvent: (ev: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
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

  const reader = res.body.getReader();
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
