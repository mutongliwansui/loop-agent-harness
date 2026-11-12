// 会话流式状态单例（方案-20261021-001 P0：对话后台运行与跨页面保持）
// 职责边界：
//   store —— 按 sessionId 持有消息时间线 / 运行状态 / SSE 连接 / 未读标记
//   ChatView —— 纯视图：订阅当前会话状态、渲染消息、发送与停止
// 关键点：
//   - SSE 连接与消息累加都在模块级，切换会话或离开聊天页（组件卸载）不影响 run；
//   - 不 import ./sessions.ts（避免循环依赖），活跃会话由 ChatView 通过 setActiveSession 告知，
//     列表刷新等跨模块动作交给 onRunFinished 回调（App 订阅）；
//   - 断线/离开后返回：GET /sessions/:id 的 run 为 running 时，丢弃本轮已落盘的助手快照，
//     再用 GET /sessions/:id/stream?cursor=0 全量回放重建，避免内容重复。

import { computed, reactive } from 'vue';
import { api, apiStatus, AuthError, fetchSessionContext, type SessionContextUsage } from './api/client.js';
import { sseFetch, sseGet, type SseEvent } from './api/sse.js';
import { showToast } from './toast.js';
import { postTab } from './tab-sync.js';
import { getNotifySettings, notifyRunDone, playChime } from './notify.js';
import { toolSummary } from './tool-meta.js';

export interface TextSeg {
  type: 'text';
  text: string;
}
/** 子 Agent 工具步骤（与后端 SubAgentToolStep 对齐） */
export interface SubAgentToolStepVM {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  elapsedMs?: number;
  ok?: boolean;
  iteration?: number;
}
/** 子 Agent 执行轨迹（与后端 SubAgentTrace 对齐，需求 20261107-002） */
export interface SubAgentTraceVM {
  status: 'running' | 'done' | 'failed' | 'aborted';
  iterations: number;
  think: { iteration: number; text: string }[];
  tools: SubAgentToolStepVM[];
  final?: string;
  startedAt: number;
}
/** 子 Agent 过程事件（与后端 SubAgentEventInfo 对齐） */
export interface SubAgentEventVM {
  callId: string;
  phase: 'start' | 'iteration' | 'think' | 'tool_start' | 'tool_end' | 'tool_progress' | 'final' | 'error' | 'aborted';
  iteration?: number;
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  elapsedMs?: number;
  error?: string;
}
/** 后台子任务结果卡片（kind='subagent_result' 的展示专用消息） */
export interface SubAgentResultVM {
  taskId: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';
  elapsedMs: number;
  iterations: number;
  answer?: string;
  error?: string;
  trace?: SubAgentTraceVM;
}
/**
 * 后台子任务运行期快照（GET /sessions/:id/subagents 的 items，需求 20261107-008 G1）。
 *
 * 与结果卡片（SubAgentResultVM，来自落盘历史）的区别：快照是**进程内实时状态**，
 * 不依赖 SSE、不依赖消息时间线，因此可以驱动「常驻指示器」——
 * 后台任务的生命周期远长于主 run，主 run 结束后 SSE 已关闭，只有轮询才能持续感知。
 */
export interface SubAgentTaskVM {
  taskId: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  iterations?: number;
  answer?: string;
  error?: string;
}
export interface ToolSeg {
  type: 'tool';
  tool: string;
  args: string;
  result: string;
  done: boolean;
  /** 子 Agent 过程轨迹（需求 20261107-002 D3）：默认收起，展开查看 */
  sub?: SubAgentTraceVM;
  /** 归属的 delegate callId（仅运行期用于把过程事件挂到正确卡片） */
  callId?: string;
  /** 执行耗时：tool_end 时按本地时间计算；历史消息无此值 */
  elapsedMs?: number;
  /** 执行开始时间戳（仅流式期间用于算耗时，不渲染） */
  startedAt?: number;
  /**
   * 已被用户中断（Task-20261024-001 D3）：aborted 事件到达时把同轮**未完成**的工具段标为中断，
   * 卡片显示「已中断」而非一直转圈；历史消息在 run.status==='aborted' 时对空结果段补标。
   */
  aborted?: boolean;
}
/** 时间线分段：思考/最终答案文本段与工具段按事件到达顺序交错 */
export type Segment = TextSeg | ToolSeg;
/** 流式实时阶段（文案与 CLI spinner 对齐；仅内存态，不随历史消息持久化） */
export type LivePhase =
  | { kind: 'thinking'; iteration?: number; since: number }
  | { kind: 'arg_gen'; tool: string; bytes: number; since: number }
  | { kind: 'tool_run'; tool: string; elapsedMs: number; since: number; brief?: string };
/** GET /sessions/:id 的历史消息（OpenAI 消息序：含带 tool_calls 的 assistant 与带 tool_call_id 的 tool） */
export interface ApiHistoryMsg {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** 是否在会话界面展示（system 与压缩总结消息为 false；缺省视为展示） */
  is_show?: boolean;
  /** 是否已被压缩折叠（归档消息，不进入恢复视图） */
  is_compact?: boolean;
  /** 展示内容；缺省或为空时取 content（content 为 LLM 可见原文，可能含记忆注入前缀） */
  show_content?: string;
  /** 本轮 token 统计（需求 20261106-006）：随会话落盘，仅每轮最终 assistant 消息携带 */
  usage?: TurnTokenStats;
  /** 消息种类（20261107-002）：subagent_result = 后台子任务结果卡片（仅展示，不进 LLM 历史） */
  kind?: string;
  /** 子 Agent 轨迹（20261107-002 D4）：挂在该轮 delegate 的 tool 消息上 */
  sub?: SubAgentTraceVM;
}
export interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  segments: Segment[]; // 按序渲染形成 思考→命令→思考→命令→总结 的完整过程
  /**
   * 该消息在「会话恢复视图」（后端 entry.history）中的下标（需求 20261106-005 D12）：
   * 仅历史加载时有值，流式新增为 undefined；重试以此为锚点。
   */
  seq?: number;
  /** 本轮 token 统计（需求 20261106-006）：历史来自落盘 usage，流式中由 llm_stats 实时镜像 */
  turnTokens?: TurnTokenStats;
  files?: string[]; // 该消息附带的上传文件名（仅用户消息展示）
  streaming?: boolean;
  compacting?: boolean; // 压缩中 loading（compaction_start 置 true，compaction 结束事件置 false）
  failed?: boolean;
  failedText?: string; // fatal 终止原因
  /** 被用户停止：渲染部分输出灰条（纯前端态，不进持久化内容） */
  aborted?: boolean;
  meta?: string; // done/aborted 后的耗时/轮数标注（aborted 带「已停止 ·」前缀）
  live?: LivePhase | null; // 实时状态行（思考中/生成参数/执行中）
  lastEventAt?: number; // 最近一次收到 SSE 事件的时间（长时间无事件时提示仍在响应）
  /** 后台子任务结果卡片（20261107-002 D8）：渲染为独立卡片，不占用户气泡 */
  subResult?: SubAgentResultVM;
  /**
   * L1 压缩总结文本（后端 is_show=false / kind=summary 的消息）。
   * 该消息会替代被折叠的历史进入 LLM 上下文，但原文在界面上原本被直接丢弃——
   * 用户必须知道「更早的工具输出模型已经看不到了」，因此渲染为可展开的摘要卡片。
   */
  summary?: string;
  /**
   * 已被 L1 压缩折叠进摘要的历史消息（后端 is_compact=true）。
   * 这类消息不进入恢复视图（不计 seq、不可重试），但磁盘上完好保留，
   * 界面与普通历史一样平铺渲染——否则用户会看到「前面的对话凭空消失」。
   */
  archived?: boolean;
}

/**
 * 本轮 run 的 token 累计（需求 20261106-006）：
 * 流式中由 llm_stats 逐迭代累加（iteration===1 时清零重计）；
 * run 结束由 llm_stats_summary 一次性覆盖为权威累计值。
 */
export interface TurnTokenStats {
  /** 累计输入 token */
  promptTokens: number;
  /** 累计输出 token */
  completionTokens: number;
  /** 累计总 token */
  totalTokens: number;
  /** 命中缓存的输入 token 合计（命中率分母为 promptTokens；0=无缓存数据） */
  cacheHitTokens: number;
  /** 后端汇总给出的平均命中率（优先于前端推算；厂商无缓存字段为 undefined） */
  avgCacheHitRate?: number;
  /** 采集时间（历史会话落盘数据无此字段） */
  at?: number;
}

