// /sessions 与 /sessions/:id 的 CRUD 处理器
//
// POST /sessions 须带 { workspacePath }（title 可选，缺 workspacePath → 400）：
// - 校验目录 → 直接在目标空间的 runtime 创建（task-04 起不再全局 busy 互斥；
//   不改变任何全局状态，不影响其他空间运行中的 run）
// - GET /fs/dirs：服务端目录浏览（新建会话选择工作空间；纯 Web 拿不到本地绝对路径）
// - GET /sessions/:id / DELETE /sessions/:id：按 sessionId 定位归属 runtime（D17），
//   跨空间会话只读/删除均不改变任何空间状态
//
// 解耦（Task-20261021-010-03/04）：每个空间由 registry 懒建不可变 runtime
// （store/configLoader/configWriter/skillLoader/sessions/pool 均为该 runtime 的实例）；
// 缺省操作一律落启动空间，空间之间完全并列、无"当前空间"概念。
//
// 路径归一（Task-20261021-010-01 L2）：'D:' 盘符特例与绝对化统一由 session/path-utils 提供，
// 本文件不再保留私有实现——展示型回显用 lexicalWorkspacePath（取值与改造前一致），
// 空间身份比较用 canonicalWorkspacePath + isSameWorkspace。

import { type Dirent } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { type WorkspaceRuntime } from '../workspace-runtime.js';
import { currentWorkspaceRoot, markWorkspaceUsed } from '../recent-workspace.js';
import { locateSession } from '../session-locator.js';
import { canonicalWorkspacePath, isSameWorkspace, lexicalWorkspacePath } from '../../session/path-utils.js';
import { SessionStore } from '../../session/index.js';
import type { SessionManager } from '../session-manager.js';
import { readJournal, dropJournal } from '../run-journal.js';
import { estimateMessageTokens } from '../../memory/working.js';
import { isDisplayOnlyContent, type ChatMessage } from '../../types.js';
import { ReActAgent, type CompactNowResult } from '../../agent/react-agent.js';
import { subAgentRegistry } from '../../agent/subagent-registry.js';
import { listJobs, type JobKind, type JobStatus } from '../../background/jobs.js';
import { runMessageTurn } from './messages.js';

/** 枚举本机盘符（Windows；返回 'C:\' 形式，非 Windows 返回空） */
async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const found: string[] = [];
  for (let i = 65; i <= 90; i++) {
    const drive = `${String.fromCharCode(i)}:\\`;
    try {
      await access(drive);
      found.push(drive);
    } catch {
      // 盘符不存在：跳过
    }
  }
  return found;
}

/**
 * GET /fs/dirs?path=：列出目录下的子目录，供「新建会话选择工作空间」使用。
 *
 * 需求 20261113-001 D3：缺省 path 的起点是 **MRU（最近使用空间）‖ 用户主目录**。
 * - 有推荐（MRU 指针非空）→ 按推荐预填，减少用户点击；
 * - 无推荐（全新安装/无任何会话）→ 落 os.homedir()，用户从这里向上可到盘根、向右可跳盘。
 *
 * 注意与 `/fs/*` 的区别：那些端点语义是「已在某空间内读写」，缺 ws 一律 400（D2）；
 * 本端点语义是「选空间的浏览器」，缺省必须给一个可浏览的真实目录，不能报错。
 * homedir() 是真实绝对目录，故 path/parent/dirs/drives 四字段语义完全不变，前端零改动。
 */
export async function handleListDirs(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const explicitPath = query.get('path')?.trim();
  const target = lexicalWorkspacePath(explicitPath || currentWorkspaceRoot() || homedir());
  let isDir: boolean;
  try {
    isDir = (await stat(target)).isDirectory();
  } catch {
    throw new ApiHttpError('not_found', `目录不存在: ${target}`);
  }
  if (!isDir) throw new ApiHttpError('not_found', `不是目录: ${target}`);
  let entries: Dirent[];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    throw new ApiHttpError('forbidden', `无权读取目录: ${target}`);
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const isRoot = /^[A-Za-z]:\\$/.test(target);
  sendJson(res, 200, {
    path: target,
    parent: isRoot ? null : dirname(target),
    dirs,
    drives: await listDrives(),
  });
}

/**
 * 解析目标工作空间的运行时（task-04 起不再改变任何"当前空间"指针）：
 * registry 为目标空间懒建不可变 runtime，不 chdir、不原地重绑、不重置记忆/池、
 * 不干预其他空间运行中的 run；per-space 互斥由归属 runtime 的 sessions 保证。
 */
