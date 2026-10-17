// HTTP 层通用工具：JSON 读写、请求体读取、鉴权（与业务路由无关）

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiHttpError, ERROR_STATUS, type ErrorCode } from './errors.js';

/** 请求体大小上限（2MB） */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 视为本机请求的远端地址（IPv4 / IPv6 / IPv4-mapped IPv6） */
const LOOPBACK_REMOTE = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 视为回环绑定的 host（用于启动校验） */
export const LOOPBACK_HOST = new Set(['127.0.0.1', 'localhost', '::1']);

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function sendError(res: ServerResponse, code: ErrorCode, message: string): void {
  sendJson(res, ERROR_STATUS[code], { error: { code, message } });
}

/** Error 原生不可 JSON 序列化（stringify 为 {}），转为 {name, message} */
export function serializeError(e: Error): { name: string; message: string } {
  return { name: e.name, message: e.message };
}

/**
 * 读取原始请求体为 Buffer；累计超 maxBytes 抛 413（排空剩余数据，保证客户端能收到 413 响应而非连接重置）。
 * 上限参数化：JSON 体默认 2MB；raw 上传传 MAX_UPLOAD_BYTES（100MB）。
 */
export function readRawBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overLimit = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (overLimit) return; // 超限后仅排空，不再累积
      size += chunk.length;
      if (size > maxBytes) {
        overLimit = true;
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume(); // 进入 flowing 模式排空剩余 body
        reject(new ApiHttpError('payload_too_large', `请求体超过 ${maxBytes} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!overLimit) reject(new ApiHttpError('bad_request', `读取请求体失败: ${e.message}`));
    });
  });
}

/** 读取请求体为 UTF-8 字符串（默认上限 2MB，可传更大的 maxBytes） */
export async function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return (await readRawBody(req, maxBytes)).toString('utf8');
}

/** 解析 JSON 请求体（空体视为 {}；maxBytes 供大体积上传端点放宽） */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBytes);
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body 必须为 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new ApiHttpError('bad_request', `请求体不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** D6 鉴权：token 非空校验 Bearer；为空仅放行本机请求 */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (token) {
    return req.headers.authorization === `Bearer ${token}`;
  }
  return LOOPBACK_REMOTE.has(req.socket.remoteAddress ?? '');
}