export interface SessionStreamState {
  messages: ChatMsg[];
  status: 'idle' | 'running';
  runId?: string;
  /** 已应用的最大事件序号（attach 的 cursor） */
  lastSeq: number;
  /** POST 流（本端发起）的中断句柄 */
  controller: AbortController | null;
  /** GET attach 流的中断句柄 */
  attachCtrl: AbortController | null;
  unread: boolean;
  loaded: boolean;
  attaching: boolean;
  /** 缓冲溢出后正在重建历史：期间事件先入 pending */
  reloading: boolean;
  pending: SseEvent[];
  /**
   * 重建期间又被请求一次重建（需求 20261107-008 G3）：
   * 原实现直接丢弃，导致「两个后台任务先后完成」时第二次完成通知被吞（task-006 B3）。
   */
  pendingResync?: boolean;
  /** 首次加载去重（并发 ensureLoaded 共享同一请求） */
  loadTask: Promise<void> | null;
  /**
   * 时间线尾注记（task-06，前端态不进消息数组）：
   * lastRun=interrupted → 「⚠ 上次运行被中断（服务已重启）…」；lastRun=aborted → 「上次运行由用户停止」
   */
  note?: string;
  /** 本轮 run 起始时间戳（task-07：finishRun 计算耗时供通知/广播展示；无记录为 undefined） */
  runStartedAt?: number;
  /** 上下文用量（需求 20261106-005）：llm_stats 实时刷新，历史加载/压缩后由 GET /context 兜底 */
  context?: SessionContextUsage;
  /** 本轮 token 累计（需求 20261106-006）：llm_stats 逐迭代累加，llm_stats_summary 覆盖 */
  turnTokens?: TurnTokenStats;
}

const EMPTY_MESSAGES: ChatMsg[] = [];
const states = reactive(new Map<string, SessionStreamState>());
let msgSeq = 0;
let activeSessionId: string | null = null;
/** 聊天视图是否在场：不在场时完成的 run 记未读并提示 */
let chatViewMounted = false;
let activityHandler: ((id: string) => void) | null = null;
const finishHandlers = new Set<(id: string) => void>();

function nextMsgId(): number {
  return ++msgSeq;
}

export function stateOf(id: string): SessionStreamState {
  let st = states.get(id);
  if (!st) {
    st = reactive<SessionStreamState>({
      messages: [],
      status: 'idle',
      lastSeq: 0,
      controller: null,
      attachCtrl: null,
      unread: false,
      loaded: false,
      attaching: false,
      reloading: false,
      pending: [],
      loadTask: null,
    });
    states.set(id, st);
  }
  return st;
}

