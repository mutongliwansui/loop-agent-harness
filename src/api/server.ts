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
import { attachTerminalWs } from '../terminal/ws.js';
import { TerminalManager } from '../terminal/manager.js';
import { canonicalWorkspacePath, isSameWorkspace } from '../session/path-utils.js';
import { currentWorkspaceRoot } from './recent-workspace.js';
import { resolveWorkspaceRuntime } from './handlers/sessions.js';
import type { ConfigLoader } from '../config/loader.js';
import type { ConfigWriter } from '../config/writer.js';
import type { MCPManager } from '../config/mcp-manager.js';
import type { SkillLoader } from '../skill/loader.js';
import type { WorkspaceRegistry, WorkspaceRuntime } from './workspace-runtime.js';
import type { DreamScheduler } from './dream-scheduler.js';
import { runBench, type BenchRunner } from '../llm/bench.js';
import { defaultBenchRoot } from '../llm/bench-store.js';
import { BenchRunHub } from './bench-hub.js';
import { onBackgroundNoticeWake } from '../agent/background-notice.js';
import { scheduleBackgroundWake } from './handlers/messages.js';

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
  /** 模型性能测试历史根目录（需求 20261027-003；单测注入临时目录） */
  benchRoot: string;
  /** 记忆/会话索引用户根覆盖（需求 20261026-004 跨空间端点；单测注入临时目录） */
  userDir?: string;
  /** 性能测试引擎（单测注入 fake 避免触网） */
  runBench: BenchRunner;
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
  /** 命令资源化运行时依赖（D8）；缺省字段回落全局单例 */
  runtime?: Partial<ApiRuntimeDeps>;
  /** 工作空间运行时注册表（Task-20261021-010-01）；透传给 handler 做按会话/空间路由 */
  registry?: WorkspaceRegistry;
  /**
   * 记忆晋升调度器（Task-20261026-002 D11）：透传给 handler，
   * 使 POST /memory/dream 与定时轮/关停兜底共用同一把进程内单飞锁。
   * 缺省时不注入 — handler 回落原有「即走即忘」行为（既有单测零改动）。
   */
  dreamScheduler?: DreamScheduler;
  /**
   * 关停请求入口（任务 20261112-007-02 / D2-1）：serve 模式由 bootstrap 注入，
   * 与信号关停共用同一把 shuttingDown 标志，保证幂等。
   * 未注入时（既有单测/嵌入用法）端点返回 501，不影响其他功能。
   */
  requestShutdown?: (reason: string) => boolean;
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
  /** 终端 WS 清理函数（start 时挂载，close 时卸载并杀 PTY） */
  let detachTerminal: (() => void) | null = null;
  /** 终端会话表（懒建：仅在启用终端时创建，避免默认关闭时也起回收定时器） */
  let terminalManager: TerminalManager | null = null;

  const log = (msg: string): void => deps.log?.(msg);
  // D8：runtime 缺省字段回落全局单例（bootstrap 传真实单例；单测注入临时目录实例）
  const rt = deps.runtime ?? {};
  // 空闲唤醒（需求 20261108-002）：后台命令任务在会话空闲期间完成时，
  // 以合成输入发起一轮 wake run 消费通知（镜像子 Agent 情况2 唤醒）。
  // start 时挂载、close 时注销；close 后到达的完成通知维持纯被动注入。
  let detachBackgroundWake: (() => void) | null = null;
  const ctx: HandlerContext = {
    deps,
    sessions,
    runs,
    log,
    version: deps.version,
    configLoader: rt.configLoader ?? configLoader,
    configWriter: rt.configWriter ?? configWriter,
    mcpManager: rt.mcpManager ?? mcpManager,
    skillLoader: rt.skillLoader ?? skillLoader,
    uploadsRoot: rt.uploadsRoot ?? defaultUploadsRoot(),
    // Task-20261021-010-03：缺省工厂也显式绑定当前（启动）空间根，不再回落 process.cwd()
    createMemoryKit: rt.createMemoryKit ?? (() => defaultMemoryKitFactory(deps.sessionStore.path)),
    // 工作空间运行时注册表（Task-20261021-010-01）：本任务仅透传，后续任务消费
    registry: deps.registry,
    // 记忆晋升调度器（Task-20261026-002）：POST /memory/dream 据此抢锁
    dreamScheduler: deps.dreamScheduler,
    // 模型性能测试（需求 20261027-003）：历史根目录与引擎均可注入，单测不触网不写用户目录
    benchRoot: rt.benchRoot ?? defaultBenchRoot(),
    // 记忆跨空间端点（需求 20261026-004）：记忆/会话索引用户根（默认 ~/.loop-agent）
    userDir: rt.userDir,
    runBench: rt.runBench ?? runBench,
    benchRuns: new BenchRunHub(),
    // 缺省空间 runtime（需求 20261113-001 D8）：语义已从「最近使用空间」改为**启动空间**。
    // 复用 resolveWorkspaceRuntime（懒装载 + ctx 指针改写）。
    // 无 registry（既有单测/嵌入用法）时回落 deps 对应的伪 runtime——此类场景不存在跨空间语义，
    // 保证 status / POST /sessions 等端点在旧单测下行为不变。
    resolveDefaultRuntime: async () => {
      if (!deps.registry) {
        return {
          root: deps.sessionStore.path,
          id: deps.sessionStore.id,
          store: deps.sessionStore,
          // 必须是 ctx.sessions（= deps.sessions ?? new SessionManager(store)），
          // 而非 deps.sessions——后者在既有单测/嵌入用法下为 undefined
          sessions: ctx.sessions,
        } as unknown as WorkspaceRuntime;
      }
      return resolveWorkspaceRuntime(ctx, deps.sessionStore.path);
    },
  };

  /**
   * 终端工作目录解析（Task-20261027-001）：与 /fs/* 同口径——
   * ?ws=<绝对路径> 必须是已注册工作空间，缺省回落**启动空间**。
   * 需求 20261113-001 D2：缺省不再取「最近使用空间」——终端 cwd 决定命令实际落点，
   * 随用户上次活动漂移属误伤面。
   */
  async function resolveTerminalCwd(wsParam: string | null): Promise<string> {
    const raw = wsParam?.trim();
    if (!raw) return deps.sessionStore.path;
    const target = await canonicalWorkspacePath(raw);
    const known = await deps.sessionStore.listAllWorkspaces();
    for (const w of known) {
      if (isSameWorkspace(await canonicalWorkspacePath(w.path), target)) return target;
    }
    throw new Error(`未知工作空间: ${raw}`);
  }

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

      // ---- 空闲唤醒（需求 20261108-002）：API 服务存活期间注册唤醒回调 ----
      detachBackgroundWake = onBackgroundNoticeWake((sessionId) => {
        if (!sessionId) return;
        scheduleBackgroundWake(ctx, sessionId);
      });

      // ---- 终端（Task-20261027-001）：仅在 webui.terminal 开启时挂载 ----
      // 默认开启（2026-11-09 调整）：终端 = 当前用户权限下的任意命令执行，可用 webui.terminal=false 关闭。
      // 会话表懒建，避免关闭时白起一个 30s 回收定时器。
      if (cfg.webui?.terminal) {
        const tcfg = cfg.webui;
        terminalManager = new TerminalManager({
          maxSessions: tcfg.terminalMax > 0 ? tcfg.terminalMax : 4,
          idleMs: tcfg.terminalIdleMs > 0 ? tcfg.terminalIdleMs : 30 * 60 * 1000,
          deny: tcfg.terminalDeny ?? [],
          audit: (e) => log(`[terminal][audit] ${e.denied ? '拒绝' : '执行'} ${e.command}`),
          log,
        });
        detachTerminal = attachTerminalWs(server, {
          getConfig: deps.getConfig,
          manager: terminalManager,
          resolveCwd: resolveTerminalCwd,
          log,
        });
        log(`[terminal] 已启用（并发上限 ${tcfg.terminalMax}，空闲回收 ${Math.round(tcfg.terminalIdleMs / 60000)} 分钟）`);
      }

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
      // 空闲唤醒回调：先注销再关流（close 后到达的完成通知不再触发唤醒）
      if (detachBackgroundWake) {
        detachBackgroundWake();
        detachBackgroundWake = null;
      }
      // 终端：先断开 WS 并杀全部 PTY（Windows 下额外清 conhost 进程树）
      if (detachTerminal) {
        detachTerminal();
        detachTerminal = null;
      }
      if (terminalManager) {
        terminalManager.disposeAll();
        terminalManager = null;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runs.dispose(); // 清理结束态保留定时器
      ctx.benchRuns.dispose(); // 中断在跑的模型测速并清保留定时器（需求 20261027-003）
      ctx.dreamScheduler?.dispose(); // 清记忆晋升定时器（Task-20261026-002 D12）
    },
  };
}

export { startApiServer } from './bootstrap.js';