export async function resolveWorkspaceRuntime(ctx: HandlerContext, target: string): Promise<WorkspaceRuntime> {
  const registry = ctx.registry;
  if (!registry) {
    throw new ApiHttpError('internal', '工作空间注册表未初始化，无法解析工作空间运行时');
  }
  const root = await registry.ensureRoot(target);
  const rt = await registry.getCanonical(root);
  // 需求 20261027-004：显式空间解析成功即刷新「最近使用空间」指针（缺省空间语义的事实源）
  markWorkspaceUsed(root);

  // 指针刷新：以下字段均来自 runtime（实例本身不可变，仅替换 handler 的引用）
  // 需求 20261112-008 D8：config/skill 一律进程级单例，不再随空间改写——
  // 否则「本该读全局的 handler」会读到某空间的实例。
  ctx.deps.sessionStore = rt.store;
  ctx.deps.runAgent = (sessionId, input, options) => rt.runAgent(sessionId, input, options);
  ctx.sessions = rt.sessions;
  ctx.createMemoryKit = () => rt.getMemoryKit();

  return rt;
}

/**
 * POST /sessions：创建空会话；body 必带 { workspacePath }（title 可选）
 *
 * task-04：带 workspacePath 时直接在目标空间创建（无 busy 判定、不改变任何全局状态）；
 * 响应 workspace.switched 字段保留但恒 false（L2，task-05 前端移除依赖）。
 *
 * 需求 20261113-001 D6：缺 `workspacePath` **一律 400**，不存在"缺省空间"。
 * 语义依据：WebUI/serve 形态下「发消息」必然发生在「已选定空间的会话」内
 * （新建会话的前提就是选空间），故没有"无会话时自动建"这条路径需要兜底；
 * 静默落某个空间只会让会话出现在用户没预期的地方。
 * 目录校验（not_found/forbidden）由 resolveWorkspaceRuntime 内的 ensureRoot 统一完成。
 */
export async function handleCreateSession(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const title = typeof body.title === 'string' ? body.title : '';
  const requested = typeof body.workspacePath === 'string' ? body.workspacePath.trim() : '';
  if (!requested) {
    throw new ApiHttpError('bad_request', '缺少 workspacePath：创建会话须显式指定工作空间');
  }

  // 空间身份按 canonical 形式比较（'D:' 特例 + 绝对化 + win32 真实大小写，D2/L2）
  const target = await canonicalWorkspacePath(requested);
  const rt = ctx.registry
    ? await resolveWorkspaceRuntime(ctx, target)
    : await resolveEmbeddedRuntime(ctx, target);

  const sessions = rt.sessions;
  const store = rt.store;
  const meta = await sessions.createSessionSafe(title, []);
  sessions.set(meta.id, { history: [], inFlight: null });
  ctx.log(`[api] 会话已创建: ${meta.id}（目标工作空间: ${store.path}）`);
  sendJson(res, 201, {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    workspace: { path: store.path, id: store.id, switched: false },
  });
}

/**
 * 无 registry 的嵌入形态（既有单测 / 嵌入式 API）：进程内只有 `deps.sessionStore` 一个空间。
 *
 * 请求仍须显式给 workspacePath——但必须与那唯一空间一致，否则 404。
 * 不采用「忽略 workspacePath 直接落 store」：那会让调用方以为会话建在 A，实际落在 B。
 */
async function resolveEmbeddedRuntime(ctx: HandlerContext, target: string): Promise<WorkspaceRuntime> {
  const own = await canonicalWorkspacePath(ctx.deps.sessionStore.path);
  if (!isSameWorkspace(target, own)) {
    throw new ApiHttpError('not_found', `未知工作空间: ${target}`);
  }
  return ctx.resolveDefaultRuntime();
}


/**
 * GET /sessions：列出**指定空间**的会话列表；`?ws=`（绝对路径）必填。
 *
 * 需求 20261113-001 D6/D8 延伸：缺 `ws` **一律 400**，不再回落到「进程启动空间」。
 * 语义依据与 POST /sessions 一致——会话永远属于某个空间，没有"哪个空间的都行"这种
 * 调用意图；静默回落只会让调用方以为拿到的是目标空间的列表。跨空间全貌走 GET /workspaces。
 */