function notifyActivity(id: string): void {
  activityHandler?.(id);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ================= 只读查询 ================= */

/** 会话消息时间线；未加载返回共享空数组（模板可直接 v-for） */
export function messagesOf(id: string | null): ChatMsg[] {
  if (!id) return EMPTY_MESSAGES;
  return states.get(id)?.messages ?? EMPTY_MESSAGES;
}

export function isRunning(id: string): boolean {
  return states.get(id)?.status === 'running';
}

export const runningCount = computed<number>(() => {
  let n = 0;
  for (const st of states.values()) if (st.status === 'running') n++;
  return n;
});

/** 后台完成且未查看的会话数（标题栏提示） */
export const unreadCount = computed<number>(() => {
  let n = 0;
  for (const st of states.values()) if (st.unread) n++;
  return n;
});

export function isUnread(id: string): boolean {
  return states.get(id)?.unread === true;
}

/** 会话上下文用量（未加载/请求失败为 undefined）；需求 20261106-005 */
export function contextOf(id: string | null): SessionContextUsage | undefined {
  if (!id) return undefined;
  return states.get(id)?.context;
}

/** 本轮 token 累计（未跑过为 undefined，对应「纯历史会话不显示 chip」）；需求 20261106-006 */
export function turnTokensOf(id: string | null): TurnTokenStats | undefined {
  if (!id) return undefined;
  return states.get(id)?.turnTokens;
}

/**
 * 拉取一次上下文用量（GET /sessions/:id/context）。
 * 失败静默（展示态数据，不应打断会话加载/压缩流程）；调用方需要错误时自行捕获。
 */
export async function refreshContext(id: string): Promise<void> {
  try {
    const ctx = await fetchSessionContext(id);
    stateOf(id).context = ctx;
  } catch {
    // 静默：上下文展示失败不影响主流程
  }
}

export function markRead(id: string): void {
  const st = states.get(id);
  const wasUnread = st?.unread === true;
  if (st) st.unread = false;
  // 跨标签页收敛（Task-20261021-002-07 D8）：他页也清未读，但接收端不回播（防乒乓）
  if (wasUnread) postTab({ t: 'unread-cleared', id });
}

export function setActiveSession(id: string | null): void {
  activeSessionId = id;
  if (id) markRead(id);
}

export function setChatViewMounted(v: boolean): void {
  chatViewMounted = v;
}

/** ChatView 注册：流式事件到达时按需滚动（仅活跃会话） */
export function setActivityHandler(fn: ((id: string) => void) | null): void {
  activityHandler = fn;
}

/** App 注册：run 结束（done/fatal）后刷新会话列表 */
export function onRunFinished(cb: (id: string) => void): () => void {
  finishHandlers.add(cb);
  return () => finishHandlers.delete(cb);
}

/* ================= 历史加载 ================= */

/**
 * GET messages（OpenAI 消息序）→ ChatMsg 时间线：
 * user 消息开新一轮；assistant(content+tool_calls) 拆成文本段+工具段；tool 消息按 tool_call_id 回填结果。
 * 与流式渲染的 segments 模型对齐——重进会话同样还原 思考→工具→思考→总结 的完整过程。
 */
function rebuildChatMsgs(list: ApiHistoryMsg[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  let pending: Segment[] = [];
  let pendingSeq: number | undefined;
  // 当前累积中的 assistant 消息是否属于归档区（已折叠历史）
  let pendingArchived = false;
  // 需求 20261106-006：bundle 内任何 assistant 携带落盘 usage 时挂到展示消息上（每轮最终 assistant）
  let pendingUsage: TurnTokenStats | undefined;
  // 恢复视图下标：system 与已折叠归档不计数，其余（含压缩总结）计入后端 entry.history
  let viewIdx = 0;
  const toolSegById = new Map<string, ToolSeg>();
  const flush = (): void => {
    if (pending.length > 0) {
      out.push({
        id: nextMsgId(),
        role: 'assistant',
        segments: pending,
        seq: pendingSeq,
        turnTokens: pendingUsage,
        ...(pendingArchived ? { archived: true } : {}),
      });
    }
    pending = [];
    pendingSeq = undefined;
    pendingUsage = undefined;
    pendingArchived = false;
  };
  for (const m of list) {
    if (m.role === 'system') continue;
    // 已被 L1 压缩折叠进摘要的历史（is_compact=true）：磁盘上完整保留，仅「不进入 LLM 上下文」。
    // 这里仍还原为消息（标记 archived）并正常展示——此前直接 continue 丢弃，
    // 导致用户看到「压缩后前面的消息没了」（数据其实没丢）。
    // 注意不计 viewIdx：归档消息不在后端 entry.history 里，计入会让重试锚点整体偏移。
    const archived = m.is_compact === true;
    // 后台子任务结果卡片是展示专用消息（不进 LLM 历史），不占用恢复视图下标。
    // 需求 20261108-003：kind 可能被压缩全量重写清掉（旧版 toStoredMessage），
    // 内容兜底与后端 isSubAgentResultContent 同形，识别失败时原文会裸渲到界面上
    if (m.role === 'user' && (m.kind === 'subagent_result' || isSubAgentResultContent(m.content))) {
      flush();
      const card = parseSubAgentResultCard(m.show_content || m.content || '', m.sub);
      if (card) out.push({ id: nextMsgId(), role: 'user', segments: [], subResult: card });
      continue;
    }
    const historyIdx = archived ? undefined : viewIdx++;
    // 不展示的消息：压缩总结消息（is_show=false）——它替代了被折叠的历史进入模型上下文，
    // 但界面上原本被直接丢弃，用户看不到「模型已经只认摘要」这件事。
    // 现在渲染为可展开的摘要卡片（role 仍按 user 承载，seq 计入恢复视图下标，锚点语义不变）。
    if (m.is_show === false) {
      // 空摘要没有展示价值，仍按原逻辑静默跳过，避免渲染出空气泡。
      // 存量会话的旧占位可能仍带 [历史摘要] 前缀，展示时剥掉。
      const summaryText = (m.content ?? '').replace(/^\[历史摘要\]\s*/, '');
      if (m.role === 'user' && summaryText.trim()) {
        flush();
        out.push({
          id: nextMsgId(),
          role: 'user',
          segments: [],
          seq: historyIdx,
          summary: summaryText,
        });
      }
      continue;
    }
    if (m.role === 'user') {
      flush();
      // content 为 LLM 可见原文（可能含记忆注入前缀），展示优先用 show_content 还原；
      // 需求 20261108-003：show_content 缺失时（存量数据/特殊落盘路径）前端兜底剥离，
      // 不再单点依赖后端写入的 show_content——否则「## 相关历史记忆…<<<LOOP_AGENT_MEMORY_END…>>>」
      // 会裸渲到界面上
      const text = stripMemorySection(m.show_content || m.content || '');
      out.push({
        id: nextMsgId(),
        role: 'user',
        segments: [{ type: 'text', text }],
        seq: historyIdx,
        ...(archived ? { archived: true } : {}),
      });
    } else if (m.role === 'assistant') {
      if (archived) pendingArchived = true;
      if (m.content) pending.push({ type: 'text', text: m.content });
      if (m.usage) pendingUsage = m.usage;
      // 同轮多条 assistant（工具调用链）共用首条的下标，重试锚点即该轮回答
      if (pendingSeq === undefined && historyIdx !== undefined) pendingSeq = historyIdx;
      for (const tc of m.tool_calls ?? []) {
        let args = tc.function.arguments;
        try {
          args = JSON.stringify(JSON.parse(args)); // 历史存的是 JSON 串，重排与流式路径展示一致
        } catch {
          /* 非法 JSON 保留原串 */
        }
        const seg: ToolSeg = { type: 'tool', tool: tc.function.name, args, result: '', done: true };
        pending.push(seg);
        toolSegById.set(tc.id, seg);
      }
    } else if (m.role === 'tool') {
      const seg = toolSegById.get(m.tool_call_id ?? '');
      if (seg) {
        seg.result = m.content ?? '';
        // 落盘轨迹恢复：刷新/重进会话后过程区仍可展开
        if (m.sub) seg.sub = m.sub;
      }
    }
  }
  flush();
  return out;
}

/** 解析后台子任务结果卡片（content 由后端 serializeSubAgentResult 生成） */

/* ===== 展示层兜底（需求 20261108-003）=====
 * 后端判展示专用消息用内容特征（src/types.ts isSubAgentResultContent，容忍 L2 记忆前缀包裹），
 * 前端此前只认 kind 标记——标记被压缩全量重写清掉后（旧版 toStoredMessage 无条件 delete），
 * 卡片报文被当普通文本渲染。两侧各自独立实现（不跨端 import），判据保持同形。
 */
const SUBAGENT_RESULT_OPEN = '<subagent_result>';
const SUBAGENT_RESULT_CLOSE = '</subagent_result>';

/** 判断消息文本是否为后台子任务结果卡片（容忍 L2 记忆前缀包裹，与后端同形） */
function isSubAgentResultContent(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  return t.endsWith(SUBAGENT_RESULT_CLOSE) && t.includes(SUBAGENT_RESULT_OPEN);
}

// L2 记忆注入前缀（与后端 memory-section.ts 同形；show_content 缺失时的展示剥离兜底）
const MEMORY_SECTION_HEAD = '## 相关历史记忆\n以下是你在之前会话中积累的相关信息，请参考：\n';
const MEMORY_SECTION_TAIL = '\n\n<<<LOOP_AGENT_MEMORY_END_7f3a9c2e>>>\n\n';

/** 剥离 L2 记忆注入前缀（循环剥离嵌套前缀），未命中原样返回 */
function stripMemorySection(content: string): string {
  let cur = content;
  while (cur.startsWith(MEMORY_SECTION_HEAD)) {
    const tailIdx = cur.indexOf(MEMORY_SECTION_TAIL, MEMORY_SECTION_HEAD.length);
    if (tailIdx < 0) break;
    cur = cur.slice(tailIdx + MEMORY_SECTION_TAIL.length);
  }
  return cur;
}

function parseSubAgentResultCard(content: string, sub?: SubAgentTraceVM): SubAgentResultVM | undefined {
  const m = content.match(/<subagent_result>([\s\S]*?)<\/subagent_result>/);
  if (!m) return undefined;
  const body = m[1];
  const field = (key: string): string | undefined => {
    const hit = body.match(new RegExp(`^${key}: ?(.*)$`, 'm'));
    return hit ? hit[1].trim() : undefined;
  };
  const answerStart = body.indexOf('answer: ');
  const errorStart = body.indexOf('\nerror: ');
  const answer = answerStart >= 0
    ? body
        .slice(answerStart + 'answer: '.length, errorStart > answerStart ? errorStart : undefined)
        .trim()
    : undefined;
  return {
    taskId: field('taskId') ?? 'sub_unknown',
    task: field('task') ?? '',
    status: (field('status') as SubAgentResultVM['status']) ?? 'done',
    elapsedMs: Number(field('elapsedMs') ?? 0),
    iterations: Number(field('iterations') ?? 0),
    answer: answer || undefined,
    error: field('error') || undefined,
    trace: sub,
  };
}

/** SSE 过程事件合入前端轨迹（规则与后端 applySubAgentEvent 对齐） */
function applySubAgentEventVM(trace: SubAgentTraceVM, info: SubAgentEventVM): void {
  switch (info.phase) {
    case 'start':
      trace.startedAt = Date.now();
      break;
    case 'iteration':
      trace.iterations = Math.max(trace.iterations, info.iteration ?? 0);
      break;
    case 'think':
      if (info.text) trace.think.push({ iteration: info.iteration ?? 1, text: info.text });
      break;
    case 'tool_start':
      trace.tools.push({
        name: info.tool ?? 'unknown',
        args: info.args,
        iteration: info.iteration,
      });
      break;
    case 'tool_end': {
      for (let i = trace.tools.length - 1; i >= 0; i--) {
        const s = trace.tools[i];
        if (s.name === info.tool && s.result === undefined) {
          s.result = info.result;
          s.ok = !(info.result ?? '').startsWith('工具执行失败');
          if (info.elapsedMs !== undefined) s.elapsedMs = info.elapsedMs;
          break;
        }
      }
      break;
    }
    case 'tool_progress': {
      const last = trace.tools[trace.tools.length - 1];
      if (last && info.elapsedMs !== undefined) last.elapsedMs = info.elapsedMs;
      break;
    }
    case 'final':
      trace.final = info.text;
      trace.status = 'done';
      break;
    case 'error':
      trace.status = 'failed';
      break;
    case 'aborted':
      trace.status = 'aborted';
      break;
  }
}

/** 找到（或认领）当前轮 assistant 消息里对应的 delegate 卡片段 */
function attachSubAgentSeg(st: SessionStreamState, callId: string): ToolSeg | undefined {
  const msg = st.messages[st.messages.length - 1];
  if (!msg || msg.role !== 'assistant') return undefined;
  const segs = msg.segments.filter(
    (s): s is ToolSeg => s.type === 'tool' && s.tool === 'delegate',
  );
  const hit = segs.find((s) => s.callId === callId);
  if (hit) return hit;
  // 首次事件：按到达顺序认领一个尚未归属的 delegate 段（并发 delegate 时不串台）
  const free = segs.find((s) => !s.callId);
  if (free) free.callId = callId;
  return free;
}

interface SessionDetail {
  messages: ApiHistoryMsg[];
  run?: { runId: string; status: 'running' | 'done' | 'failed' | 'aborted' } | null;
  /** run journal 磁盘态（task-06）：服务重启后 run=null，lastRun 仍可判中断/停止 */
  lastRun?: { status: string; finishedAt?: number } | null;
}

async function fetchDetail(id: string, st: SessionStreamState): Promise<void> {
  const r = await api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
  const msgs = rebuildChatMsgs(r.messages);
  const running = r.run?.status === 'running';
  if (running) {
    // 节流快照可能已含本轮部分助手输出：截断到最后一条 user 之后，交给 attach 全量回放重建
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser = i;
        break;
      }
    }
    msgs.length = lastUser + 1;
  }
  st.messages.splice(0, st.messages.length, ...msgs);
  st.loaded = true;
  st.lastSeq = 0;
  st.status = running ? 'running' : 'idle';
  st.runId = r.run?.runId;
  if (running) void attach(id);
  // 上下文用量兜底（需求 20261106-005）：历史会话无 llm_stats → 后端估算并标记 source='estimate'
  void refreshContext(id);
  // 刷新后灰条恢复（6.2.2）：历史消息不含中断标记（task-03 D4 中断标记不落盘），
  // 但 run 终态在服务端有 60s 保留期——刚停止后刷新页面时 run.status 仍为 'aborted'，
  // 末尾助手消息即为被停止的那轮部分输出，补标灰条与「已停止 ·」标注。
  // 超过保留期后快照为 null，此时界面仅剩标注文字，灰条自然消失（可接受降级）。
  if (r.run?.status === 'aborted' && msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'assistant') {
      last.aborted = true;
      last.meta = last.meta ? `已停止 · ${last.meta}` : '已停止';
      // 刷新恢复的这轮同样要补「已中断」工具态：磁盘无该标记（D4 不落盘），此处按 run 终态派生
      markToolSegsAborted(last);
    }
  }
  // 重启后中断/停止注记（task-06）：内存 run 已消失（快照 null）时按磁盘 journal 派生。
  // interrupted 只可能来自启动扫描（bootId 不匹配），前端态 note 渲染，不进消息数组（task-03 D4）
  if (!r.run && r.lastRun?.status === 'interrupted') {
    st.note = '⚠ 上次运行被中断（服务已重启），以上为已保存的部分输出';
  } else if (!r.run && r.lastRun?.status === 'aborted') {
    st.note = '上次运行由用户停止';
  } else if (st.note?.startsWith('⚠') || st.note === '上次运行由用户停止') {
    st.note = undefined;
  }
  // 加载完成即补偿一次后台任务状态（G2 条件③）：刷新页面/切会话/SSE 未连上时
  // 也能立刻拿到「运行中 N」，不再依赖是否收到过 sub_ start 事件
  void bootstrapSubAgents(id);
}

/** 首次进入会话时加载历史（已加载直接返回）；加载中共享同一请求 */
export function ensureLoaded(id: string): Promise<void> {
  const st = stateOf(id);
  if (st.loaded) return Promise.resolve();
  if (!st.loadTask) {
    st.loadTask = fetchDetail(id, st).finally(() => {
      st.loadTask = null;
    });
  }
  return st.loadTask;
}

