// WebUI 静态资源托管（Task-20261017-001 D3/D6）
//
// 仅用 node:http / node:fs，零新依赖。策略：
// - 只接 GET/HEAD 且「路径有扩展名，或为根路径」的请求；其余 return false 交回 API 层
//   （GET /nope 无扩展名仍走 API 404，保住既有端点测试语义）
// - 根路径回落 index.html（hash 路由 D4，无需 history fallback）
// - 静态页不鉴权（D6）：鉴权发生在 server.ts 的 matchRoute 之后，仅作用于已注册 API 端点
// - 防路径穿越：decodeURIComponent + resolve 后强制前缀校验，越界 403
// - index.html 不存在（未构建）→ 整体降级为永远 return false，API 纯后端模式不受影响

import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** MIME 映射（覆盖 Vite 构建产物与常见静态资源） */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/**
 * 解析 webRoot 配置：非空取配置值（相对路径按 cwd resolve）；空串自动探测仓库内置 webui/dist。
 * ESM 源码运行：本文件位于 <repoRoot>/src/api → 上两级即仓库根。
 * CJS/SEA 产物中 import.meta 被 esbuild 替换为空对象，new URL('.', undefined) 抛 TypeError：
 * 兜底回退 cwd（约定 exe 与 webui/dist 同目录部署），探测失败由 createStaticHandler 降级为纯 API。
 */
export function resolveWebRoot(raw: string): string {
  if (raw.trim()) return resolve(raw.trim());
  let here: string;
  try {
    here = fileURLToPath(new URL('.', import.meta.url));
  } catch {
    return join(process.cwd(), 'webui', 'dist');
  }
  return join(here, '..', '..', 'webui', 'dist');
}

/** 静态处理器：消费请求返回 true；返回 false 表示未命中（回落 API 层处理） */
export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** 创建静态资源处理器（root 为 webui/dist 绝对路径） */
export function createStaticHandler(root: string): StaticHandler {
  const absRoot = resolve(root);
  // index.html 缺失（未构建）→ 整体降级（永远回落 API）
  const available = existsSync(join(absRoot, 'index.html'));

  return async (req, res) => {
    if (!available) return false;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '') {
      if (pathname === '') return false; // 空路径异常请求交回 API
      return await serveFile(res, join(absRoot, 'index.html'), method, 'no-cache');
    }
    if (!extname(pathname)) return false; // 无扩展名 → API 404（保既有测试语义）

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return true;
    }
    const target = normalize(join(absRoot, decoded));
    if (!target.startsWith(absRoot + sep)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }
    // 带扩展名的目录类静态路径默认缓存一年（Vite 产物文件名带内容 hash）
    const immutable = decoded.startsWith('/assets/');
    return await serveFile(res, target, method, immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  };
}

/** 发送单个文件：不存在 / 目录 → false（回落 API 404）；成功 → true */
async function serveFile(res: ServerResponse, filePath: string, method: string, cacheControl: string): Promise<boolean> {
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;

  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Cache-Control': cacheControl,
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise<void>((resolvePipe, rejectPipe) => {
    const stream = createReadStream(filePath);
    stream.on('error', rejectPipe);
    stream.on('close', resolvePipe);
    stream.pipe(res);
  }).catch(() => {
    // 客户端中断等 IO 错误：尽力关流
    if (!res.writableEnded) res.end();
  });
  return true;
}