export async function handleListSessions(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ws = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ws')?.trim();
  if (!ws) {
    throw new ApiHttpError('bad_request', '缺少 ws：列出会话须显式指定工作空间（跨空间全貌请用 GET /workspaces）');
  }
  // 无 registry 的嵌入形态（既有单测 / 嵌入式 API）：请求仍须显式给 ws，
  // 且必须与那唯一空间一致，否则 404（与 POST /sessions 的 resolveEmbeddedRuntime 同构）。
  const store = ctx.registry
    ? (await resolveWorkspaceRuntime(ctx, await ctx.registry.ensureRoot(ws))).store
    : (await resolveEmbeddedRuntime(ctx, await canonicalWorkspacePath(ws))).store;
  const list = await store.listSessions();
  sendJson(res, 200, { sessions: list });
}

/** run journal 概要（列表用，D7：只暴露 status/finishedAt 控制体量） */
async function readJournalSummary(
  store: SessionStore,
  id: string,
): Promise<{ status: string; finishedAt?: number } | null> {
  const jr = await readJournal(store, id);
  return jr ? { status: jr.status, finishedAt: jr.finishedAt } : null;
}

/** GET /workspaces：跨工作空间聚合（名称 + 会话列表；注入 running 与 lastRun 概要供侧栏标记） */
export async function handleListWorkspaces(ctx: HandlerContext, res: ServerResponse): Promise<void> {
  const workspaces = await ctx.deps.sessionStore.listAllWorkspaces();
  const enriched = await Promise.all(
    workspaces.map(async (w) => ({
      ...w,
      sessions: await Promise.all(
        w.sessions.map(async (s) => ({
          ...s,
          running: ctx.runs.isRunning(s.id),
          // run journal 概要（Task-20261021-002-06 D7）：仅 status/finishedAt 两个字段，控制列表体量
          lastRun: await readJournalSummary(ctx.deps.sessionStore, s.id),
        })),
      ),
    })),
  );
  sendJson(res, 200, { workspaces: enriched });
}

/** GET /sessions/:id：会话详情（完整历史，不含 system；task-04 起按 id 定位归属空间，不再自动切换） */
export async function handleGetSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  if (ctx.registry) {
    // 按 sessionId 定位归属 runtime（D17：新 id 段解析 / 老 id 映射缓存 + 全扫回退）；
    // 不改变任何空间状态，读取/续聊都在会话所属 runtime 内完成
    const rt = await locateSession(ctx.registry, id);
    const meta = (await rt.store.listSessions()).find((s) => s.id === id);
    const data = await rt.store.loadSession(id);
    // 展示层：返回全量历史 data.messages（单一真源，含 system 与压缩总结消息）。
    // system 与压缩总结消息带 is_show=false，前端据此过滤；用户消息的 content 为原始输入
    // （存量会话可能残留 L2 记忆前缀），前端用 show_content 兜底还原。
    const messages = SessionStore.getAllAvailableMessages(data);
    sendJson(res, 200, {
      meta,
      messages,
      run: ctx.runs.snapshot(id), // 运行中概览（前端决定是否 attach 续传）
      // run journal 磁盘态（Task-20261021-002-06）：与内存 run 并列；重启后 run=null 但 lastRun 仍在
      lastRun: await readJournal(rt.store, id),
      // switched 字段保留但恒 false（L2，task-05 前端移除依赖）
      workspace: { path: rt.store.path, id: rt.store.id, switched: false },
    });
    return;
  }

  // 无 registry 的嵌入形态：保持旧逻辑（跨空间只读查看，不切换空间）
  const owner = (await ctx.deps.sessionStore.listAllWorkspaces()).find((w) =>
    w.sessions.some((s) => s.id === id),
  );
  if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  const meta = owner.sessions.find((s) => s.id === id);
  const data = await ctx.deps.sessionStore.loadSession(id);
  const messages = SessionStore.getAllAvailableMessages(data);
  sendJson(res, 200, {
    meta,
    messages,
    run: ctx.runs.snapshot(id),
    lastRun: await readJournal(ctx.deps.sessionStore, id),
    workspace: { path: ctx.deps.sessionStore.path, id: ctx.deps.sessionStore.id, switched: false },
  });
}