/** 新建会话后初始化一个空时间线（不发请求） */
export function initEmpty(id: string): void {
  const st = stateOf(id);
  st.messages.splice(0, st.messages.length);
  st.loaded = true;
  st.lastSeq = 0;
  st.status = 'idle';
  st.unread = false;
  st.pending = [];
}

/** 删除会话时丢弃内存状态 */
export function drop(id: string): void {
  const st = states.get(id);
  if (!st) return;
  st.controller?.abort();
  st.attachCtrl?.abort();
  states.delete(id);
  // 后台任务撤销随会话一起收尾（需求 20261107-008）：停轮询、清快照，
  // 否则已删除会话的「运行中 N」会一直挂在全局指示器上
  stopSubAgentPoll(id);
  subTasks.delete(id);
}

/**
 * 删除会话的完整收尾（Task-20261021-002-07）：drop 内存状态 + 广播他页移除。
 * 广播独立成函数而非内联 drop：非删除场景（如收他页广播后的本端清理）复用 drop 不产生回环
 */
export function dropAndBroadcast(id: string): void {
  drop(id);
  postTab({ t: 'session-dropped', id });
}

/* ================= 跨标签页广播接收（Task-20261021-002-07，App.vue onTab 转发） ================= */

/** 收到他页 run-started：本端空闲则唤醒为 running 并 attach 续传（001 多订阅能力复用） */
export function handleRemoteRunStarted(id: string): void {
  const st = stateOf(id);
  if (st.status !== 'running') {
    st.status = 'running';
    void attach(id);
  }
}

/** 收到他页 run-finished：本端在跟则 reconcile 对齐；非活跃/聊天页不在场记未读 */
export function handleRemoteRunFinished(id: string): void {
  const st = stateOf(id);
  if (st.status === 'running') void reconcile(id);
  if (!chatViewMounted || activeSessionId !== id) st.unread = true;
}

/** 他页已读收敛（D8 不回播）：仅清本端未读，不再广播，防两页同看一会话时乒乓清零 */
export function markReadRemote(id: string): void {
  const st = states.get(id);
  if (st) st.unread = false;
}

/* ================= SSE 事件 → 消息时间线 ================= */

/** 取/建当前 run 的助手消息（末尾不是助手消息时新建响应式占位） */
function currentAssistant(st: SessionStreamState): ChatMsg {
  const last = st.messages[st.messages.length - 1];
  if (last && last.role === 'assistant') return last;
  // 必须 reactive：流式期间事件处理器持有此引用做 += 累加，若为普通对象，
  // 写入绕过响应式代理不触发渲染 → 表现为“全部生成完后才一次性出现”
  const asst = reactive<ChatMsg>({
    id: nextMsgId(),
    role: 'assistant',
    segments: [],
    streaming: true,
    live: { kind: 'thinking', since: Date.now() },
    lastEventAt: Date.now(),
  });
  st.messages.push(asst);
  return asst;
}

/** run 结束状态（D5：task-07 tab 广播/系统通知直接复用） */
type RunEndStatus = 'done' | 'failed' | 'aborted';

function finishRun(id: string, st: SessionStreamState, status: RunEndStatus = 'done'): void {
  if (st.status !== 'running') return;
  const startedAt = st.runStartedAt ?? 0;
  st.status = 'idle';
  st.controller = null;
  st.attachCtrl?.abort();
  st.attachCtrl = null;
  st.attaching = false;
  st.pending = [];
  // 聊天页不在场或看的是别的会话：记未读 + 提醒（切回时 ChatView 会 markRead）
  if (!chatViewMounted || activeSessionId !== id) {
    st.unread = true;
    // 前后台分流（Task-20261021-002-07 D3）：后台 → 系统通知 + 提示音；前台 → 页内 toast（001 现状）
    // 非浏览器环境（node 单测）document 未定义：按前台处理（与 001 行为一致）
    const background =
      typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
    const cfg = getNotifySettings();
    // 会话标题由 App 侧栏持有（sessions.ts），chat-stream 不引入避免循环依赖；
    // 通知标题用 sessionId 兜底（notifyRunDone 内部处理）
    const durationMs = startedAt > 0 ? Date.now() - startedAt : undefined;
    if (background) {
      notifyRunDone({ sessionId: id, title: id, status, durationMs });
      if (cfg.sound) playChime();
    } else {
      showToast(status === 'aborted' ? '后台会话已被停止' : '后台会话已生成完成');
    }
  }
  // 跨标签页广播（Task-20261021-002-07）：让他页收敛未读/刷新侧栏（B 页自行 reconcile）
  postTab({ t: 'run-finished', id, status, durationMs: startedAt > 0 ? Date.now() - startedAt : undefined });
  notifyActivity(id);
  for (const cb of finishHandlers) cb(id);
}

