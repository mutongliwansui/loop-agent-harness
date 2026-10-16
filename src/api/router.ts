// 声明式路由表 + 路径匹配：新增端点 = 新写 handler + 路由表加一行，无需改动 server.ts
//
// 匹配语义与原 if/else + 正则实现一致：
// - `:param` 段等价 `[^/]+`（非空），捕获后 decodeURIComponent
// - path 有匹配但 method 不符 → 405；完全无匹配 → 404

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http-utils.js';
import { handleCreateSession, handleDeleteSession, handleGetSession, handleListSessions } from './handlers/sessions.js';
import { handleMessage } from './handlers/messages.js';
import type { ApiServerDeps } from './server.js';
import type { SessionManager } from './session-manager.js';

/** 处理器共享上下文（createApiServer 构造一次，路由分发时透传） */
export interface HandlerContext {
  deps: ApiServerDeps;
  /** 会话缓存与互斥状态（D5） */
  sessions: SessionManager;
  /** 日志输出（默认静默） */
  log: (msg: string) => void;
  /** 服务版本号（/health 返回） */
  version?: string;
}

export type RouteHandler = (
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

export interface Route {
  method: string;
  /** 形如 '/sessions/:id/messages'；`:x` 为单段路径参数 */
  path: string;
  handler: RouteHandler;
}

/** GET /health：健康探针 */
async function handleHealth(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = ctx.deps.getConfig();
  sendJson(res, 200, { status: 'ok', version: ctx.version ?? '', model: cfg.model.name });
}

export function createRoutes(): Route[] {
  return [
    { method: 'GET', path: '/health', handler: handleHealth },
    { method: 'POST', path: '/sessions', handler: (ctx, _req, res) => handleCreateSession(ctx, res) },
    { method: 'GET', path: '/sessions', handler: (ctx, _req, res) => handleListSessions(ctx, res) },
    { method: 'POST', path: '/sessions/:id/messages', handler: (ctx, req, res, p) => handleMessage(ctx, req, res, p.id) },
    { method: 'GET', path: '/sessions/:id', handler: (ctx, _req, res, p) => handleGetSession(ctx, res, p.id) },
    { method: 'DELETE', path: '/sessions/:id', handler: (ctx, _req, res, p) => handleDeleteSession(ctx, res, p.id) },
  ];
}

export type MatchResult =
  | { kind: 'match'; route: Route; params: Record<string, string> }
  | { kind: 'method_not_allowed' }
  | { kind: 'not_found' };

/** 按 method+path 匹配路由表；path 命中但 method 均不符 → method_not_allowed */
export function matchRoute(routes: Route[], method: string, path: string): MatchResult {
  const segs = path.split('/').slice(1);
  let pathMatched = false;
  for (const route of routes) {
    const rsegs = route.path.split('/').slice(1);
    if (rsegs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < rsegs.length; i++) {
      const r = rsegs[i];
      if (r.startsWith(':')) {
        if (!segs[i]) {
          ok = false; // `:param` 等价 [^/]+，拒绝空段
          break;
        }
        params[r.slice(1)] = decodeURIComponent(segs[i]);
      } else if (r !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { kind: 'match', route, params };
  }
  return { kind: pathMatched ? 'method_not_allowed' : 'not_found' };
}