/** DELETE /sessions：按 id 定位归属空间后删除；归属空间内存在 in-flight run 时拒绝（per-space 互斥） */
export async function handleDeleteSession(ctx: HandlerContext, res: ServerResponse, id: string): Promise<void> {
  let store = ctx.deps.sessionStore;
  let sessions = ctx.sessions;
  if (ctx.registry) {
    const rt = await locateSession(ctx.registry, id);
    store = rt.store;
    sessions = rt.sessions;
  } else {
    // 无 registry：保持旧 not_found 校验（跨空间全扫）
    const owner = (await store.listAllWorkspaces()).find((w) => w.sessions.some((s) => s.id === id));
    if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
  }
  // per-space 互斥：仅当归属空间内该会话正在跑才拒绝（其他空间的 run 不影响）
  const entry = sessions.get(id);
  if (entry?.inFlight) {
    throw new ApiHttpError('busy', `会话 ${id} 正在处理消息，暂不能删除`);
  }
  // 需求 20261107-002 D11：删除会话时中止其全部后台子任务，避免孤儿任务继续跑
  const abortedSubAgents = subAgentRegistry.abortSession(id, `会话 ${id} 已删除`);
  await store.deleteSession(id);
  sessions.delete(id);
  ctx.runs.drop(id);
  if (abortedSubAgents > 0) {
    ctx.log(`[api] 已中止会话 ${id} 的 ${abortedSubAgents} 个后台子任务`);
  }
  // journal 联动删除（Task-20261021-002-06）：会话删除后 runs/<id>.json 一并清掉
  await dropJournal(store, id);
  ctx.log(`[api] 会话已删除: ${id}`);
  sendJson(res, 200, { deleted: true });
}

/**
 * 定位会话所属的 store / sessions / runtime（需求 20261106-005 P1）：
 * registry 形态走 session-locator；嵌入形态退回 deps.sessionStore + 全扫归属校验。
 */
function resolveSessionScope(
  ctx: HandlerContext,
  id: string,
): Promise<{ store: SessionStore; sessions: SessionManager; rt: WorkspaceRuntime | null }> {
  return (async () => {
    if (ctx.registry) {
      const rt = await locateSession(ctx.registry, id);
      return { store: rt.store, sessions: rt.sessions, rt };
    }
    const store = ctx.deps.sessionStore;
    const owner = (await store.listAllWorkspaces()).find((w) =>
      w.sessions.some((s) => s.id === id),
    );
    if (!owner) throw new ApiHttpError('not_found', `会话不存在: ${id}`);
    return { store, sessions: ctx.sessions, rt: null };
  })();
}

/**
 * GET /sessions/:id/subagents：后台子任务列表（需求 20261107-002 D9）
 *
 * 仅返回进程内运行期状态（不落盘）：运行中/已完成/失败/取消。
 * 结果卡片本身已由完成回调落盘，前端刷新后从消息历史恢复；
 * 本端点用于「运行中」卡片与 2s 轮询（以及 CLI /subagent）。
 */
export async function handleListSubAgents(
  ctx: HandlerContext,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { sessions } = await resolveSessionScope(ctx, id);
  await sessions.ensureEntry(id);
  const items = subAgentRegistry.list(id).map((t) => ({
    taskId: t.taskId,
    task: t.task,
    status: t.status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    elapsedMs: t.elapsedMs,
    iterations: t.iterations,
    answer: t.answer,
    error: t.error,
    trace: t.trace,
  }));
  // run 概况（需求 20261107-011）：后台子任务完成后主 Agent 可能被唤醒并启动新一轮，
  // 前端轮询据此发现「服务端已开始新 run」并及时 attach 续传（同一标签页没有 run-started 广播）。
  sendJson(res, 200, { items, run: ctx.runs.snapshot(id) });
}

/**
 * GET /sessions/:id/jobs：后台任务统一快照（需求 20261112-006）
 *
 * 范围 = 当前会话 + sessionId 为空的无归属任务（用户已确认），两类任务混合按时间倒序。
 * 原 /sessions/:id/subagents 保留；本端点同时返回 run 状态，供前端沿用唤醒接管逻辑。
 */
export async function handleListJobs(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { sessions } = await resolveSessionScope(ctx, id);
  await sessions.ensureEntry(id);

  const url = new URL(req.url ?? '/', 'http://localhost');
  const kindParam = url.searchParams.get('kind');
  const statusParam = url.searchParams.get('status');
  const kind: JobKind | undefined =
    kindParam === 'command' || kindParam === 'subagent' ? kindParam : undefined;
  const validStatus: JobStatus[] = ['running', 'done', 'failed', 'stopped', 'lost'];
  const status = validStatus.includes(statusParam as JobStatus)
    ? (statusParam as JobStatus)
    : undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;

  const items = listJobs({ sessionId: id, includeUnowned: true, kind, status, limit });
  sendJson(res, 200, { items, run: ctx.runs.snapshot(id) });
}