/** 应用单个事件（不做去重/缓冲判断） */
function applyEvent(id: string, ev: SseEvent): void {
  const st = states.get(id);
  if (!st) return;
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const now = Date.now();
  switch (ev.event) {
    case 'start': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.live = { kind: 'thinking', since: now };
      break;
    }
    case 'iteration_start': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      // 服务端轮次从 0 起算，与 CLI 一致展示为「第 N+1 轮」
      asst.live = { kind: 'thinking', iteration: Number(d.iteration ?? 0) + 1, since: now };
      break;
    }
    case 'llm_stream': {
      // 思考/最终答案 delta：上一段是工具段时开新文本段，天然形成 思考→工具→思考 交错
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      if (!asst.live || asst.live.kind !== 'thinking') asst.live = { kind: 'thinking', since: now };
      const last = asst.segments[asst.segments.length - 1];
      const seg = last && last.type === 'text' ? last : { type: 'text' as const, text: '' };
      if (seg !== last) asst.segments.push(seg);
      seg.text += String(d.text ?? '');
      notifyActivity(id);
      break;
    }
    case 'tool_call_delta': {
      // 工具参数逐 token 生成（fileWrite 写长代码时可持续数十秒）：显示已生成体积与耗时
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      const elapsed = Number(d.elapsedMs ?? 0);
      asst.live = {
        kind: 'arg_gen',
        tool: String(d.tool ?? ''),
        bytes: Number(d.accumulatedBytes ?? 0),
        since: now - elapsed, // 用服务端耗时反推起点，对象重建但耗时连续
      };
      notifyActivity(id);
      break;
    }
    case 'tool_start': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.live = { kind: 'tool_run', tool: String(d.tool ?? ''), elapsedMs: 0, since: now };
      asst.segments.push({
        type: 'tool',
        tool: String(d.tool ?? ''),
        args: JSON.stringify(d.args ?? null),
        result: '',
        done: false,
        startedAt: now,
      });
      notifyActivity(id);
      break;
    }
    case 'tool_progress': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      // 执行期每秒心跳：以服务端 elapsedMs 为准，LiveStatus 内再用本地时钟兜底；
      // brief 从最近的同名未完成工具段 args 计算（D6）
      const progTool = String(d.tool ?? '');
      let brief = '';
      for (let i = asst.segments.length - 1; i >= 0; i--) {
        const s = asst.segments[i];
        if (s.type === 'tool' && !s.done && s.tool === progTool) {
          brief = toolSummary(progTool, s.args);
          break;
        }
      }
      asst.live = {
        kind: 'tool_run',
        tool: progTool,
        elapsedMs: Number(d.elapsedMs ?? 0),
        since: now - Number(d.elapsedMs ?? 0),
        brief,
      };
      break;
    }
    case 'tool_end': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      // 从尾部反查第一个未完成同名工具段回填结果
      for (let i = asst.segments.length - 1; i >= 0; i--) {
        const s = asst.segments[i];
        if (s.type === 'tool' && !s.done && s.tool === String(d.tool ?? '')) {
          s.result = typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? null);
          s.done = true;
          s.elapsedMs = s.startedAt != null ? now - s.startedAt : undefined;
          break;
        }
      }
      // 工具结束后模型重新思考（并行工具仍在跑时，下一次 tool_progress 会覆盖回来）
      asst.live = { kind: 'thinking', since: now };
      notifyActivity(id);
      break;
    }
    case 'llm_stats': {
      // 真实用量（需求 20261106-005 P0）：每次迭代刷新百分比环与浮层明细
      const raw = (d.stats ?? {}) as {
        iteration?: number;
        contextTokens?: number;
        contextMaxTokens?: number;
        contextThreshold?: number;
        promptTokens?: number;
        completionTokens?: number;
        cacheHitTokens?: number;
      };
      const maxTokens = Number(raw.contextMaxTokens ?? 0);
      const contextTokens = Number(raw.contextTokens ?? 0);
      st.context = {
        contextTokens,
        maxTokens,
        threshold: Number(raw.contextThreshold ?? 0),
        percent: maxTokens > 0
          ? Math.min(100, Math.round((contextTokens / maxTokens) * 1000) / 10)
          : 0,
        // 保留窗口只在 GET /context 返回；实时事件沿用已知值（未知时按默认 10 次调用）
        keepRecentTurns: st.context?.keepRecentTurns ?? 10,
        source: 'stats',
      };
      // 本轮 token 累计（需求 20261106-006）：iteration===1 视为新一轮，清零后累加；
      // run 结束的 llm_stats_summary 会用权威累计值覆盖这里的临时值
      const iteration = Number(raw.iteration ?? 0);
      const base = iteration <= 1 ? undefined : st.turnTokens;
      const p = Number(raw.promptTokens ?? 0);
      const c = Number(raw.completionTokens ?? 0);
      st.turnTokens = {
        promptTokens: (base?.promptTokens ?? 0) + p,
        completionTokens: (base?.completionTokens ?? 0) + c,
        totalTokens: (base?.totalTokens ?? 0) + p + c,
        cacheHitTokens: (base?.cacheHitTokens ?? 0) + Number(raw.cacheHitTokens ?? 0),
        avgCacheHitRate: base?.avgCacheHitRate,
        at: Date.now(),
      };
      // 镜像到当前回答：Token chip 随流式实时刷新（需求 20261106-006）
      currentAssistant(st).turnTokens = st.turnTokens;
      break;
    }
    case 'llm_stats_summary': {
      // 本轮权威累计（需求 20261106-006）：覆盖流式中的逐迭代累加值
      const s = (d.summary ?? {}) as {
        totalPrompt?: number;
        totalCompletion?: number;
        totalTokens?: number;
        totalCacheHit?: number;
        avgCacheHitRate?: number;
      };
      st.turnTokens = {
        promptTokens: Number(s.totalPrompt ?? 0),
        completionTokens: Number(s.totalCompletion ?? 0),
        totalTokens: Number(s.totalTokens ?? 0),
        cacheHitTokens: Number(s.totalCacheHit ?? 0),
        avgCacheHitRate: typeof s.avgCacheHitRate === 'number' ? s.avgCacheHitRate : undefined,
        at: Date.now(),
      };
      // 权威累计落到本轮回答上：刷新/重进会话后由落盘 usage 恢复展示
      currentAssistant(st).turnTokens = st.turnTokens;
      break;
    }
    case 'compaction_start': {
      // 压缩开始（flush 提取期间有一次额外 LLM 调用，主输出会暂停）：显示压缩 loading
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.compacting = true;
      asst.live = null;
      notifyActivity(id);
      break;
    }
    case 'compaction': {
      // 压缩结束事件（成功/失败/异常兜底均会到达，与 compaction_start 配对）：移除 loading
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.compacting = false;
      asst.live = { kind: 'thinking', since: now };
      const info = (d.info ?? {}) as {
        failed?: boolean;
        fallback?: string;
        keptMessages?: number;
        flushedChars?: number;
      };
      if (info.failed) {
        // 压缩期被用户停止（Task-20261021-002-02 D4）：aborted 终止事件随 run 取消到达，
        // 紧随其后的 aborted 终态会再提示「已被用户停止」，这里换文案避免语义混淆
        if (info.fallback === 'aborted') {
          showToast('对话压缩已随停止终止', 'error');
        } else {
          showToast(
            info.fallback === 'archive'
              ? '压缩提取失败：已降级存档原始对话后压缩'
              : '压缩提取失败：已保留全部历史',
            'error',
          );
        }
      } else {
        // 压缩成功此前完全静默：用户以为界面上的工具输出模型都还看得到，
        // 实际模型只剩一段摘要，导致「输出被吞」的错觉。这里显式提示一次。
        showToast(
          `对话历史已压缩（保留最近 ${info.keptMessages ?? '若干'} 条消息），更早的工具输出已折叠为摘要，模型不再看到原文`,
          'info',
          6000,
        );
      }
      notifyActivity(id);
      break;
    }
    case 'final': {
      // 最终答案已随最后一轮 llm_stream 流入末尾文本段，覆盖会把前面各轮思考全部抹掉；
      // 仅在末尾没有文本段（异常路径）或其为空时兜底写入
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      const answer = String(d.answer ?? '');
      const last = asst.segments[asst.segments.length - 1];
      if (!last || last.type !== 'text') asst.segments.push({ type: 'text', text: answer });
      else if (!last.text) last.text = answer;
      asst.live = null;
      break;
    }
    case 'error':
      showToast(`模型错误: ${String(d.message ?? d.name ?? '')}`, 'error');
      break;
    case 'warning':
      showToast(String(d.message ?? ''), 'error');
      break;
    case 'fatal': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.streaming = false;
      asst.live = null;
      asst.failed = true;
      asst.failedText = String(d.message ?? '生成失败');
      finishRun(id, st, 'failed');
      break;
    }
    case 'aborted': {
      // 用户停止（Task-20261021-002-04）：保留已生成部分输出，标灰条 + 「已停止 ·」标注；
      // 部分输出已落盘（task-03），随后 reconcile 与磁盘对齐
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.streaming = false;
      asst.compacting = false;
      asst.live = null;
      asst.aborted = true;
      asst.meta = `已停止 · ${(Number(d.durationMs ?? 0) / 1000).toFixed(1)}s · ${String(d.iterations ?? '?')} 轮`;
      // 未完成的工具段不会再有 tool_end：标为已中断，卡片显示「已中断」而非转圈（D3）
      markToolSegsAborted(asst);
      finishRun(id, st, 'aborted');
      void reconcile(id, true);
      break;
    }
    // 子 Agent 过程事件（需求 20261107-002 D3）：按 callId 挂到 delegate 卡片，驱动「过程区」
    case 'subagent_event': {
      const info = (d as { info?: SubAgentEventVM }).info;
      if (info?.callId) {
        const seg = attachSubAgentSeg(st, info.callId);
        if (seg) {
          if (!seg.sub) {
            seg.sub = {
              status: 'running',
              iterations: 0,
              think: [],
              tools: [],
              startedAt: Date.now(),
            };
          }
          applySubAgentEventVM(seg.sub, info);
        }
        // 后台子任务提交后启动 2s 轮询，完成后以落盘历史为准重建（D9）
        if (info.callId.startsWith('sub_') && info.phase === 'start') ensureSubAgentPoll(id);
      }
      break;
    }
    // 后台子任务完成：结果卡片已由服务端落盘，静默重拉历史
    case 'subagent_result': {
      void resync(id);
      // 快照同步（需求 20261107-008）：卡片落盘与 registry 状态是两条链路，
      // 事件到达时顺手刷新一次，让常驻指示器的「运行中 N」立刻减一
      void tickSubAgents(id);
      break;
    }
    case 'done': {
      const asst = currentAssistant(st);
      asst.lastEventAt = now;
      asst.streaming = false;
      asst.live = null;
      asst.meta = `${(Number(d.durationMs ?? 0) / 1000).toFixed(1)}s · ${String(d.iterations ?? '?')} 轮`;
      finishRun(id, st);
      void reconcile(id);
      break;
    }
    default:
      break; // llm_end/end 等事件不改变可见状态
  }
}

/* ===== 后台子任务：运行期快照、常驻指示与轮询（需求 20261107-008） =====
 *
 * 背景（task-006 §2.2/§2.3）：后台子任务的生命周期远长于主 run。delegate(background)
 * 立即返回后主 run 很快 done、SSE 关闭，此后 subagent_event / subagent_result 无人接收；
 * 原轮询只在「SSE 活跃时收到 sub_ start 事件」才启动，错过该事件（刷新页面、SSE 已断）
 * 就永久失联 → 运行中看不见、完成了也不知道。
 *
 * 治理：改为**数据驱动**——快照来自轮询端点而不是事件流。
 *   G1 常驻指示器读 snapshots（subAgentTasksOf）
 *   G2 启动条件放宽：SSE start 事件 / 历史残留 running 卡片 / 会话加载与重连后主动查一次
 *   G3 resync 排队补执行，不静默丢弃
 *   G4 运行中 → 终态时弹提示（本端正在看该会话）
 */

/** 空快照（未加载过的会话，模板可直接 v-for） */
const EMPTY_SUB_TASKS: SubAgentTaskVM[] = [];
/** 按会话保存的运行期快照（轮询刷新；不随消息时间线重建而丢失） */
const subTasks = reactive(new Map<string, SubAgentTaskVM[]>());
/** 已弹过终态提示的 taskId：bootstrap 与轮询可能并发，避免同一任务重复提示 */
const notifiedTaskIds = new Set<string>();

/** 会话的后台子任务快照（未加载返回共享空数组） */
export function subAgentTasksOf(id: string | null): SubAgentTaskVM[] {
  if (!id) return EMPTY_SUB_TASKS;
  return subTasks.get(id) ?? EMPTY_SUB_TASKS;
}

/** 全局「后台子任务运行中」计数：顶栏/输入区常驻指示器与侧栏 badge 共用 */
export const subAgentRunningCount = computed<number>(() => {
  let n = 0;
  for (const list of subTasks.values()) {
    for (const t of list) if (t.status === 'running') n++;
  }
  return n;
});

/**
 * 拉一次 /subagents 并更新快照。
 * 返回是否仍有运行中的任务 + 服务端 run 状态（需求 20261107-011：后台子任务完成后
 * 主 Agent 可能被唤醒并启动新一轮，前端需要据此 attach 续传）。
 * 失败向上抛（调用方决定是否停表）；会话已删除/鉴权失败时轮询应停止。
 */
