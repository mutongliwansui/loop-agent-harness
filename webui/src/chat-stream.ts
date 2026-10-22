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
import { api, apiStatus, AuthError } from './api/client.js';
import { sseFetch, sseGet, type SseEvent } from './api/sse.js';
import { showToast } from './toast.js';
import { postTab } from './tab-sync.js';
import { getNotifySettings, notifyRunDone, playChime } from './notify.js';

export interface TextSeg {
  type: 'text';
  text: string;
}
export interface ToolSeg {
  type: 'tool';
  tool: string;
  args: string;
  result: string;
  done: boolean;
  /** 执行耗时：tool_end 时按本地时间计算；历史消息无此值 */
  elapsedMs?: number;
  /** 执行开始时间戳（仅流式期间用于算耗时，不渲染） */
  startedAt?: number;
}
/** 时间线分段：思考/最终答案文本段与工具段按事件到达顺序交错 */
export type Segment = TextSeg | ToolSeg;
/** 流式实时阶段（文案与 CLI spinner 对齐；仅内存态，不随历史消息持久化） */
export type LivePhase =
  | { kind: 'thinking'; iteration?: number; since: number }
  | { kind: 'arg_gen'; tool: string; bytes: number; since: number }
  | { kind: 'tool_run'; tool: string; elapsedMs: number; since: number };
/** GET /sessions/:id 的历史消息（OpenAI 消息序：含带 tool_calls 的 assistant 与带 tool_call_id 的 tool） */
export interface ApiHistoryMsg {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** 是否在会话界面展示（system 与压缩总结消息为 false；缺省视为展示） */
  is_show?: boolean;
  /** 展示内容；缺省或为空时取 content（content 为 LLM 可见原文，可能含记忆注入前缀） */
  show_content?: string;
}
export interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  segments: Segment[]; // 按序渲染形成 思考→命令→思考→命令→总结 的完整过程
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
  /** 首次加载去重（并发 ensureLoaded 共享同一请求） */
  loadTask: Promise<{ switched: boolean; workspacePath?: string }> | null;
  /**
   * 时间线尾注记（task-06，前端态不进消息数组）：
   * lastRun=interrupted → 「⚠ 上次运行被中断（服务已重启）…」；lastRun=aborted → 「上次运行由用户停止」
   */
  note?: string;
  /** 本轮 run 起始时间戳（task-07：finishRun 计算耗时供通知/广播展示；无记录为 undefined） */
  runStartedAt?: number;
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
  const toolSegById = new Map<string, ToolSeg>();
  const flush = (): void => {
    if (pending.length > 0) out.push({ id: nextMsgId(), role: 'assistant', segments: pending });
    pending = [];
  };
  for (const m of list) {
    // 不展示的消息：system 与压缩总结消息（is_show=false）
    if (m.is_show === false) continue;
    if (m.role === 'user') {
      flush();
      // content 为 LLM 可见原文（可能含记忆注入前缀），展示优先用 show_content 还原
      const text = m.show_content || m.content || '';
      out.push({ id: nextMsgId(), role: 'user', segments: [{ type: 'text', text }] });
    } else if (m.role === 'assistant') {
      if (m.content) pending.push({ type: 'text', text: m.content });
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
      if (seg) seg.result = m.content ?? '';
    }
  }
  flush();
  return out;
}

interface SessionDetail {
  messages: ApiHistoryMsg[];
  /** task-05 L2 兼容：switched 字段后端仍返回（恒 false），前端调用方已不再分支 */
  workspace?: { path: string; id: string; switched: boolean };
  run?: { runId: string; status: 'running' | 'done' | 'failed' | 'aborted' } | null;
  /** run journal 磁盘态（task-06）：服务重启后 run=null，lastRun 仍可判中断/停止 */
  lastRun?: { status: string; finishedAt?: number } | null;
}