/**
 * GET /sessions/:id/context：上下文用量（需求 20261106-005 P0）
 *
 * 真实统计（最近一次 llm_stats 的 prompt_tokens）优先；历史会话/未运行过时按
 * `entry.history` 本地估算并标记 source='estimate'（与前端浮层的「估算」标注对应）。
 */
export async function handleGetSessionContext(
  ctx: HandlerContext,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { sessions } = await resolveSessionScope(ctx, id);
  const entry = await sessions.ensureEntry(id);
  const cfg = ctx.deps.getConfig();
  const wm = cfg.memory.working;
  const cached = entry.lastContext;

  let contextTokens: number;
  let maxTokens: number;
  let threshold: number;
  let source: 'stats' | 'estimate';
  let updatedAt: string | undefined;

  if (cached?.source === 'stats' && cached.contextTokens > 0) {
    contextTokens = cached.contextTokens;
    maxTokens = cached.maxTokens > 0 ? cached.maxTokens : wm.maxTokens;
    threshold = cached.threshold > 0
      ? cached.threshold
      : Math.round(maxTokens * wm.compactionThreshold);
    source = 'stats';
    updatedAt = new Date(cached.at).toISOString();
  } else {
    contextTokens = estimateMessageTokens(entry.history);
    maxTokens = wm.maxTokens;
    threshold = Math.round(maxTokens * wm.compactionThreshold);
    source = 'estimate';
  }

  // 展示态百分比：0–100 且保留 1 位小数；maxTokens<=0 时不除零
  const percent = maxTokens > 0
    ? Math.min(100, Math.round((contextTokens / maxTokens) * 1000) / 10)
    : 0;

  sendJson(res, 200, {
    contextTokens,
    maxTokens,
    threshold,
    percent,
    source,
    updatedAt,
    // 前端预判「是否还有可压缩历史」：保留窗口（最近 N 次模型调用）之外的历史才可被丢弃（需求 20261106-005）
    keepRecentTurns: wm.keepRecentTurns,
  });
}

/**
 * POST /sessions/:id/compact：空闲时强制 L1 压缩（需求 20261106-005 P1）
 *
 * - 运行中 → 409（压缩与 run 禁止并发）；
 * - 无可丢弃消息 → 200 `{ok:false,reason:'nothing_to_compact'}`（不调用 LLM）；
 * - 成功 → 复用 `updateSession` 的压缩轨迹重建，把丢弃消息归档进会话文件。
 */
export async function handleCompactSession(
  ctx: HandlerContext,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const { store, sessions, rt } = await resolveSessionScope(ctx, id);
  const entry = await sessions.ensureEntry(id);
  if (entry.inFlight) {
    throw new ApiHttpError('conflict', `会话 ${id} 正在生成，无法压缩`);
  }

  // 固定开销：真实统计存在时用「prompt_tokens - 消息估算」近似 system/工具 schema 开销
  const overhead = entry.lastContext?.source === 'stats'
    ? Math.max(0, entry.lastContext.contextTokens - estimateMessageTokens(entry.history))
    : 0;

  const onBeforeCompact = async (snap: {
    messages: ChatMessage[];
    transcript: ChatMessage[];
  }): Promise<void> => {
    // 压缩会物理删除消息：先把当前完整轨迹强制落盘，保证被丢弃内容可追溯
    await store.updateSession(id, snap.messages, undefined, { transcript: snap.transcript });
  };

  let result: CompactNowResult;
  if (rt) {
    result = await rt.pool.withAgent(id, (a) =>
      a.compactNow(entry.history, {
        sessionId: id,
        promptOverheadTokens: overhead,
        onBeforeCompact,
      }),
    );
  } else {
    // 嵌入形态（无 registry/池）：临时构造 agent 执行同一逻辑
    const agent = new ReActAgent(ctx.configLoader);
    agent.setSessionStore(store);
    agent.setCurrentSessionId(id);
    agent.setWorkspaceRoot(store.path);
    try {
      await agent.attachMemory(await ctx.createMemoryKit(), store.path);
      result = await agent.compactNow(entry.history, {
        sessionId: id,
        promptOverheadTokens: overhead,
        onBeforeCompact,
      });
    } finally {
      agent.dispose();
    }
  }

  if (result.ok && result.messages) {
    // 复用压缩轮次的重建逻辑：旧轨迹归档(is_compact=true) + 新总结消息 + 保留区
    const stored = await store.updateSession(id, result.messages, undefined, {
      transcript: result.transcript,
    });
    entry.history = stored.filter((m) => m.role !== 'system' && m.is_compact !== true);
    entry.lastContext = undefined; // 压缩后用量重算
  }

  // messages/transcript 仅用于落盘，不对外暴露
  const { messages: _messages, transcript: _transcript, ...payload } = result;
  ctx.log(
    `[api] 会话 ${id} 手动压缩: ok=${payload.ok}` +
      `${payload.reason ? ` reason=${payload.reason}` : ''}` +
      `${payload.ok ? ` ${payload.beforeTokens}→${payload.afterTokens} tokens（丢弃 ${payload.droppedCount} 条）` : ''}`,
  );
  sendJson(res, 200, payload);
}