async function refreshSubAgents(id: string): Promise<{
  running: boolean;
  runStatus: string | null;
}> {
  const r = await api<{
    items: SubAgentTaskVM[];
    run?: { status?: string } | null;
  }>(`/sessions/${encodeURIComponent(id)}/subagents`);
  const items = Array.isArray(r.items) ? r.items : [];
  const prev = subTasks.get(id) ?? [];
  const prevRunning = new Set(
    prev.filter((t) => t.status === 'running').map((t) => t.taskId),
  );
  // G4：运行中 → 终态，且本端正在看这个会话（否则交给未读/侧栏提示，不打扰）
  if (chatViewMounted && activeSessionId === id) {
    for (const t of items) {
      if (!prevRunning.has(t.taskId) || t.status === 'running') continue;
      if (notifiedTaskIds.has(t.taskId)) continue;
      notifiedTaskIds.add(t.taskId);
      const what = t.status === 'done' ? '已完成' : t.status === 'failed' ? '失败' : '已结束';
      showToast(
        `后台子任务 ${t.taskId} ${what}` +
          `${t.elapsedMs ? `（${Math.round(t.elapsedMs / 1000)}s` : ''}` +
          `${t.elapsedMs ? ` · ${t.iterations ?? 0} 轮）` : ''}`,
        t.status === 'failed' ? 'error' : 'success',
      );
    }
  }
  subTasks.set(id, items);
  return {
    running: items.some((t) => t.status === 'running'),
    runStatus: r.run?.status ?? null,
  };
}

/** 时间线里是否还有 running 的结果卡片（G2 条件②：刷新页面后据此恢复轮询） */
function hasRunningSubCard(st: SessionStreamState): boolean {
  for (const m of st.messages) {
    if (m.subResult?.status === 'running') return true;
  }
  return false;
}

/** 轨迹同步节流：与后端运行卡片的落盘节奏（8s）对齐 */
const SUB_TRACE_SYNC_MS = 8000;
const lastTraceSync = new Map<string, number>();

/** 轨迹是否有变化（取规模指纹，避免整段深比较） */
function traceChanged(prev: SubAgentTraceVM | undefined, next: SubAgentTraceVM): boolean {
  if (!prev) return true;
  return (
    prev.iterations !== next.iterations ||
    prev.think.length !== next.think.length ||
    prev.tools.length !== next.tools.length
  );
}

/**
 * 运行中后台卡片的过程轨迹同步（问题修复：过程区一直显示「暂无过程事件」）。
 *
 * 主 run 结束后本端没有 SSE，后端虽每 8s 把 trace 写盘，却推不到这里；
 * 快照端点又不带 trace（一条 86 轮轨迹 ≈200KB，2s 轮询传不起）。
 * 因此这里只在**时间线里存在运行中卡片**时每 8s 重拉一次历史，
 * 并**只就地替换 subResult.trace**——不重建时间线，避免 resync 重挂组件导致
 * 用户展开的卡片 / 过程区被折叠回去。
 */
async function syncRunningCardTraces(id: string): Promise<void> {
  const st = states.get(id);
  if (!st || st.reloading) return;
  let detail: SessionDetail;
  try {
    detail = await api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
  } catch {
    return; // 展示态数据：失败静默，下一轮 tick 再试
  }
  const fresh = new Map<string, SubAgentTraceVM>();
  for (const m of detail.messages) {
    // 需求 20261108-003：kind 兜底内容特征（与时间线重建入口同判据）
    if (m.role !== 'user' || (m.kind !== 'subagent_result' && !isSubAgentResultContent(m.content))) continue;
    const card = parseSubAgentResultCard(m.show_content || m.content || '', m.sub);
    if (card?.status === 'running' && card.trace) fresh.set(card.taskId, card.trace);
  }
  if (!fresh.size) return;
  for (const msg of st.messages) {
    const sr = msg.subResult;
    if (!sr || sr.status !== 'running') continue;
    const t = fresh.get(sr.taskId);
    if (!t || !traceChanged(sr.trace, t)) continue;
    sr.trace = t;
    sr.iterations = t.iterations;
  }
}

const subPolls = new Map<string, ReturnType<typeof setInterval>>();
/** 进行中的 tick（防 setInterval 与立即 tick 叠加发重复请求） */
const subTicking = new Set<string>();
const SUB_POLL_MS = 2000;
/**
 * 后台任务全部收敛后的「唤醒观察期」（tick 数）：服务端在完成回调里可能启动唤醒轮次，
 * 本端没有 run-started 广播（同一标签页），需要多观察几轮才能接上新 run。
 */
const SUB_IDLE_GRACE_TICKS = 5;
const subIdleTicks = new Map<string, number>();

/**
 * 接管服务端自行启动的 run（需求 20261107-011 情况2：后台子任务完成触发唤醒）。
 *
 * 同一标签页收不到「别的端发起 run」的信令，因此只能靠 /subagents 轮询里的 run 状态发现。
 * 新 run 的 seq 从 0 重新计数，接管前必须重置 lastSeq，否则 attach 会按旧 cursor 跳过开头事件。
 */
function attachServerRun(id: string): void {
  const st = states.get(id);
  if (!st || st.status === 'running') return;
  st.status = 'running';
  st.lastSeq = 0;
  st.runId = undefined;
  st.runStartedAt = Date.now();
  st.note = undefined;
  void attach(id);
}

/**
 * 启动（或复用）轮询，并立即查一次。
 * 启动条件已放宽（G2）：SSE start 事件、会话加载/重连、历史残留 running 卡片都可调用。
 */
function ensureSubAgentPoll(id: string): void {
  if (!subPolls.has(id)) {
    subPolls.set(
      id,
      setInterval(() => void tickSubAgents(id), SUB_POLL_MS),
    );
  }
  void tickSubAgents(id);
}

/** 一轮轮询：刷新快照；全部收敛后停表并以落盘历史为准重建时间线 */
async function tickSubAgents(id: string): Promise<void> {
  if (subTicking.has(id)) return;
  subTicking.add(id);
  try {
    let snap: { running: boolean; runStatus: string | null };
    try {
      snap = await refreshSubAgents(id);
    } catch {
      stopSubAgentPoll(id); // 会话已删除 / 鉴权失败：不再重试
      return;
    }
    if (snap.running) {
      subIdleTicks.delete(id);
      // 运行中：按落盘节奏同步过程轨迹，避免过程区停在首帧（「1 轮 · 0 步」/「暂无过程事件」）
      const st = states.get(id);
      if (
        st &&
        hasRunningSubCard(st) &&
        Date.now() - (lastTraceSync.get(id) ?? 0) >= SUB_TRACE_SYNC_MS
      ) {
        lastTraceSync.set(id, Date.now());
        void syncRunningCardTraces(id);
      }
      return;
    }
    const idle = subIdleTicks.get(id) ?? 0;
    // 本端 run 进行中不能重建：此刻磁盘快照还没写入刚发出的用户消息，整表替换会把它
    // 「吞掉」，要等首次快照（约 10~30s）落盘才重新出现。进行中由 SSE 与收尾 reconcile 负责对齐。
    const localRunning = states.get(id)?.status === 'running';
    if (idle === 0 && !localRunning) await resync(id); // 首次收敛：卡片终态与落盘历史对齐
    if (snap.runStatus === 'running') {
      const st = states.get(id);
      if (st?.status === 'running') {
        // 本端已接住当前 run：保持观察——它收尾后可能紧接一个唤醒轮次（情况2）
        subIdleTicks.set(id, 0);
        return;
      }
      // 服务端自行启动了新一轮（后台完成 → 唤醒）：接管 run，轮询使命完成（后续靠 SSE 续传）
      attachServerRun(id);
      stopSubAgentPoll(id);
      subIdleTicks.delete(id);
      return;
    }
    if (idle >= SUB_IDLE_GRACE_TICKS) {
      // 观察期结束：兜底再对齐一次（唤醒轮可能已在两次轮询之间跑完并落盘）。
      // 本端 run 仍在进行时跳过——磁盘还没有刚发的用户消息，重建会让气泡消失一段；
      // 收尾的 reconcile 会以落盘结果为准做最终对齐。
      stopSubAgentPoll(id);
      subIdleTicks.delete(id);
      if (states.get(id)?.status !== 'running') await resync(id);
      return;
    }
    subIdleTicks.set(id, idle + 1);
  } finally {
    subTicking.delete(id);
  }
}

function stopSubAgentPoll(id: string): void {
  const timer = subPolls.get(id);
  if (timer) clearInterval(timer);
  subPolls.delete(id);
  lastTraceSync.delete(id);
  subIdleTicks.delete(id);
}

/**
 * 会话加载 / SSE 重连后的补偿（G2 条件③、G5）。
 *
 * 前端 SSE 是 fetch 流（不是 EventSource），没有 onopen 钩子，因此把补偿点放在
 * 「历史加载完成」与「attach/reconcile 结束」——二者都意味着与后端的连接刚建立或刚恢复。
 */
