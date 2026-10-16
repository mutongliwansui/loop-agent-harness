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
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { SessionStore } from '../session/index.js';
import type { AgentConfig } from '../config/schema.js';
import type { AgentEvents, AgentOptions, AgentResult, AgentStep, ChatMessage } from '../types.js';

/** 请求体大小上限（2MB） */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 视为本机请求的远端地址（IPv4 / IPv6 / IPv4-mapped IPv6） */
const LOOPBACK_REMOTE = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 视为回环绑定的 host（用于启动校验） */
const LOOPBACK_HOST = new Set(['127.0.0.1', 'localhost', '::1']);

/** 统一错误码 → HTTP 状态映射 */
const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  bad_request: 400,
  busy: 409,
  payload_too_large: 413,
  internal: 500,
};

type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'bad_request'
  | 'busy'
  | 'payload_too_large'
  | 'internal';

/** 携带错误码的 HTTP 异常（处理器直接抛出，统一转 JSON 响应） */
class ApiHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 依赖注入面（D9：单测注入 fake runAgent + 临时目录 SessionStore） */
export interface ApiServerDeps {
  /** agent.run 的函数签名 */
  runAgent: (input: string, options: AgentOptions) => Promise<AgentResult>;
  /** API 专用会话存储（serve 模式不注入共享 agent） */
  sessionStore: SessionStore;
  /** 每次请求时读取生效配置（鉴权 token / 健康探针的 model 名） */
  getConfig: () => AgentConfig;
  /** 服务版本号（/health 返回） */
  version?: string;
  /** 日志输出（默认静默；startApiServer 注入 console.log） */
  log?: (msg: string) => void;
}

export interface ApiServer {
  /** 启动监听；返回实际端口（支持 port:0 随机） */
  start(): Promise<{ port: number }>;
  /** 关停服务（等待存量连接关闭） */
  close(): Promise<void>;
}

/** 内存中的会话条目：不含 system 的历史缓存 + 会话级互斥锁 */
interface SessionEntry {
  history: ChatMessage[];
  inFlight: Promise<void> | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res: ServerResponse, code: ErrorCode, message: string): void {
  sendJson(res, ERROR_STATUS[code], { error: { code, message } });
}

/** Error 原生不可 JSON 序列化（stringify 为 {}），转为 {name, message} */
function serializeError(e: Error): { name: string; message: string } {
  return { name: e.name, message: e.message };
}

/** 读取请求体；累计超 2MB 抛 413（排空剩余数据，保证客户端能收到 413 响应而非连接重置） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overLimit = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (overLimit) return; // 超限后仅排空，不再累积
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overLimit = true;
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume(); // 进入 flowing 模式排空剩余 body
        reject(new ApiHttpError('payload_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (!overLimit) reject(new ApiHttpError('bad_request', `读取请求体失败: ${e.message}`));
    });
  });
}

/** 解析 JSON 请求体（空体视为 {}） */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
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
function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (token) {
    return req.headers.authorization === `Bearer ${token}`;
  }
  return LOOPBACK_REMOTE.has(req.socket.remoteAddress ?? '');
}

/** SSE 帧写入：`event: <type>\n` + `data: <JSON>\n\n` */
function sseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * D4：AgentEvents 15 钩子 → SSE 事件透传器
 *
 * 命名规则：去 on 前缀 + camelCase 转 snake_case。
 * 序列化特例：Error → {name, message}。
 * `error` 是 Agent 内部非致命上报（可多次出现），终态由 API 层合成的 done / fatal 承担。
 */
