// 声明式路由表 + 路径匹配：新增端点 = 新写 handler + 路由表加一行，无需改动 server.ts
//
// 匹配语义与原 if/else + 正则实现一致：
// - `:param` 段等价 `[^/]+`（非空），捕获后 decodeURIComponent
// - path 有匹配但 method 不符 → 405；完全无匹配 → 404

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http-utils.js';
import { handleCreateSession, handleDeleteSession, handleGetSession, handleListDirs, handleListSessions, handleListWorkspaces } from './handlers/sessions.js';
import { handleMessage } from './handlers/messages.js';
import { handleStop } from './handlers/stop.js';
import { handleAttachStream } from './handlers/stream.js';
import { uploadRoutes } from './handlers/uploads.js';
import { fsRoutes } from './handlers/fs.js';
import { configRoutes } from './handlers/config.js';
import { statusRoutes } from './handlers/status.js';
import { toolsRoutes } from './handlers/tools.js';
import { modelRoutes } from './handlers/models.js';
import { mcpRoutes } from './handlers/mcp.js';
import { skillRoutes } from './handlers/skills.js';
import { memoryRoutes } from './handlers/memory.js';
import { visionRoutes } from './handlers/vision.js';
import { doctorRoutes } from './handlers/doctor.js';
import type { ApiServerDeps } from './server.js';
import type { SessionManager } from './session-manager.js';
import type { RunHub } from './run-hub.js';
import type { ConfigLoader } from '../config/loader.js';
import type { ConfigWriter } from '../config/writer.js';
import type { MCPManager } from '../config/mcp-manager.js';
import type { SkillLoader } from '../skill/loader.js';
import type { MemoryKit } from './memory-kit.js';
import type { WorkspaceRegistry } from './workspace-runtime.js';

/** 处理器共享上下文（createApiServer 构造一次，路由分发时透传） */
export interface HandlerContext {
  deps: ApiServerDeps;
  /** 会话缓存与互斥状态（D5） */
  sessions: SessionManager;
  /** run 事件缓冲与订阅（断线续传）：运行中标记 / attach 端点数据源 */
  runs: RunHub;
  /** 日志输出（默认静默） */
  log: (msg: string) => void;
  /** 服务版本号（/health 返回） */
  version?: string;
  /** 切换工作空间后重建 agent 实例记忆（P1 起 switchWorkspace 不再调用；保留可选 seam 供外部嵌入） */
  reinitMemory?: (cwd: string) => Promise<void>;
  /** 分层配置加载器（/config 组读取 + 来源解析；Task-20261016-002 D8） */
  configLoader: ConfigLoader;
  /** 配置写入器（PUT/DELETE /config/:key） */
  configWriter: ConfigWriter;
  /** MCP 连接管理器（/status 快照） */
  mcpManager: MCPManager;
  /** 技能加载器（/status 快照） */
  skillLoader: SkillLoader;
  /** 上传根目录（uploads 组读写） */
  uploadsRoot: string;
  /** 记忆子系统工厂（/memory 组；API 无共享 agent，独立组装，D8） */
  createMemoryKit: () => Promise<MemoryKit>;
  /**
   * 工作空间运行时注册表（Task-20261021-010-01）。
   * Task-20261021-010-03 起消费：switchWorkspace 通过 registry 懒建目标空间 runtime，
   * 并把下方 sessions/configLoader/configWriter/skillLoader/createMemoryKit 与
   * deps.sessionStore/runAgent/getConfig 整体指向该 runtime 的不可变实例。
   */
  registry?: WorkspaceRegistry;
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
    // 会话资源（Task-20261016-001）
    { method: 'POST', path: '/sessions', handler: (ctx, req, res) => handleCreateSession(ctx, req, res) },
    { method: 'GET', path: '/sessions', handler: (ctx, _req, res) => handleListSessions(ctx, res) },
    // 服务端目录浏览（新建会话选择工作空间；静态段，无 :param 冲突）
    { method: 'GET', path: '/fs/dirs', handler: (ctx, req, res) => handleListDirs(ctx, req, res) },
    // 工作空间文件浏览器（原型-20261018-001）：树 / 文件预览 / 全文搜索（均静态段）
    ...fsRoutes(),
    // 跨工作空间聚合（会话按工作空间分组展示）
    { method: 'GET', path: '/workspaces', handler: (ctx, _req, res) => handleListWorkspaces(ctx, res) },
    { method: 'POST', path: '/sessions/:id/messages', handler: (ctx, req, res, p) => handleMessage(ctx, req, res, p.id) },
    // 附着当前 run 续传事件（3 段静态尾段，先于 2 段 /sessions/:id 注册以保持可读性）
    { method: 'GET', path: '/sessions/:id/stream', handler: (ctx, req, res, p) => handleAttachStream(ctx, req, res, p.id) },
    // 停止当前 run（Task-20261021-002-03）：404/204/202 三态，立即返回不等 run（D1/D2）
    { method: 'POST', path: '/sessions/:id/stop', handler: (ctx, req, res, p) => handleStop(ctx, req, res, p.id) },
    { method: 'GET', path: '/sessions/:id', handler: (ctx, _req, res, p) => handleGetSession(ctx, res, p.id) },
    { method: 'DELETE', path: '/sessions/:id', handler: (ctx, _req, res, p) => handleDeleteSession(ctx, res, p.id) },
    // 命令资源化（Task-20261016-002）：每组一工厂，D2 无参静态可组合
    ...uploadRoutes(),
    ...configRoutes(), // 注意：/config/path 静态段须注册在 /config/:key 之前（组内已保证）
    ...statusRoutes(),
    ...toolsRoutes(), // 注意：/tools/reload 静态段须注册在 /tools/:name 之前（组内已保证）
    ...modelRoutes(),
    ...mcpRoutes(),
    ...skillRoutes(),
    ...memoryRoutes(),
    ...visionRoutes(),
    ...doctorRoutes(),
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