async function bootstrapSubAgents(id: string): Promise<void> {
  const st = states.get(id);
  if (!st) return;
  try {
    const { running } = await refreshSubAgents(id);
    if (running) {
      ensureSubAgentPoll(id);
      return;
    }
  } catch {
    // 快照是展示态数据，失败不打断会话加载
  }
  // 后端 registry 已无运行中任务，但时间线里残留 running 卡片（进程重启前的历史）：
  // 仍启动一次轮询，让 tick 走「收敛 → resync」把卡片刷成真终态
  if (hasRunningSubCard(st)) ensureSubAgentPoll(id);
}

/** 缓冲溢出（reset）后重建历史：期间新事件入 pending，重建完再按序应用 */
async function resync(id: string): Promise<void> {
  const st = states.get(id);
  if (!st) return;
  // G3：reloading 期间的重建请求不丢弃，记标记待当前重建完成后补执行一次。
  // 原实现直接 return，两个后台任务先后完成时第二次完成通知会被吞（task-006 §2.2 B3）。
  if (st.reloading) {
    st.pendingResync = true;
    return;
  }
  st.reloading = true;
  try {
    const r = await api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
    const disk = rebuildChatMsgs(r.messages);
    // 运行中：磁盘快照可能还没写入刚发的用户消息，先接回本地乐观尾部再整表替换
    if (st.status === 'running') preserveOptimisticTail(disk, st.messages);
    st.messages.splice(0, st.messages.length, ...disk);
    // 保留仍在运行中的助手占位（历史快照可能落后于已收到的实时事件）
    if (st.status === 'running') currentAssistant(st);
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(`会话历史重建失败：${errText(e)}`, 'error');
  } finally {
    st.reloading = false;
    const pend = st.pending;
    st.pending = [];
    for (const ev of pend) applyEvent(id, ev);
    if (st.pendingResync) {
      st.pendingResync = false;
      void resync(id); // 补执行被合并掉的那次重建
    }
  }
}

/**
 * 会话历史被服务端改写（手动压缩 / 重试截断）后重建本地时间线（需求 20261106-005）。
 */
export async function reloadHistory(id: string): Promise<void> {
  await resync(id);
}

/* ================= 完成后与磁盘对齐 ================= */

function segmentKey(s: Segment): string {
  return s.type === 'text' ? `t:${s.text}` : `o:${s.tool}\u0001${s.args}\u0001${s.result}`;
}

/** 仅比较角色与可见内容（fatal/meta 等纯前端标注不参与） */
function sameTimeline(a: ChatMsg[], b: ChatMsg[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].role !== b[i].role) return false;
    if (a[i].segments.map(segmentKey).join('\u0002') !== b[i].segments.map(segmentKey).join('\u0002')) {
      return false;
    }
  }
  return true;
}

/**
 * 运行中的本轮：磁盘快照可能还没写入刚发出的用户消息（服务端首次快照约 10~30s 一次），
 * 此时整表替换会把用户气泡「吞掉」，直到落盘才重新出现。这里把本地「磁盘还没有的尾部」
 * （用户气泡 + 助手占位/已收片段）原样接回重建结果。
 */
function preserveOptimisticTail(disk: ChatMsg[], local: ChatMsg[]): void {
  // 摘要卡片与子任务结果卡片不是用户输入，不能参与「本地比磁盘多几条」的判断
  const countUser = (list: ChatMsg[]): number =>
    list.filter((m) => m.role === 'user' && !m.subResult && !m.summary).length;
  const diskUsers = countUser(disk);
  if (countUser(local) <= diskUsers) return;
  let seen = 0;
  for (let i = 0; i < local.length; i++) {
    const m = local[i];
    if (m.role === 'user' && !m.subResult && !m.summary && ++seen > diskUsers) {
      disk.push(...local.slice(i));
      return;
    }
  }
}

/** 磁盘 user 消息的 content 含附件 note / 记忆前缀：展示层沿用本地乐观气泡的原文与附件 */
function keepLocalUserBubbles(disk: ChatMsg[], local: ChatMsg[]): void {
  const users = local.filter((m) => m.role === 'user' && !m.summary);
  let i = 0;
  for (const m of disk) {
    // 结果卡片 / 摘要卡片是系统风格卡片，不参与用户气泡对齐（否则后续气泡会错位）
    if (m.role !== 'user' || m.subResult || m.summary) continue;
    const l = users[i++];
    if (!l) break;
    const seg = l.segments[0];
    if (seg && seg.type === 'text') m.segments = [{ type: 'text', text: seg.text }];
    if (l.files) m.files = l.files;
  }
}

/**
 * 把消息内**未完成**的工具段标为已中断（Task-20261024-001 D3）。
 * 用户停止后这些工具不会再收到 tool_end，卡片须显示「已中断」而非一直转圈；
 * 已完成的段不受影响，保留其真实结果与耗时。
 */
function markToolSegsAborted(m: ChatMsg): void {
  for (const s of m.segments) {
    if (s.type === 'tool' && !s.done) s.aborted = true;
  }
}

/**
 * done 后静默重拉一次历史，以落盘结果为准（P1）。
 * 期间若已开始新一轮或又收到新事件则放弃；内容一致不替换，避免界面闪烁。
 * markAborted：本次为「已停止」收尾——磁盘重建的消息无中断标记（D4 不落盘），
 * 替换时间线后需回填灰条、「已停止 ·」标注与工具段的「已中断」态，否则刚出现的灰条立即消失。
 */
async function reconcile(id: string, markAborted = false): Promise<void> {
  const st = states.get(id);
  if (!st) return;
  const seqAt = st.lastSeq;
  try {
    const r = await api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
    if (st.status === 'running' || st.lastSeq !== seqAt) return;
    const disk = rebuildChatMsgs(r.messages);
    keepLocalUserBubbles(disk, st.messages);
    if (sameTimeline(disk, st.messages)) {
      // 内容一致时保留本地时间线，但补写 seq（重试锚点依赖下标，需求 20261106-005 D12）
      for (let i = 0; i < st.messages.length && i < disk.length; i++) {
        st.messages[i].seq = disk[i].seq;
      }
      void refreshContext(id);
      void bootstrapSubAgents(id); // G5：主 run 收尾后补查一次后台任务状态
      return;
    }
    const prevAsst = markAborted ? st.messages[st.messages.length - 1] : undefined;
    st.messages.splice(0, st.messages.length, ...disk);
    if (markAborted && prevAsst?.aborted === true) {
      const last = st.messages[st.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.aborted = true;
        last.meta = prevAsst.meta;
        markToolSegsAborted(last);
      }
    }
    // 内容被磁盘结果替换：通知视图重做高亮/mermaid 与滚动
    for (const cb of finishHandlers) cb(id);
    void refreshContext(id);
    void bootstrapSubAgents(id); // G5：与后端刚完成一次对齐，顺带补查后台任务状态
  } catch {
    // 静默：对齐失败时保留流式结果
  }
}

/** SSE 事件入口：维护 seq、缓冲与 reset */
function onEvent(id: string, ev: SseEvent): void {
  const st = states.get(id);
  if (!st) return;
  if (ev.id !== undefined) st.lastSeq = Math.max(st.lastSeq, ev.id);
  if (ev.event === 'reset') {
    void resync(id);
    return;
  }
  if (st.reloading) {
    st.pending.push(ev);
    return;
  }
  applyEvent(id, ev);
}

/* ================= 运行控制 ================= */

export interface SendOptions {
  /** 实际发送文本（含 📎 contextNote 前缀） */
  message: string;
  /** 气泡展示文本（用户输入原文） */
  text: string;
  files: string[];
  stream: boolean;
  /**
   * 会话级模型覆盖（task-20261025-002 D4）：别名或空串。
   * 空串/未传 = 不覆盖，服务端按全局激活模型处理。
   */
  modelAlias?: string;
}
export type SendOutcome = 'done' | 'aborted' | 'failed' | 'detached';

/**
 * 发送消息并驱动当前会话时间线。
 * 失败（未收到任何事件）时回滚乐观消息并返回 failed，由调用方恢复输入框；
 * 中途断线（已收到事件）返回 detached，保留内容并自动 attach 续传。
 */
export async function sendMessage(id: string, opts: SendOptions): Promise<SendOutcome> {
  return runTurn(id, opts, {
    path: `/sessions/${encodeURIComponent(id)}/messages`,
    body: { message: opts.message, stream: opts.stream, modelAlias: opts.modelAlias },
  });
}

export interface RetryOptions {
  /** 目标助手回答在恢复视图中的下标（ChatMsg.seq） */
  seq: number;
  modelAlias?: string;
}

/**
 * 替换式重试（需求 20261106-005 D2/D13/3.7）：
 * 先用 seq 定位目标回答，向本地时间线截断该轮（含用户气泡），再以 SSE 让服务端重新生成。
 * 服务端在建立流之前已完成存储截断；本端失败时回拉历史避免「本地已删、磁盘还在」。
 */
