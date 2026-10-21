// 自定义 REST API 服务（Task-20261016-001）
//
// 设计决策（详见 docs/tasks/task-20261016-001-自定义REST API服务.md）：
// - D1  仅用 node:http 内置模块，零新依赖
// - D2  资源式 REST：会话为一等资源（/sessions、/sessions/:id、/sessions/:id/messages、/health）
// - D3  发消息默认 SSE 流式，`stream: false` 切非流式 JSON
// - D4  AgentEvents 15 钩子全量透传（onXxx → snake_case 事件名）+ API 层合成终态 done / fatal
// - D5  共享 agent 单例 + 显式 messages 隔离多会话 + API 层自持 SessionStore 持久化 + 会话级互斥
// - D6  token 为空仅本机；非空强制 Bearer；绑非回环地址且无 token 拒绝启动
// - D9  createApiServer(deps) 依赖注入，可起真实 http server（port 0）做单测
//
// 模块分层：本文件只做组装（依赖注入 + 路由分发 + 启停）。
// 错误 → errors.ts；HTTP 工具 → http-utils.ts；SSE 透传 → sse.ts；
// 会话状态 → session-manager.ts；处理器 → handlers/；路由表 → router.ts；组装入口 → bootstrap.ts。
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiHttpError } from './errors.js';
import { LOOPBACK_HOST, isAuthorized, sendError } from './http-utils.js';
import { SessionManager } from './session-manager.js';
import { RunHub } from './run-hub.js';
import { createRoutes, matchRoute, type HandlerContext } from './router.js';
import { resolveStaticHandler, type StaticHandler } from './static.js';
import { SessionStore, SessionNotFoundError } from '../session/index.js';
import type { AgentConfig } from '../config/schema.js';
import type { AgentOptions, AgentResult } from '../types.js';
import { configLoader } from '../config/loader.js';
import { configWriter } from '../config/writer.js';
import { mcpManager } from '../config/mcp-manager.js';
import { skillLoader } from '../skill/loader.js';
import { defaultUploadsRoot } from '../upload/manager.js';
import { defaultMemoryKitFactory, type MemoryKit } from './memory-kit.js';
import type { ConfigLoader } from '../config/loader.js';
import type { ConfigWriter } from '../config/writer.js';
import type { MCPManager } from '../config/mcp-manager.js';
import type { SkillLoader } from '../skill/loader.js';
import type { WorkspaceRegistry } from './workspace-runtime.js';

/**
 * 命令资源化运行时依赖（Task-20261016-002 D8）：
 * bootstrap 组装真实单例；单测注入临时目录实例（fake seam）。
 */
export interface ApiRuntimeDeps {
  configLoader: ConfigLoader;
  configWriter: ConfigWriter;
  mcpManager: MCPManager;
  skillLoader: SkillLoader;
  uploadsRoot: string;
  /** 记忆子系统工厂（/memory 组；单测注入临时目录版避免污染 ~/.loop-agent） */
  createMemoryKit: () => Promise<MemoryKit>;
}

/** 依赖注入面（D9：单测注入 fake runAgent + 临时目录 SessionStore） */
export interface ApiServerDeps {
  /**
   * agent.run 的函数签名（Task-20261021-002-05）：
   * sessionId 首参供 AgentPool 按会话租用独立 agent 实例（同工作空间多会话并发）
   */
  runAgent: (sessionId: string, input: string, options: AgentOptions) => Promise<AgentResult>;
  sessionStore: SessionStore;
  /**
   * 会话缓存与互斥层（Task-20261021-010-01）：由工作空间 runtime 持有并注入，
   * 避免 server 自建一份导致缓存分叉。缺省时 server 自行新建（既有单测零改动）。
   */
  sessions?: SessionManager;
  /** 每次请求时读取生效配置（鉴权 token / 健康探针的 model 名） */
  getConfig: () => AgentConfig;
  /** 服务版本号（/health 返回） */
  version?: string;
  /** 日志输出（默认静默；startApiServer 注入 console.log） */
  log?: (msg: string) => void;
  /** 切换工作空间后重建记忆与实例池（Task-20261021-002-05 D6：缺省时仅重置 memory-kit 缓存） */
  reinitMemory?: (cwd: string) => Promise<void>;
  /** 命令资源化运行时依赖（D8）；缺省字段回落全局单例 */
  runtime?: Partial<ApiRuntimeDeps>;
  /** 工作空间运行时注册表（Task-20261021-010-01）；本阶段仅透传给 handler，后续任务消费 */
  registry?: WorkspaceRegistry;
}

export interface ApiServer {
  /** 启动监听；返回实际端口（支持 port:0 随机） */
  start(): Promise<{ port: number }>;
  /** 关停服务（等待存量连接关闭） */
  close(): Promise<void>;
}

/**
 * 创建 API 服务（D9 依赖注入 seam）
 *
 * 请求流：matchRoute → 鉴权 → handler（未注册 GET 先静态回落；抛 ApiHttpError 统一转 JSON 响应）。
 */