function createSseForwarder(write: (event: string, data: unknown) => void): AgentEvents {
  return {
    onStart: (input) => write('start', { input }),
    onIterationStart: (iteration, maxIterations) => write('iteration_start', { iteration, maxIterations }),
    onLLMStream: (delta) => write('llm_stream', { text: delta }),
    onLLMEnd: (response, iteration) => write('llm_end', { response, iteration }),
    onLLMStats: (stats) => write('llm_stats', { stats }),
    onLLMStatsSummary: (summary) => write('llm_stats_summary', { summary }),
    onToolStart: (tool, args) => write('tool_start', { tool, args }),
    onToolEnd: (tool, result) => write('tool_end', { tool, result }),
    onToolProgress: (tool, elapsedMs) => write('tool_progress', { tool, elapsedMs }),
    onToolCallDelta: (tool, accumulatedBytes, elapsedMs) =>
      write('tool_call_delta', { tool, accumulatedBytes, elapsedMs }),
    onCompaction: (info) => write('compaction', { info }),
    onFinal: (answer) => write('final', { answer }),
    onError: (error) => write('error', serializeError(error)),
    onWarning: (info) => write('warning', info),
    onEnd: (result) => write('end', { result }),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建 API 服务（D9 依赖注入 seam）
 *
 * 路由：先鉴权，再按 method+path 匹配（:id 用正则提取）。
 * 会话管理器：Map 缓存历史（不含 system）；miss 时从 SessionStore 恢复（重启续聊）。
 */
export function createApiServer(deps: ApiServerDeps): ApiServer {
  const sessions = new Map<string, SessionEntry>();
  let httpServer: http.Server | null = null;

  const log = (msg: string): void => deps.log?.(msg);

  /** 取会话条目；缓存 miss 时从 SessionStore 恢复历史（不存在 → 404） */
  async function ensureEntry(id: string): Promise<SessionEntry> {
    const cached = sessions.get(id);
    if (cached) return cached;
    let history: ChatMessage[];
    try {
      const data = await deps.sessionStore.loadSession(id);
      // 恢复视图：lastSummary 注入 + recentMessages，不含 system
      history = SessionStore.getRestoreMessages(data).filter((m) => m.role !== 'system');
    } catch {
      throw new ApiHttpError('not_found', `会话不存在: ${id}`);
    }
    const entry: SessionEntry = { history, inFlight: null };
    sessions.set(id, entry);
    return entry;
  }

  /**
   * createSession 串行化：store 内部生成秒级时间戳 id（sess_YYYYMMDD_HHMMSS），
   * 同秒两次创建会互相覆盖文件，故排队执行并保证调用间隔 ≥ 1 秒（最多等待 3 次）。
   */
  let createChain: Promise<unknown> = Promise.resolve();
  let lastCreateAt = 0;
  function createSessionSafe(firstMessage: string, messages: ChatMessage[], steps: AgentStep[]): Promise<SessionMetaLike> {
    const task = createChain.then(async () => {
      let waited = 0;
      while (Date.now() - lastCreateAt < 1050) {
        if (waited >= 3) {
          throw new ApiHttpError('internal', '会话创建冲突（同秒 id 粒度限制），请稍后重试');
        }
        await delay(1050 - (Date.now() - lastCreateAt));
        waited++;
      }
      const meta = await deps.sessionStore.createSession(firstMessage, messages, steps);
      lastCreateAt = Date.now();
      return meta;
    });
    createChain = task.catch(() => {}); // 失败不阻塞后续创建
    return task;
  }

  /** POST /sessions：创建空会话 */
  async function handleCreateSession(res: ServerResponse): Promise<void> {
    const meta = await createSessionSafe('', [], []);
    sessions.set(meta.id, { history: [], inFlight: null });
    log(`[api] 会话已创建: ${meta.id}`);
    sendJson(res, 201, {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
    });
  }

  /** GET /sessions：会话列表 */
  async function handleListSessions(res: ServerResponse): Promise<void> {
    const list = await deps.sessionStore.listSessions();
    sendJson(res, 200, { sessions: list });
  }

  /** GET /sessions/:id：会话详情（恢复视图，不含 system） */
  async function handleGetSession(res: ServerResponse, id: string): Promise<void> {
    const metas = await deps.sessionStore.listSessions();
    const meta = metas.find((s) => s.id === id);
    if (!meta) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
    const data = await deps.sessionStore.loadSession(id);
    sendJson(res, 200, { meta, messages: SessionStore.getRestoreMessages(data) });
  }

  /** DELETE /sessions/:id：删除会话并清缓存；存在 in-flight run 时拒绝 */
  async function handleDeleteSession(res: ServerResponse, id: string): Promise<void> {
    const entry = sessions.get(id);
    if (entry?.inFlight) {
      throw new ApiHttpError('busy', `会话 ${id} 正在处理消息，暂不能删除`);
    }
    const metas = await deps.sessionStore.listSessions();
    if (!metas.some((s) => s.id === id)) {
      throw new ApiHttpError('not_found', `会话不存在: ${id}`);
    }
    await deps.sessionStore.deleteSession(id);
    sessions.delete(id);
    log(`[api] 会话已删除: ${id}`);
    sendJson(res, 200, { deleted: true });
  }

  /** POST /sessions/:id/messages：发消息（默认 SSE 流式，stream:false 切非流式 JSON） */
  async function handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const message = body.message;
    if (typeof message !== 'string' || !message.trim()) {
      throw new ApiHttpError('bad_request', 'message 必须为非空字符串');
    }
    const stream = body.stream !== false; // 默认 true

    const entry = await ensureEntry(id);
    if (entry.inFlight) {
      throw new ApiHttpError('busy', `会话 ${id} 正在处理上一条消息，请稍后再试`);
    }

    const startedAt = Date.now();
    const warnings: string[] = []; // 持久化失败降级收集（不失败请求）

    // D5：空历史 → resetHistory（忽略 agent 实例残留 _chatHistory）；非空 → 显式 messages
    const historyBefore = entry.history;
    const runOptions: AgentOptions = {
      verbose: false,
      ...(historyBefore.length === 0
        ? { resetHistory: true }
        : { messages: [...historyBefore] }),
    };

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let clientGone = false;
      res.on('close', () => {
        clientGone = true; // 停止写流，但 run 照常完成并持久化
      });
      const forwarder = createSseForwarder((event, data) => {
        if (!clientGone) sseFrame(res, event, data);
      });
      runOptions.events = [forwarder];
    }

    entry.inFlight = (async () => {
      try {
        const result = await deps.runAgent(message, runOptions);

        // 持久化（API 层自持 SessionStore；会话已在 ensureEntry/loadSession 阶段确认存在）
        try {
          await deps.sessionStore.updateSession(id, result.messages, result.steps);
        } catch (e) {
          warnings.push(`会话持久化失败（回答不受影响）: ${e instanceof Error ? e.message : String(e)}`);
        }
        entry.history = result.messages.filter((m) => m.role !== 'system');

        const donePayload = {
          sessionId: id,
          durationMs: Date.now() - startedAt,
          iterations: result.iterations,
          steps: result.steps.length,
        };
        if (stream) {
          for (const w of warnings) sseFrame(res, 'warning', { level: 'warning', message: w });
          sseFrame(res, 'done', donePayload); // D4 合成终态：正常结束
          res.end();
        } else {
          sendJson(res, 200, {
            sessionId: id,
            answer: result.answer,
            iterations: result.iterations,
            steps: result.steps,
            durationMs: donePayload.durationMs,
            ...(warnings.length ? { warnings } : {}),
          });
        }
        log(`[api] 会话 ${id} 完成: ${result.iterations} 轮 / ${result.steps.length} 步 / ${donePayload.durationMs}ms`);
      } catch (e) {
        // run 抛错：流式先推已发生事件再合成 fatal 关流；非流式 500（失败轮不持久化，保留原历史）
        const msg = e instanceof Error ? e.message : String(e);
        log(`[api] 会话 ${id} 运行失败: ${msg}`);
        if (stream) {
          sseFrame(res, 'fatal', { message: msg }); // D4 合成终态：异常
          res.end();
        } else {
          sendError(res, 'internal', msg);
        }
      } finally {
        entry.inFlight = null;
      }
    })();

    await entry.inFlight;
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
    },
  };

  /** 统一入口：鉴权 → 路由 → 处理器 → 错误转 JSON */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const token = deps.getConfig().api.token;
      if (!isAuthorized(req, token)) {
        throw token
          ? new ApiHttpError('unauthorized', '缺少或错误的 Bearer Token')
          : new ApiHttpError('forbidden', '仅允许本机访问（未配置 api.token）');
      }

      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/health') {
        if (method !== 'GET') throw new ApiHttpError('method_not_allowed', `${method} /health 不支持`);
        const cfg = deps.getConfig();
        sendJson(res, 200, { status: 'ok', version: deps.version ?? '', model: cfg.model.name });
        return;
      }

      if (path === '/sessions') {
        if (method === 'POST') return await handleCreateSession(res);
        if (method === 'GET') return await handleListSessions(res);
        throw new ApiHttpError('method_not_allowed', `${method} /sessions 不支持`);
      }

      const idMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
      if (idMatch) {
        if (method !== 'POST') {
          throw new ApiHttpError('method_not_allowed', `${method} ${path} 不支持`);
        }
        return await handleMessage(req, res, decodeURIComponent(idMatch[1]));
      }

      const detailMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        if (method === 'GET') return await handleGetSession(res, id);
        if (method === 'DELETE') return await handleDeleteSession(res, id);
        throw new ApiHttpError('method_not_allowed', `${method} ${path} 不支持`);
      }

      throw new ApiHttpError('not_found', `未知路径: ${method} ${path}`);
    } catch (e) {
      if (res.headersSent) {
        // SSE 已开流后才发生的同步异常（理论上 handleMessage 内部已兜底）：强制关流
        res.end();
        return;
      }
      if (e instanceof ApiHttpError) {
        sendError(res, e.code, e.message);
      } else {
        sendError(res, 'internal', e instanceof Error ? e.message : String(e));
      }
    }
  }
}