async function fetchDetail(id: string, st: SessionStreamState): Promise<{ switched: boolean; workspacePath?: string }> {
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
  // 刷新后灰条恢复（6.2.2）：历史消息不含中断标记（task-03 D4 中断标记不落盘），
  // 但 run 终态在服务端有 60s 保留期——刚停止后刷新页面时 run.status 仍为 'aborted'，
  // 末尾助手消息即为被停止的那轮部分输出，补标灰条与「已停止 ·」标注。
  // 超过保留期后快照为 null，此时界面仅剩标注文字，灰条自然消失（可接受降级）。
  if (r.run?.status === 'aborted' && msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'assistant') {
      last.aborted = true;
      last.meta = last.meta ? `已停止 · ${last.meta}` : '已停止';
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
  return { switched: r.workspace?.switched === true, workspacePath: r.workspace?.path };
}

/** 首次进入会话时加载历史（已加载直接返回）；加载中共享同一请求 */
export function ensureLoaded(id: string): Promise<{ switched: boolean; workspacePath?: string }> {
  const st = stateOf(id);
  if (st.loaded) return Promise.resolve({ switched: false });
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
      // 执行期每秒心跳：以服务端 elapsedMs 为准，LiveStatus 内再用本地时钟兜底
      asst.live = {
        kind: 'tool_run',
        tool: String(d.tool ?? ''),
        elapsedMs: Number(d.elapsedMs ?? 0),
        since: now - Number(d.elapsedMs ?? 0),
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
      const info = (d.info ?? {}) as { failed?: boolean; fallback?: string };
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
      finishRun(id, st, 'aborted');
      void reconcile(id, true);
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

/** 缓冲溢出（reset）后重建历史：期间新事件入 pending，重建完再按序应用 */
async function resync(id: string): Promise<void> {
  const st = states.get(id);
  if (!st || st.reloading) return;
  st.reloading = true;
  try {
    const r = await api<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);
    st.messages.splice(0, st.messages.length, ...rebuildChatMsgs(r.messages));
    // 保留仍在运行中的助手占位（历史快照可能落后于已收到的实时事件）
    if (st.status === 'running') currentAssistant(st);
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(`会话历史重建失败：${errText(e)}`, 'error');
  } finally {
    st.reloading = false;
    const pend = st.pending;
    st.pending = [];
    for (const ev of pend) applyEvent(id, ev);
  }
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

/** 磁盘 user 消息的 content 含附件 note / 记忆前缀：展示层沿用本地乐观气泡的原文与附件 */
function keepLocalUserBubbles(disk: ChatMsg[], local: ChatMsg[]): void {
  const users = local.filter((m) => m.role === 'user');
  let i = 0;
  for (const m of disk) {
    if (m.role !== 'user') continue;
    const l = users[i++];
    if (!l) break;
    const seg = l.segments[0];
    if (seg && seg.type === 'text') m.segments = [{ type: 'text', text: seg.text }];
    if (l.files) m.files = l.files;
  }
}

/**
 * done 后静默重拉一次历史，以落盘结果为准（P1）。
 * 期间若已开始新一轮或又收到新事件则放弃；内容一致不替换，避免界面闪烁。
 * markAborted：本次为「已停止」收尾——磁盘重建的消息无中断标记（D4 不落盘），
 * 替换时间线后需回填灰条与「已停止 ·」标注，否则刚出现的灰条立即消失。
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
    if (sameTimeline(disk, st.messages)) return;
    const prevAsst = markAborted ? st.messages[st.messages.length - 1] : undefined;
    st.messages.splice(0, st.messages.length, ...disk);
    if (markAborted && prevAsst?.aborted === true) {
      const last = st.messages[st.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.aborted = true;
        last.meta = prevAsst.meta;
      }
    }
    // 内容被磁盘结果替换：通知视图重做高亮/mermaid 与滚动
    for (const cb of finishHandlers) cb(id);
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
}
export type SendOutcome = 'done' | 'aborted' | 'failed' | 'detached';

/**
 * 发送消息并驱动当前会话时间线。
 * 失败（未收到任何事件）时回滚乐观消息并返回 failed，由调用方恢复输入框；
 * 中途断线（已收到事件）返回 detached，保留内容并自动 attach 续传。
 */
export async function sendMessage(id: string, opts: SendOptions): Promise<SendOutcome> {
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
      await sseFetch(
        `/sessions/${encodeURIComponent(id)}/messages`,
        { message: opts.message, stream: true },
        (ev) => onEvent(id, ev),
        ctrl.signal,
      );
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
    }>(`/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      json: { message: opts.message, stream: false },
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
          // run 已在两次请求之间结束：按空闲处理，移除可能残留的空助手占位
          const last = st.messages[st.messages.length - 1];
          if (last && last.role === 'assistant' && last.segments.length === 0) st.messages.pop();
          st.status = 'idle';
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