export async function retryMessage(id: string, opts: RetryOptions): Promise<SendOutcome> {
  const st = stateOf(id);
  const idx = st.messages.findIndex((m) => m.role === 'assistant' && m.seq === opts.seq);
  if (idx < 0) {
    showToast('目标回答已变化，请刷新会话后重试', 'error');
    return 'failed';
  }
  let userIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    // 摘要卡片也用 role=user 承载，但不是用户输入，不能作为重试锚点
    if (st.messages[i].role === 'user' && !st.messages[i].summary) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) {
    showToast('未找到该轮的用户消息，无法重试', 'error');
    return 'failed';
  }
  const userMsg = st.messages[userIdx];
  const text = userMsg.segments
    .filter((s): s is TextSeg => s.type === 'text')
    .map((s) => s.text)
    .join('');
  const files = userMsg.files ?? [];
  // 截断该轮及之后（含用户气泡），随后由 runTurn 重新压入用户气泡与助手占位
  st.messages.splice(userIdx);
  const outcome = await runTurn(
    id,
    { message: text, text, files, stream: true, modelAlias: opts.modelAlias },
    {
      path: `/sessions/${encodeURIComponent(id)}/retry`,
      body: { seq: opts.seq, modelAlias: opts.modelAlias },
      retry: true,
    },
  );
  return outcome;
}

/** 时间线驱动的公共实现：sendMessage / retryMessage 共用（端点与请求体由调用方给出） */
async function runTurn(
  id: string,
  opts: SendOptions,
  req: { path: string; body: Record<string, unknown>; retry?: boolean },
): Promise<SendOutcome> {
  const st = stateOf(id);
  const baseLen = st.messages.length;
  const userMsg: ChatMsg = {
    id: nextMsgId(),
    role: 'user',
    segments: [{ type: 'text', text: opts.text }],
    files: opts.files.length > 0 ? opts.files : undefined,
  };
  const asst = reactive<ChatMsg>({
    id: nextMsgId(),
    role: 'assistant',
    segments: [],
    streaming: true,
    // 非流式模式没有 SSE 事件驱动状态行，先置“思考中”，响应回来后清空
    live: { kind: 'thinking', since: Date.now() },
    lastEventAt: Date.now(),
  });
  st.messages.push(userMsg, asst);
  st.loaded = true;
  st.status = 'running';
  st.unread = false;
  st.lastSeq = 0;
  st.pending = [];
  const ctrl = new AbortController();
  st.controller = ctrl;
  notifyActivity(id);
  st.note = undefined; // 新一轮 run 开始：清掉上次的中断/停止注记（task-06）
  st.runStartedAt = Date.now(); // 本轮起始时间（finishRun 计算耗时、通知展示用）
  // 跨标签页广播（Task-20261021-002-07）：他页唤醒为 running 并 attach 续传
  postTab({ t: 'run-started', id });

  try {
    if (opts.stream) {
      await sseFetch(req.path, req.body, (ev) => onEvent(id, ev), ctrl.signal);
      asst.streaming = false;
      asst.live = null;
      return 'done';
    }
    const r = await api<{
      answer: string;
      iterations: number;
      durationMs: number;
      warnings?: string[];
      aborted?: boolean; // 用户取消（task-03 D7：非流式 200 + {aborted:true,partial:true}）
    }>(req.path, {
      method: 'POST',
      json: { ...req.body, stream: false },
    });
    // 非流式被用户取消（task-03 D7：200 + {aborted:true}）：部分输出已落盘但响应无增量可渲染，
    // 回滚乐观气泡避免「空泡」困惑（方案 D6），下次进入会话由历史渲染呈现
    if (r.aborted === true) {
      st.messages.splice(baseLen);
      st.status = 'idle';
      showToast('已停止（未产生输出）', 'error');
      return 'aborted';
    }
    asst.segments = [{ type: 'text', text: r.answer }];
    asst.live = null;
    asst.streaming = false;
    asst.meta = `${(r.durationMs / 1000).toFixed(1)}s · ${r.iterations} 轮`;
    // 非流式成功也走统一收尾（Task-20261021-002-07）：此前漏调 finishRun，
    // 状态滞留 running（侧栏运行点不灭）且绕过未读/通知/广播漏斗
    finishRun(id, st);
    for (const w of r.warnings ?? []) showToast(w, 'error');
    return 'done';
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      // 本端读流被 abort（停止请求失败降级 / 组件级中断）：保留已收内容。
      // 注意常规「■ 停止」走 abortRun()（服务端真取消），不会进入此分支
      asst.streaming = false;
      asst.live = null;
      asst.aborted = true; // 语义上这轮已被停止（灰条）；若服务端稍后仍跑完，reconcile 以磁盘为准
      markToolSegsAborted(asst);
      st.status = 'idle';
      showToast('已断开连接，本轮已停止显示', 'error');
      return 'aborted';
    }
    if (st.lastSeq > 0) {
      // 已收到事件后断线：run 仍在服务端继续，保留内容并续传（cursor=lastSeq）
      asst.streaming = true;
      showToast('连接中断，正在重连恢复…', 'error');
      void attach(id);
      return 'detached';
    }
    // 请求未成功：乐观消息回滚
    st.messages.splice(baseLen);
    st.status = 'idle';
    if (!(e instanceof AuthError)) {
      const msg = (e as { code?: string }).code === 'busy' ? '正在处理上一条消息，请稍后再试' : errText(e);
      showToast(msg, 'error');
    }
    // 重试在发起前已截断本地时间线：请求被拒（400/409）时回拉磁盘，避免本地与存储不一致
    if (req.retry) void resync(id);
    return 'failed';
  } finally {
    if (st.controller === ctrl) st.controller = null;
    if (st.status !== 'running') asst.live = null; // 兜底：终止路径不残留状态行
    notifyActivity(id);
  }
}

/** 本地断流兜底（Task-20261021-002-04）：常规「■ 停止」走 abortRun()（服务端真取消）；
 * 仅当停止请求网络失败时降级调用——中断本端 POST/attach 读流，保留已收内容与服务端 run */
export function stop(id: string): void {
  const st = states.get(id);
  if (!st) return;
  st.controller?.abort();
  st.attachCtrl?.abort();
  // 本地封口（Task-20261021-002-04）：中断本端读流时保留已生成内容并清状态行，
  // 避免流式光标/状态行随流关闭而残留
  const last = st.messages[st.messages.length - 1];
  if (last && last.role === 'assistant') {
    last.streaming = false;
    last.live = null;
  }
}

/** abortRun 结果：aborting=已受理取消；none=当前无运行中任务（204）；error=请求失败（已降级本地断流） */
export type AbortOutcome = 'aborting' | 'none' | 'error';

/** 请求服务端取消当前 run（Task-20261021-002-04）：终态由 SSE aborted 事件驱动 */
export async function abortRun(id: string): Promise<AbortOutcome> {
  try {
    const status = await apiStatus(`/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    return status === 204 ? 'none' : 'aborting';
  } catch (e) {
    // 降级为本地 detach（方案 D1）：服务端可能照常跑完，用户至少眼不见、页面不卡死
    if (!(e instanceof AuthError)) {
      stop(id);
      return 'error';
    }
    return 'error';
  }
}

/** attach 断线重连的退避间隔（1s、2s） */
const ATTACH_RETRY_DELAYS_MS = [1000, 2000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 停止查看后的本地收尾：保留已收内容，状态行消失 */
function detachLocally(st: SessionStreamState): void {
  if (st.status === 'running') st.status = 'idle';
  const last = st.messages[st.messages.length - 1];
  if (last && last.role === 'assistant') {
    last.streaming = false;
    last.live = null;
  }
}

/**
 * 接管一个运行中的 run：GET /sessions/:id/stream?cursor=lastSeq。
 * 204 表示无运行（已结束），直接返回；网络异常时按 1s/2s 退避重连（run 未结束才重试）。
 */
export async function attach(id: string): Promise<void> {
  const st = states.get(id);
  if (!st || st.attaching) return;
  st.attaching = true;
  const ctrl = new AbortController();
  st.attachCtrl = ctrl;
  let attempt = 0;
  try {
    for (;;) {
      try {
        const r = await sseGet(
          `/sessions/${encodeURIComponent(id)}/stream?cursor=${st.lastSeq}`,
          (ev) => onEvent(id, ev),
          ctrl.signal,
        );
        if (r.status === 204 && st.status === 'running') {
          // run 已在两次请求之间结束：按空闲处理，移除可能残留的空助手占位；
          // 再对齐一次落盘历史，拿回「刚结束但没来得及收 done」的回答（含后台唤醒轮次）
          const last = st.messages[st.messages.length - 1];
          if (last && last.role === 'assistant' && last.segments.length === 0) st.messages.pop();
          st.status = 'idle';
          void reconcile(id);
        }
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          // 用户停止查看（attach 流中断）：保留已收内容
          detachLocally(st);
          return;
        }
        if (e instanceof AuthError) return;
        // 网络抖动 / 代理超时：run 仍在跑则从已收 seq 继续重连
        if (st.status === 'running' && attempt < ATTACH_RETRY_DELAYS_MS.length) {
          await sleep(ATTACH_RETRY_DELAYS_MS[attempt++], ctrl.signal);
          continue;
        }
        showToast(`连接会话流失败：${errText(e)}`, 'error');
        return;
      }
    }
  } catch (e) {
    // 退避等待期间被 abort
    if ((e as Error).name === 'AbortError') detachLocally(st);
    else if (!(e instanceof AuthError)) showToast(`连接会话流失败：${errText(e)}`, 'error');
  } finally {
    if (st.attachCtrl === ctrl) st.attachCtrl = null;
    st.attaching = false;
  }
}