/**
 * POST /sessions/:id/retry：替换式重试（需求 20261106-005 P1/D2/D12）
 *
 * body `{ seq, modelAlias? }`，`seq` 必须是会话恢复视图（`entry.history`）中 assistant 的下标。
 * 后端向前找最近的 user 消息作为重发文本，截断该轮及之后的全部消息（存储同步覆盖写入），
 * 然后复用 `runMessageTurn` 以 SSE 流返回新一轮回答。
 */
export async function handleRetrySession(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const seqRaw = body.seq;
  if (typeof seqRaw !== 'number' || !Number.isInteger(seqRaw) || seqRaw < 0) {
    throw new ApiHttpError('bad_request', 'seq 必须为非负整数');
  }
  const seq = seqRaw;
  const modelAliasRaw = typeof body.modelAlias === 'string' ? body.modelAlias.trim() : '';

  const { store, sessions } = await resolveSessionScope(ctx, id);
  const entry = await sessions.ensureEntry(id);
  if (entry.inFlight) {
    throw new ApiHttpError('conflict', `会话 ${id} 正在生成，无法重试`);
  }

  const target = entry.history[seq];
  if (!target || target.role !== 'assistant') {
    throw new ApiHttpError('bad_request', 'seq 必须指向一条助手回答');
  }
  // 向前找最近的「真实用户消息」作为重试锚点（跳过压缩总结等不可见消息）
  let userIdx = -1;
  for (let i = seq; i >= 0; i--) {
    const m = entry.history[i];
    if (m.role === 'user' && m.is_show !== false && !(m.kind === 'summary')) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) {
    throw new ApiHttpError('bad_request', '未找到该轮的用户消息，无法重试');
  }
  const userMsg = entry.history[userIdx];
  // show_content 为展示原文，content 为 LLM 可见原文（含上传附件的 contextNote）
  const text = (userMsg.show_content ?? userMsg.content ?? '').trim();
  if (!text) throw new ApiHttpError('bad_request', '该轮用户消息为空，无法重试');

  // ===== 存储截断（视图下标 → 存储下标）=====
  const data = await store.loadSession(id);
  const stored = data.messages ?? [];
  const visible = stored
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.role !== 'system' && m.is_compact !== true);
  // entry.history 缓存 miss 时来自 getRestoreMessages（剔除展示专用消息）；命中时含它们。
  // 以长度对齐选择映射口径，避免通知/结果卡片造成下标偏移。
  const stable = visible.filter(
    ({ m }) => !(m.role === 'user' && isDisplayOnlyContent(m.content)),
  );
  const rows = stable.length === entry.history.length ? stable : visible;
  const row = rows[userIdx];
  if (!row || row.m.role !== 'user') {
    throw new ApiHttpError(
      'bad_request',
      '会话历史已变化，请刷新后重试（无法定位该轮用户消息在存储中的位置）',
    );
  }

  await store.rewriteMessages(id, stored.slice(0, row.i));
  entry.history = entry.history.slice(0, userIdx);
  entry.lastContext = undefined;
  ctx.log(
    `[api] 会话 ${id} 重试: seq=${seq} 截断至存储第 ${row.i} 条（视图第 ${userIdx} 条）`,
  );

  await runMessageTurn(ctx, res, id, text, true, modelAliasRaw);
}