export function createApiServer(deps: ApiServerDeps): ApiServer {
  // Task-20261021-010-01：会话缓存由工作空间 runtime 注入（多空间并存时每空间一份），
  // 缺省自建以保持既有单测/嵌入用法零改动。
  const sessions = deps.sessions ?? new SessionManager(deps.sessionStore);
  const runs = new RunHub();
  const routes = createRoutes();
  let httpServer: http.Server | null = null;
  /** WebUI 静态资源处理器（start 时按 webRoot 构建；index.html 缺失时整体降级为回落 API） */
  let staticHandler: StaticHandler | null = null;

  const log = (msg: string): void => deps.log?.(msg);
  // D8：runtime 缺省字段回落全局单例（bootstrap 传真实单例；单测注入临时目录实例）
  const rt = deps.runtime ?? {};
  const ctx: HandlerContext = {
    deps,
    sessions,
    runs,
    log,
    version: deps.version,
    reinitMemory: deps.reinitMemory,
    configLoader: rt.configLoader ?? configLoader,
    configWriter: rt.configWriter ?? configWriter,
    mcpManager: rt.mcpManager ?? mcpManager,
    skillLoader: rt.skillLoader ?? skillLoader,
    uploadsRoot: rt.uploadsRoot ?? defaultUploadsRoot(),
    // Task-20261021-010-03：缺省工厂也显式绑定当前（启动）空间根，不再回落 process.cwd()
    createMemoryKit: rt.createMemoryKit ?? (() => defaultMemoryKitFactory(deps.sessionStore.path)),
    // 工作空间运行时注册表（Task-20261021-010-01）：本任务仅透传，后续任务消费
    registry: deps.registry,
  };

  /** 统一入口：路由 → 鉴权 → 处理器 → 错误转 JSON（D6：静态页免鉴权，已注册端点鉴权语义不变） */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const matched = matchRoute(routes, method, path);
      if (matched.kind === 'not_found') {
        // 未注册路径：先尝试静态回落（仅 GET 有扩展名 / 根路径；index.html 缺失时恒 false）
        if (staticHandler && (await staticHandler(req, res))) return;
        // 回落未命中 → 保持原鉴权与 404 语义
        const token = deps.getConfig().api.token;
        if (!isAuthorized(req, token)) {
          throw token
            ? new ApiHttpError('unauthorized', '缺少或错误的 Bearer Token')
            : new ApiHttpError('forbidden', '仅允许本机访问（未配置 api.token）');
        }
        throw new ApiHttpError('not_found', `未知路径: ${method} ${path}`);
      }
      // 已注册端点（含 method_not_allowed）鉴权行为与原实现一致
      const token = deps.getConfig().api.token;
      if (!isAuthorized(req, token)) {
        throw token
          ? new ApiHttpError('unauthorized', '缺少或错误的 Bearer Token')
          : new ApiHttpError('forbidden', '仅允许本机访问（未配置 api.token）');
      }
      if (matched.kind === 'method_not_allowed') {
        throw new ApiHttpError('method_not_allowed', `${method} ${path} 不支持`);
      }
      return await matched.route.handler(ctx, req, res, matched.params);
    } catch (e) {
      if (res.headersSent) {
        // SSE 已开流后才发生的同步异常（理论上 handleMessage 内部已兜底）：强制关流
        res.end();
        return;
      }
      if (e instanceof ApiHttpError) {
        sendError(res, e.code, e.message);
      } else if (e instanceof SessionNotFoundError) {
        // 索引有条目但落盘文件缺失（存储被清理等）：按 404 优雅响应，而非 500 ENOENT
        sendError(res, 'not_found', e.message);
      } else {
        sendError(res, 'internal', e instanceof Error ? e.message : String(e));
      }
    }
  }

  return {
    async start() {
      const cfg = deps.getConfig();
      const { host, port, token } = cfg.api;

      // D6 启动校验：非回环绑定且无 token → 拒绝启动（防裸奔暴露局域网）
      if (!token && !LOOPBACK_HOST.has(host)) {
        throw new Error(
          `api.host 绑定为非回环地址「${host}」且未配置 api.token，拒绝启动（存在暴露风险）。` +
            `请设置 api.token，或将 api.host 改为 127.0.0.1。`,
        );
      }

      // D3：webRoot 显式配置走磁盘；空串自动探测磁盘 webui/dist → SEA 内嵌资源 → 降级纯 API
      staticHandler = resolveStaticHandler(cfg.api.webRoot);

      const server = http.createServer((req, res) => {
        void handleRequest(req, res).catch(() => {});
      });
      server.requestTimeout = 0; // 长流式响应不被 Node 默认 300s 掐断

      httpServer = server;
      const actualPort = await new Promise<number>((resolve, reject) => {
        let settled = false;
        server.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          } else {
            log(`[api] 服务器错误: ${err.message}`);
          }
        });
        server.listen(port, host, () => {
          settled = true;
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
      return { port: actualPort };
    },

    async close() {
      if (!httpServer) return;
      const server = httpServer;
      httpServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runs.dispose(); // 清理结束态保留定时器
    },
  };
}

export { startApiServer } from './bootstrap.js';