/** SessionMeta 的结构子集（避免引入 store 内部类型依赖） */
interface SessionMetaLike {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * src/index.ts --serve 分支的组装入口（真实依赖）：
 * 建独立 SessionStore（与 CLI 共用同一存储池，但不注入共享 agent）、起服务、打印服务信息。
 */
export async function startApiServer(): Promise<ApiServer> {
  const { agent } = await import('../agent/react-agent.js');
  const { configLoader } = await import('../config/index.js');
  const { SessionStore: Store } = await import('../session/index.js');

  const { config: cfg } = configLoader.load();
  const store = new Store(process.cwd(), 3, cfg.session.encryptionEnabled);
  await store.init();

  // 读取 package.json 版本（/health 返回）
  let version = '';
  try {
    const require = createRequire(import.meta.url);
    version = (require('../../package.json') as { version?: string }).version ?? '';
  } catch {
    // 版本读取失败不影响服务
  }

  const server = createApiServer({
    runAgent: (input, options) => agent.run(input, options),
    sessionStore: store,
    getConfig: () => configLoader.load().config,
    version,
    log: (msg) => console.log(msg),
  });

  const { port } = await server.start();
  const api = cfg.api;
  console.log('');
  console.log(`\x1b[1m\x1b[36mHTTP API 服务已启动\x1b[0m`);
  console.log(`  地址:    http://${api.host}:${port}`);
  console.log(`  鉴权:    ${api.token ? 'Bearer Token' : '仅本机（未配置 api.token）'}`);
  console.log(`  端点:    GET /health · POST /sessions · GET|DELETE /sessions/:id · POST /sessions/:id/messages`);
  console.log(`  提示:    Ctrl+C 退出；配置变更需重启生效`);
  console.log('');
  return server;
}
