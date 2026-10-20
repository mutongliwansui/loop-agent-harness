<script setup lang="ts">
// ChatView：会话 CRUD + SSE 流式对话 + 停止生成 + 对话内上传（Task-20261017-001 D5/D7）
// 端点映射：
//   GET    /workspaces          → 左侧菜单会话列表（sessions.ts 共享 store；按工作空间分组聚合）
//   POST   /sessions            → 新建会话（body 可带 workspacePath 异空间切换；发送前无会话时也自动创建）
//   GET    /fs/dirs             → 服务端目录浏览（新建弹窗「浏览磁盘」；纯 Web 拿不到本地目录绝对路径）
//   GET    /sessions/:id        → 恢复历史消息（{meta, messages, workspace}；跨空间会话自动切换到其所在空间）
//   DELETE /sessions/:id        → 删除（二次确认；in-flight 409；支持跨工作空间会话）
//   POST   /sessions/:id/messages → 发消息（默认 SSE；stream:false 非流式 JSON；跨空间会话自动切换空间）
//   POST   /uploads/raw         → 📎 文件选择框上传 → chip（contextNote 随下一条消息注入）
//   DELETE /uploads             → 上传面板「清空全部」（二次确认）
// 停止生成：AbortController 中断 fetch（服务端照常完成并持久化，停止后刷新列表）
// mermaid：流式结束/历史加载后对 ```mermaid 代码块后处理渲染为 SVG（../mermaid.ts 共享模块，
//          FilesView md 预览同款；动态 import 独立 chunk，主题跟随 prefers-color-scheme；
//          解析失败保留代码块并标红；交互：工具栏 放大/缩小/适应宽度/全屏 + 滚轮缩放）

import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch, watchEffect } from 'vue';
import { api, AuthError, ApiError, uploadRaw } from '../api/client.js';
import { sseFetch, type SseEvent } from '../api/sse.js';
import { showToast } from '../toast.js';
import { renderMarkdown, highlightIn } from '../markdown.js';
import { renderMermaidIn } from '../mermaid.js';
import FilesView from './FilesView.vue';
import {
  workspaces,
  activeId,
  chatStreaming,
  foreignActive,
  currentWsPath,
  wsColor,
  loadSessions,
  registerChatBridge,
  consumePendingNewPop,
  consumePendingSelect,
  type SessionMeta,
} from '../sessions.js';
interface TextSeg {
  type: 'text';
  text: string;
}
interface ToolSeg {
  type: 'tool';
  tool: string;
  args: string;
  result: string;
  done: boolean;
}
/** 时间线分段：思考/最终答案文本段与工具段按事件到达顺序交错 */
type Segment = TextSeg | ToolSeg;
/** GET /sessions/:id 的历史消息（OpenAI 消息序：含带 tool_calls 的 assistant 与带 tool_call_id 的 tool） */
interface ApiHistoryMsg {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** 是否在会话界面展示（system 与压缩总结消息为 false；缺省视为展示） */
  is_show?: boolean;
  /** 展示内容；缺省或为空时取 content（content 为 LLM 可见原文，可能含记忆注入前缀） */
  show_content?: string;
}
interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  segments: Segment[]; // 按序渲染形成 思考→命令→思考→命令→总结 的完整过程
  files?: string[]; // 该消息附带的上传文件名（仅用户消息展示）
  streaming?: boolean;
  compacting?: boolean; // 压缩中 loading（compaction_start 置 true，compaction 结束事件置 false）
  failed?: boolean;
  failedText?: string; // fatal 终止原因
  meta?: string; // done 后的耗时/轮数标注
}
interface UploadChip {
  id: number;
  fileName: string;
  bytes: number;
  contextNote: string;
}

const messages = ref<ChatMsg[]>([]);
const draft = ref('');
const streaming = ref(false);
const streamChk = ref(true);
const uploads = ref<UploadChip[]>([]);
const upPopOpen = ref(false);
const upBusy = ref(false);
const upCleanArmed = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const msgsEl = ref<HTMLElement | null>(null);
// 新建会话弹窗（已知空间列表 + 服务端目录浏览器，原型-20261017-004）
const newPopOpen = ref(false);
const browseOpen = ref(false);
const newBusy = ref(false);
const dirPath = ref('');
const dirParent = ref<string | null>(null);
const dirEntries = ref<{ name: string }[]>([]);
const dirDrives = ref<string[]>([]);
const dirLoading = ref(false);
const dirError = ref('');
const dirJump = ref('');

// 会话标题徽标（chat-head）：从共享 store 取活跃会话元信息
const activeMeta = computed(() => {
  for (const w of workspaces.value) {
    const s = w.sessions.find((x) => x.id === activeId.value);
    if (s) return s;
  }
  return null;
});
const activeWs = computed(
  () => workspaces.value.find((w) => w.sessions.some((s) => s.id === activeId.value)) ?? null,
);
// 工作空间文件浏览器（原型-20261018-001）：右侧面板默认展开
const filesOpen = ref(true);

let msgSeq = 0;
let chipSeq = 0;
let abortCtrl: AbortController | null = null;
let composing = false; // 中文输入法组词中的 Enter 不发送
/** 模板经此函数改写 composing：vue-tsc 对模板内直接赋值顶层 let 存在字面量收窄误报（TS2322） */
function setComposing(v: boolean): void {
  composing = v;
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/* ================= 消息后处理：代码高亮 + mermaid ================= */
// 流式期间 segments 文本段逐 chunk 变化触发 v-html 重渲，不能边流边渲；
// 只在流式结束（send finally）或历史加载（selectSession）后统一后处理：
// 先 highlight.js 高亮代码块，再把 marked 输出的 <pre><code class="language-mermaid">
// 替换为 mermaid SVG。失败保留代码块。

async function postRenderMsgs(): Promise<void> {
  await nextTick();
  if (!msgsEl.value) return;
  highlightIn(msgsEl.value); // 高亮在 mermaid 前：mermaid 块被跳过
  await renderMermaidIn(msgsEl.value); // mermaid 图表后处理（../mermaid.ts 共享模块）
}

// mermaid 容器构建（缩放/平移/全屏）与渲染排队逻辑见 ../mermaid.ts，样式见 ../mermaid.css

function scrollBottom(): void {
  nextTick(() => {
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ================= 会话创建与切换（列表数据见 sessions.ts 共享 store） ================= */

/**
 * 创建会话；带 workspacePath 时可异空间切换（后端同空间自动识别为直建）。
 * 从弹窗发起（传参）时整体刷新列表——切换后「当前」标记随之移动、分组顺序不变。
 */
async function createSession(workspacePath?: string): Promise<string | null> {
  if (streaming.value) {
    showToast('正在生成回复，请先停止', 'error');
    return null;
  }
  const fromPop = workspacePath !== undefined;
  if (fromPop) newBusy.value = true;
  try {
    const r = await api<SessionMeta & { workspace?: { path: string; id: string; switched: boolean } }>(
      '/sessions',
      { method: 'POST', json: fromPop ? { workspacePath } : undefined },
    );
    const switched = r.workspace?.switched === true;
    await loadSessions();
    activeId.value = r.id;
    messages.value = [];
    scrollBottom();
    if (fromPop) {
      closeNewPop();
      showToast(switched ? `已切换工作空间：${r.workspace?.path}` : '会话已创建', 'success');
    }
    return r.id;
  } catch (e) {
    if (e instanceof AuthError) return null;
    const code = (e as { code?: string }).code;
    const msg = errText(e);
    // 目录类错误（404/403/409）在浏览器视图内以错误条展示，保持当前位置可修正
    if (browseOpen.value && (code === 'not_found' || code === 'forbidden' || code === 'busy')) {
      dirError.value = msg;
    } else {
      showToast(msg, 'error');
    }
    return null;
  } finally {
    newBusy.value = false;
  }
}

/* ================= 新建会话弹窗（已知空间 + 目录浏览器） ================= */

function openNewPop(): void {
  newPopOpen.value = true;
  browseOpen.value = false;
  dirError.value = '';
}

function closeNewPop(): void {
  newPopOpen.value = false;
  browseOpen.value = false;
  dirError.value = '';
  dirJump.value = '';
}

function openBrowse(): void {
  browseOpen.value = true;
  dirError.value = '';
  if (!dirPath.value) void browseDirs(''); // 缺省 → 服务端当前空间
}

/** GET /fs/dirs：失败（404/403 等）以错误条展示并保持当前位置 */
async function browseDirs(path: string): Promise<void> {
  dirLoading.value = true;
  dirError.value = '';
  try {
    const r = await api<{ path: string; parent: string | null; dirs: { name: string }[]; drives: string[] }>(
      `/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    );
    dirPath.value = r.path;
    dirParent.value = r.parent;
    dirEntries.value = r.dirs;
    dirDrives.value = r.drives;
  } catch (e) {
    if (!(e instanceof AuthError)) dirError.value = errText(e);
  } finally {
    dirLoading.value = false;
  }
}

function joinPath(base: string, name: string): string {
  return /[\\/]$/.test(base) ? base + name : `${base}\\${name}`;
}

function jumpTo(): void {
  const p = dirJump.value.trim();
  if (!p) return;
  dirJump.value = '';
  void browseDirs(p); // 归一化（'D:' → 'D:\'）由后端完成
}

/** 面包屑：'D:\a\b' → [D:\, a, b]，逐级可点 */
const dirCrumbs = computed(() => {
  const p = dirPath.value;
  const m = p.match(/^([A-Za-z]:\\)(.*)$/);
  if (!m) return [{ label: p, path: p }];
  const crumbs = [{ label: m[1], path: m[1] }];
  let acc = m[1];
  for (const seg of m[2].split('\\').filter(Boolean)) {
    acc += seg + '\\';
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
});

/** 当前浏览目录与已知空间的匹配：current=当前空间 known=已知（非当前）空间 fresh=未知目录 */
const dirTargetKind = computed(() => {
  const p = dirPath.value.toLowerCase();
  const cur = workspaces.value.find((w) => w.current);
  if (cur && cur.path.toLowerCase() === p) return 'current';
  return workspaces.value.some((w) => !w.current && w.path.toLowerCase() === p) ? 'known' : 'fresh';
});

const createInDirLabel = computed(() => {
  if (newBusy.value) return '创建中…';
  if (dirTargetKind.value === 'current') return '＋ 在此新建会话';
  if (dirTargetKind.value === 'known') {
    const w = workspaces.value.find((x) => !x.current && x.path.toLowerCase() === dirPath.value.toLowerCase());
    return `切换到 ${w?.name ?? '该空间'} 并新建会话`;
  }
  return '切换到此目录并新建会话';
});

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
    if (pending.length > 0) out.push({ id: ++msgSeq, role: 'assistant', segments: pending });
    pending = [];
  };
  for (const m of list) {
    // 不展示的消息：system 与压缩总结消息（is_show=false）
    if (m.is_show === false) continue;
    if (m.role === 'user') {
      flush();
      // content 为 LLM 可见原文（可能含记忆注入前缀），展示优先用 show_content 还原
      const text = m.show_content || m.content || '';
      out.push({ id: ++msgSeq, role: 'user', segments: [{ type: 'text', text }] });
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

async function selectSession(id: string): Promise<void> {
  if (streaming.value) {
    showToast('正在生成回复，请先停止', 'error');
    return;
  }
  // 同会话且消息已在场（含从管理页返回重挂载场景）不重复拉取；消息为空则视为需恢复
  if (id === activeId.value && messages.value.length > 0) return;
  try {
    const r = await api<{
      meta: SessionMeta;
      messages: ApiHistoryMsg[];
      workspace?: { path: string; id: string; switched: boolean };
    }>(`/sessions/${encodeURIComponent(id)}`);
    // 跨空间会话：后端已自动切换服务端工作空间——先刷新列表（「当前」标记移动、只读徽标消失，分组顺序不变）再恢复消息
    const switched = r.workspace?.switched === true;
    if (switched) await loadSessions();
    activeId.value = id;
    messages.value = rebuildChatMsgs(r.messages);
    scrollBottom();
    void postRenderMsgs();
    if (switched) showToast(`已切换工作空间：${r.workspace?.path}`, 'success');
  } catch (e) {
    if (e instanceof AuthError) return;
    // 会话不存在（落盘数据被清理等）：重置视图并刷新列表，让僵尸条目消失
    if (e instanceof ApiError && e.code === 'not_found') {
      showToast('会话不存在或已被删除，列表已刷新', 'error');
      activeId.value = '';
      messages.value = [];
      await loadSessions();
      return;
    }
    showToast(errText(e), 'error');
  }
}

/* ================= 消息发送与 SSE 渲染 ================= */

function handleEvent(ev: SseEvent, asst: ChatMsg): void {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.event) {
    case 'llm_stream': {
      // 思考/最终答案 delta：上一段是工具段时开新文本段，天然形成 思考→工具→思考 交错
      const last = asst.segments[asst.segments.length - 1];
      const seg = last && last.type === 'text' ? last : { type: 'text' as const, text: '' };
      if (seg !== last) asst.segments.push(seg);
      seg.text += String(d.text ?? '');
      scrollBottom();
      break;
    }
    case 'tool_start':
      asst.segments.push({
        type: 'tool',
        tool: String(d.tool ?? ''),
        args: JSON.stringify(d.args ?? null),
        result: '',
        done: false,
      });
      scrollBottom();
      break;
    case 'tool_end': {
      // 从尾部反查第一个未完成同名工具段回填结果
      for (let i = asst.segments.length - 1; i >= 0; i--) {
        const s = asst.segments[i];
        if (s.type === 'tool' && !s.done && s.tool === String(d.tool ?? '')) {
          s.result = typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? null);
          s.done = true;
          break;
        }
      }
      scrollBottom();
      break;
    }
    case 'compaction_start':
      // 压缩开始（flush 提取期间有一次额外 LLM 调用，主输出会暂停）：显示 loading
      asst.compacting = true;
      scrollBottom();
      break;
    case 'compaction': {
      // 压缩结束事件（成功/失败/异常兜底均会到达，与 compaction_start 配对）：移除 loading
      asst.compacting = false;
      const info = (d.info ?? {}) as { failed?: boolean; fallback?: string };
      if (info.failed) {
        showToast(
          info.fallback === 'archive'
            ? '压缩提取失败：已降级存档原始对话后压缩'
            : '压缩提取失败：已保留全部历史',
          'error',
        );
      }
      scrollBottom();
      break;
    }
    case 'final': {
      // 最终答案已随最后一轮 llm_stream 流入末尾文本段，覆盖会把前面各轮思考全部抹掉；
      // 仅在末尾没有文本段（异常路径）或其为空时兜底写入
      const answer = String(d.answer ?? '');
      const last = asst.segments[asst.segments.length - 1];
      if (!last || last.type !== 'text') asst.segments.push({ type: 'text', text: answer });
      else if (!last.text) last.text = answer;
      break;
    }
    case 'error':
      showToast(`模型错误: ${String(d.message ?? d.name ?? '')}`, 'error');
      break;
    case 'warning':
      showToast(String(d.message ?? ''), 'error');
      break;
    case 'fatal':
      asst.streaming = false;
      asst.failed = true;
      asst.failedText = String(d.message ?? '生成失败');
      scrollBottom();
      break;
    case 'done':
      asst.streaming = false;
      asst.meta = `${(Number(d.durationMs ?? 0) / 1000).toFixed(1)}s · ${String(d.iterations ?? '?')} 轮`;
      scrollBottom();
      break;
    default:
      break; // start/iteration_start/llm_end/end 等事件 P0 不展示
  }
}

async function ensureSession(): Promise<string | null> {
  return activeId.value ?? (await createSession());
}

async function send(): Promise<void> {
  if (foreignActive.value) {
    showToast('跨工作空间会话仅支持查看与删除，不支持继续对话', 'error');
    return;
  }
  const text = draft.value.trim();
  if (!text && uploads.value.length === 0) return;
  if (streaming.value) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;

  // contextNote 拼接进 message 文本（POST messages 无独立 contextNote 字段）
  const notes = uploads.value.map((u) => u.contextNote);
  const full = [...notes, text].filter(Boolean).join('\n\n');

  const chipsSnapshot = uploads.value;
  const draftSnapshot = draft.value;
  const baseLen = messages.value.length;

  const userMsg: ChatMsg = {
    id: ++msgSeq,
    role: 'user',
    segments: [{ type: 'text', text }],
    files: chipsSnapshot.map((u) => u.fileName),
  };
  // 必须 reactive：流式期间 handleEvent 持有此引用做 += 累加，若为普通对象，
  // 写入绕过响应式代理不触发渲染 → 表现为“全部生成完后才一次性出现”
  const asst = reactive<ChatMsg>({ id: ++msgSeq, role: 'assistant', segments: [], streaming: true });
  if (streamChk.value) messages.value.push(userMsg, asst);
  else messages.value.push(userMsg);

  uploads.value = [];
  draft.value = '';
  streaming.value = true;
  scrollBottom();

  abortCtrl = new AbortController();
  try {
    if (streamChk.value) {
      await sseFetch(
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        { message: full, stream: true },
        (ev) => handleEvent(ev, asst),
        abortCtrl.signal,
      );
      asst.streaming = false;
    } else {
      const r = await api<{
        answer: string;
        iterations: number;
        durationMs: number;
        warnings?: string[];
      }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        json: { message: full, stream: false },
      });
      asst.segments = [{ type: 'text', text: r.answer }];
      asst.streaming = false;
      asst.meta = `${(r.durationMs / 1000).toFixed(1)}s · ${r.iterations} 轮`;
      for (const w of r.warnings ?? []) showToast(w, 'error');
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      asst.streaming = false; // 用户主动停止：保留已收内容
      showToast('已停止生成（服务端将照常完成并保存）');
    } else {
      // 请求未成功：乐观消息回滚 + 恢复输入
      messages.value = messages.value.slice(0, baseLen);
      uploads.value = chipsSnapshot;
      draft.value = draftSnapshot;
      if (!(e instanceof AuthError)) {
        const msg = (e as { code?: string }).code === 'busy' ? '正在处理上一条消息，请稍后再试' : errText(e);
        showToast(msg, 'error');
      }
    }
  } finally {
    streaming.value = false;
    abortCtrl = null;
    scrollBottom();
    void postRenderMsgs(); // 流式/非流式/停止/失败统一在此做代码高亮 + mermaid
    void loadSessions(); // 刷新 messageCount / updatedAt
  }
}

function stopGen(): void {
  abortCtrl?.abort();
}

function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey || composing) return;
  e.preventDefault();
  void send();
}

/* ================= 对话内上传 ================= */

async function onPickFiles(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;
  upBusy.value = true;
  try {
    for (const f of files) {
      try {
        const r = await uploadRaw(f, sessionId);
        uploads.value.push({ id: ++chipSeq, fileName: r.fileName, bytes: r.bytes, contextNote: r.contextNote });
        showToast(`已上传 → ${r.fileName}（${fmtBytes(r.bytes)}）`, 'success');
      } catch (e) {
        if (e instanceof AuthError) break;
        showToast(`上传失败 ${f.name}: ${errText(e)}`, 'error');
      }
    }
  } finally {
    upBusy.value = false;
  }
}

function removeChip(u: UploadChip): void {
  uploads.value = uploads.value.filter((x) => x.id !== u.id);
  showToast('已从注入列表移除（服务器文件保留）');
}

function onCleanUploads(): void {
  if (!upCleanArmed.value) {
    upCleanArmed.value = true; // 动词即确认：二次点击
    setTimeout(() => {
      upCleanArmed.value = false;
    }, 2600);
    return;
  }
  upCleanArmed.value = false;
  void (async () => {
    try {
      await api('/uploads', { method: 'DELETE' });
      uploads.value = [];
      showToast('上传目录已清空', 'success');
    } catch (e) {
      if (!(e instanceof AuthError)) showToast(errText(e), 'error');
    }
  })();
}

// 与共享 store 双向联动：
//   写 —— streaming 状态同步给 App「新建对话」按钮禁用态
//   读 —— store 删除活跃会话后 activeId 置 null，这里清空消息区
watchEffect(() => {
  chatStreaming.value = streaming.value;
});
watch(activeId, (v) => {
  if (v === null) messages.value = [];
});

// Esc 关闭新建会话弹窗（window 级监听：焦点可能落在弹窗内输入框，元素级 @keydown 不可靠）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && newPopOpen.value) closeNewPop();
}

onMounted(() => {
  // 会话切换/新建弹窗依赖本组件的流式与消息状态，注册给 App 侧栏委托调用
  registerChatBridge({ select: (id) => void selectSession(id), openNewPop });
  window.addEventListener('keydown', onGlobalKeydown);
  void loadSessions();
  // 消费从其他管理页跳转过来的意图；无意图时若仍有活跃会话（从管理页返回）恢复其消息
  if (consumePendingNewPop()) openNewPop();
  const pend = consumePendingSelect();
  if (pend) void selectSession(pend);
  else if (activeId.value) void selectSession(activeId.value);
});

onUnmounted(() => {
  registerChatBridge(null);
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <div class="chat">
    <!-- 会话列表已并入左侧菜单（App.vue，原型-20261018-001） -->
    <!-- ===== 主区 ===== -->
    <div class="chat-main">
      <div class="chat-head">
        <b>{{ activeMeta?.title || (activeId ? '会话' : '开始新对话') }}</b>
        <span v-if="activeMeta" class="sid">#{{ activeMeta.id }}</span>
        <span v-if="activeWs" class="ws-badge" :title="activeWs.path">📁 {{ activeWs.name }}</span>
        <span v-if="foreignActive" class="ro-badge">只读</span>
        <span class="spacer"></span>
        <span class="muted-hint">{{ streamChk ? 'SSE 流式' : '非流式' }}</span>
        <button
          class="icon-toggle"
          :class="{ on: filesOpen }"
          :title="filesOpen ? '收起工作空间面板' : '展开工作空间面板'"
          @click="filesOpen = !filesOpen"
        >
          <!-- 自绘右侧面板开合图标：圆角外框 + 偏右分隔线，展开时右子面板着色 -->
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <rect x="2.6" y="3.6" width="14.8" height="12.8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.5" />
            <line x1="12.9" y1="3.6" x2="12.9" y2="16.4" stroke="currentColor" stroke-width="1.5" />
            <rect v-if="filesOpen" x="13.65" y="4.35" width="3" height="11.3" rx="1.2" fill="currentColor" opacity="0.35" />
          </svg>
        </button>
      </div>

      <div ref="msgsEl" class="msgs">
        <div class="msg-wrap">
          <div v-if="!activeId && messages.length === 0" class="chat-empty">
            选择左侧会话，或点击「＋ 新建对话」开始
          </div>
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div v-if="m.role === 'assistant'" class="m-head">
              <div class="ava">L</div><span class="m-role">Loop Agent</span>
            </div>
            <div :class="m.role === 'user' ? 'bubble' : 'body'">
              <div v-if="m.files?.length" class="msg-files">📎 {{ m.files.join('、') }}</div>
              <div v-if="m.compacting" class="compact-loading">
                <span class="cl-spin"></span>正在压缩对话历史…
              </div>
              <template v-for="(seg, i) in m.segments" :key="i">
                <details v-if="seg.type === 'tool'" class="tool-call">
                  <summary>
                    <span class="arrow">▶</span>
                    <span class="tc-badge" :class="seg.done ? 'ok' : 'run'">{{ seg.done ? '✓' : '⟳' }} {{ seg.tool }}</span>
                    <span class="tc-args">{{ seg.args }}</span>
                  </summary>
                  <div class="tc-body">{{ seg.result || '（执行中…）' }}</div>
                </details>
                <div v-else-if="m.role === 'assistant'" class="md" v-html="renderMarkdown(seg.text)"></div>
                <div v-else class="plain">{{ seg.text }}</div>
              </template>
              <span v-if="m.streaming" class="cursor"></span>
              <div v-if="m.failed" class="fatal">⚠ {{ m.failedText }}</div>
              <div v-if="m.meta" class="meta-line">{{ m.meta }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-inner">
          <div class="chips">
            <span v-for="u in uploads" :key="u.id" class="chip" :title="u.contextNote + '（将随下一条消息注入）'">
              📎 {{ u.fileName }}（{{ fmtBytes(u.bytes) }}）
              <button title="移除（不再注入，服务器文件保留）" @click="removeChip(u)">✕</button>
            </span>
          </div>
          <div class="box">
            <button class="attach" title="上传文件" :disabled="streaming || foreignActive" @click="upPopOpen = !upPopOpen">📎</button>
            <textarea
              v-model="draft"
              :disabled="foreignActive"
              :placeholder="foreignActive ? '跨工作空间会话仅支持查看与删除' : '输入消息，Enter 发送，Shift+Enter 换行'"
              @keydown.enter="onEnter"
              @compositionstart="setComposing(true)"
              @compositionend="setComposing(false)"
            ></textarea>
            <button v-if="streaming" class="stop" @click="stopGen">■ 停止</button>
            <button
              v-else
              class="primary send"
              :disabled="foreignActive || (!draft.trim() && uploads.length === 0)"
              @click="send"
            >
              发送
            </button>
          </div>
          <div class="meta">
            <label class="chk">
              <input v-model="streamChk" type="checkbox" :disabled="streaming"> 流式
            </label>
            <span class="hint">发送后自动附带 📎 文件的 contextNote</span>
          </div>

          <!-- 上传面板（文件选择框 + POST /uploads/raw） -->
          <div v-if="upPopOpen" class="up-pop">
            <div class="up-row">
              <button class="primary" :disabled="upBusy || streaming" @click="fileInput?.click()">
                {{ upBusy ? '上传中…' : '选择文件…' }}
              </button>
              <input ref="fileInput" type="file" multiple hidden @change="onPickFiles">
              <span class="muted-hint">支持多选 · 单文件上限 100MB</span>
            </div>
            <p class="up-note">
              上传成功后以 contextNote（[文件上传] 文件名 / 上传路径 / 大小）随下一条消息注入对话；
              chip ✕ 仅移除不再注入，「清空全部」删除服务器上传目录。
            </p>
            <div class="up-actions">
              <button class="clean" :class="{ armed: upCleanArmed }" :disabled="upBusy" @click="onCleanUploads">
                {{ upCleanArmed ? '确认清空？' : '清空全部' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 工作空间文件浏览器（对话右侧，v-model 控制展开） ===== -->
    <FilesView v-model:open="filesOpen" :ws-path="currentWsPath" />

    <!-- ===== 新建会话弹窗（已知工作空间 + 服务端目录浏览器） ===== -->
    <div v-if="newPopOpen" class="np-mask" @click.self="closeNewPop">
      <div class="np-card">
        <div class="np-head">
          <b>新建会话</b>
          <button class="np-x" title="关闭" @click="closeNewPop">✕</button>
        </div>

        <!-- 步骤 1：已知工作空间列表 -->
        <template v-if="!browseOpen">
          <p class="np-cap">在已有工作空间新建</p>
          <div class="np-ws-list">
            <button v-for="w in workspaces" :key="w.id" class="np-ws" :title="w.path" @click="createSession(w.path)">
              <span class="dot" :style="{ background: wsColor(w.name) }"></span>
              <span class="nm">{{ w.name }}</span>
              <span class="pth">{{ w.path }}</span>
              <span class="act">{{ w.current ? '新建会话' : '切换并新建' }}</span>
            </button>
            <div v-if="workspaces.length === 0" class="np-empty">暂无已知工作空间</div>
          </div>
          <div class="np-foot">
            <span></span>
            <button class="browse-btn" @click="openBrowse">📁 浏览磁盘选择目录…</button>
          </div>
        </template>

        <!-- 步骤 2：服务端目录浏览器 -->
        <template v-else>
          <div class="crumbs">
            <template v-for="(c, i) in dirCrumbs" :key="c.path">
              <span v-if="i > 0" class="sep">›</span>
              <button class="crumb" @click="browseDirs(c.path)">{{ c.label }}</button>
            </template>
            <button class="crumb up" :disabled="!dirParent" title="上一级" @click="dirParent && browseDirs(dirParent)">
              ↑ 上一级
            </button>
          </div>
          <div class="drive-chips">
            <button v-for="d in dirDrives" :key="d" class="drive" @click="browseDirs(d)">💽 {{ d }}</button>
          </div>
          <div class="jump-row">
            <input v-model="dirJump" type="text" placeholder="输入路径，如 D:\data" @keydown.enter="jumpTo">
            <button class="jump-go" :disabled="!dirJump.trim()" @click="jumpTo">跳转</button>
          </div>
          <div v-if="dirError" class="dir-err">⚠ {{ dirError }}</div>
          <div class="dir-list">
            <div v-if="dirLoading" class="dir-empty">加载中…</div>
            <template v-else>
              <button
                v-for="e in dirEntries"
                :key="e.name"
                class="dir-item"
                @click="browseDirs(joinPath(dirPath, e.name))"
              >
                📁 {{ e.name }}
              </button>
              <div v-if="dirEntries.length === 0" class="dir-empty">（无子目录）</div>
            </template>
          </div>
          <div class="np-foot">
            <button class="browse-btn ghost" @click="browseOpen = false">← 返回工作空间列表</button>
            <button class="primary" :disabled="newBusy || !dirPath" @click="createSession(dirPath)">
              {{ createInDirLabel }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 布局 ===== */
.chat {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.chat-head .ws-badge {
  font-size: 11.5px;
  color: var(--muted);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: none;
}
.chat-head .ro-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--warn);
  background: var(--warn-weak, rgba(180, 83, 9, 0.12));
  border-radius: 999px;
  padding: 2px 8px;
  flex: none;
}

/* ===== 主区 ===== */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.chat-head {
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  align-items: center;
  gap: 10px;
  /* 容器查询基准：按对话区实际宽度做窄容器兼容 */
  container-type: inline-size;
}
.chat-head b {
  font-size: 14px;
  min-width: 0;
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-head .sid {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--muted);
  flex: none;
  white-space: nowrap;
}
.chat-head .spacer { flex: 1; }
.chat-head .icon-toggle {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 4px 6px;
  line-height: 0;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  color: var(--muted);
  flex: none;
}
.chat-head .icon-toggle:hover { color: var(--text); }
.chat-head .icon-toggle.on {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
}
.muted-hint { font-size: 12px; color: var(--muted); }
.chat-head .muted-hint { flex: none; white-space: nowrap; }

/* 窄容器兼容（对话区收窄时）：标题栏隐藏次要信息，保证标题可读 */
@container (max-width: 520px) {
  .chat-head .sid,
  .chat-head .muted-hint { display: none; }
  .chat-head .ws-badge { max-width: 120px; }
}
@container (max-width: 380px) {
  .chat-head .ws-badge { display: none; }
}

/* ===== 消息流 ===== */
.msgs { flex: 1; overflow-y: auto; padding: 20px 0; }
.msg-wrap { max-width: 800px; margin: 0 auto; padding: 0 20px; }
.chat-empty {
  text-align: center;
  color: var(--muted);
  padding: 48px 0;
  font-size: 13.5px;
}
/* 用户消息：无头像，右对齐气泡；助手消息：头像+名称在上，正文平铺 */
.msg { margin-bottom: 18px; }
.msg .ava {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  background: var(--brand);
  color: var(--brand-on);
}
.msg.user { display: flex; justify-content: flex-end; }
.msg.user .bubble {
  max-width: 76%;
  padding: 9px 14px;
  border-radius: 12px;
  background: var(--brand-weak);
  border-top-right-radius: 4px;
}
.msg.user .plain { white-space: pre-wrap; word-break: break-word; }
.msg.assistant .m-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.msg.assistant .m-role { font-size: 12px; font-weight: 600; color: var(--muted); }
.msg .bubble p, .msg .body p { margin: 0 0 8px; }
.msg .bubble p:last-child, .msg .body p:last-child { margin-bottom: 0; }
.md :first-child { margin-top: 0; }
.md :last-child { margin-bottom: 0; }
/* v-html 注入内容无 scoped 属性，pre/code 需 :deep 穿透（含 mermaid 失败回退的代码块） */
.md :deep(pre) {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  margin: 8px 0;
}
.md :deep(code) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 5px;
}
.md :deep(pre code) { background: none; padding: 0; }
/* markdown 表格：长 code 列会把文字列挤成竖排，改为块级横向滚动 */
.md :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--line);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
.md :deep(th) { background: var(--code-bg); }
.md :deep(td code) { overflow-wrap: anywhere; }
/* mermaid 图表容器样式已全局化至 ../mermaid.css（与 FilesView 共用） */
.msg-files { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.meta-line { font-size: 11px; color: var(--muted); margin-top: 6px; }
.fatal {
  color: var(--danger);
  background: var(--danger-weak);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12.5px;
  margin-top: 8px;
}
.cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  background: var(--brand);
  vertical-align: -2px;
  margin-left: 2px;
  animation: blink 1s steps(1) infinite;
  border-radius: 1px;
}
@keyframes blink { 50% { opacity: 0; } }

/* ===== 压缩中 loading（compaction_start/compaction 事件配对驱动） ===== */
.compact-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
}
.cl-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: cl-rotate 0.8s linear infinite;
}
@keyframes cl-rotate { to { transform: rotate(360deg); } }

/* ===== 工具调用折叠块 ===== */
.tool-call {
  border: 1px solid var(--line);
  border-radius: 9px;
  margin: 8px 0;
  overflow: hidden;
  background: var(--bg);
}
.tool-call summary {
  cursor: pointer;
  padding: 7px 12px;
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  font-family: ui-monospace, Consolas, monospace;
}
.tool-call summary::-webkit-details-marker { display: none; }
.tool-call summary .arrow { transition: transform 0.15s; color: var(--muted); font-size: 10px; }
.tool-call[open] summary .arrow { transform: rotate(90deg); }
.tc-badge { font-weight: 600; }
.tc-badge.ok { color: var(--brand); }
.tc-badge.run { color: var(--warn); }
.tc-args {
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-call .tc-body {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--line);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
}

/* ===== 输入区 ===== */
.composer {
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 12px 20px 14px;
  /* 容器查询基准：按对话区实际宽度做窄容器兼容 */
  container-type: inline-size;
}
.composer-inner { max-width: 800px; margin: 0 auto; position: relative; }
.composer .box { display: flex; gap: 10px; align-items: flex-end; }
.composer textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  height: 44px;
  line-height: 1.5;
  padding: 10px 12px;
}
.composer .attach { flex: none; height: 44px; padding: 0 12px; font-size: 16px; }
.composer .send { flex: none; height: 44px; padding: 0 18px; }
.composer .stop { flex: none; height: 44px; padding: 0 14px; color: var(--danger); border-color: var(--danger); }
.composer .meta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 7px;
  font-size: 12px;
  color: var(--muted);
  flex-wrap: wrap;
  min-width: 0;
}
.composer label.chk { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; flex: none; }
.composer .hint { font-size: 11.5px; }

/* 窄容器兼容（对话区收窄时）：隐藏次要提示、收窄按钮 */
@container (max-width: 520px) {
  .composer .hint { display: none; }
}
@container (max-width: 380px) {
  .composer .send { padding: 0 12px; }
  .composer .attach { padding: 0 9px; }
}

/* ===== 上传 chip 与面板 ===== */
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chips:not(:empty) { margin-bottom: 8px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 6px 3px 10px;
  font-size: 12px;
  max-width: 100%;
}
.chip button { border: none; background: none; padding: 0 3px; color: var(--muted); font-size: 12px; }
.chip button:hover { color: var(--danger); }
.up-pop {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 14px 16px;
  z-index: 20;
}
.up-row { display: flex; gap: 10px; align-items: center; }
.up-note { font-size: 11.5px; color: var(--muted); margin: 8px 2px 0; }
.up-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
.up-actions .clean {
  border: none;
  background: none;
  color: var(--danger);
  font-size: 12.5px;
  padding: 4px 8px;
}
.up-actions .clean.armed { background: var(--danger); color: #fff; border-radius: 6px; }

/* ===== 新建会话弹窗 ===== */
.np-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.np-card {
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: 72vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
  padding: 14px 16px 16px;
}
.np-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.np-head b { font-size: 14px; }
.np-x { border: none; background: none; color: var(--muted); font-size: 14px; padding: 2px 6px; cursor: pointer; }
.np-x:hover { color: var(--danger); }
.np-cap { font-size: 11.5px; color: var(--muted); margin: 0 2px 6px; }
.np-ws-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.np-ws {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  border-radius: 9px;
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.np-ws:hover { border-color: var(--brand); background: var(--brand-weak); }
.np-ws .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.np-ws .nm {
  font-size: 13px;
  font-weight: 600;
  flex: none;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.np-ws .pth {
  font-size: 11px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
}
.np-ws .act { font-size: 11.5px; color: var(--brand); flex: none; }
.np-empty { color: var(--muted); font-size: 12.5px; text-align: center; padding: 14px 0; }
.np-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 12px; }
.browse-btn {
  border: 1px dashed var(--line);
  background: none;
  color: var(--muted);
  border-radius: 8px;
  font-size: 12.5px;
  padding: 6px 10px;
  cursor: pointer;
}
.browse-btn:hover { color: var(--brand); border-color: var(--brand); }
.browse-btn.ghost { border-style: solid; }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-bottom: 8px; font-size: 12px; }
.crumb {
  border: none;
  background: none;
  color: var(--brand);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 5px;
  font-size: 12px;
  word-break: break-all;
}
.crumb:hover { background: var(--brand-weak); }
.crumb:disabled { color: var(--muted); opacity: 0.55; cursor: default; }
.crumb.up { margin-left: auto; color: var(--muted); flex: none; }
.crumbs .sep { color: var(--muted); }
.drive-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.drive {
  border: 1px solid var(--line);
  background: var(--bg);
  border-radius: 999px;
  font-size: 11.5px;
  padding: 2px 9px;
  cursor: pointer;
}
.drive:hover { border-color: var(--brand); color: var(--brand); }
.jump-row { display: flex; gap: 6px; margin-bottom: 8px; }
.jump-row input { flex: 1; min-width: 0; font-size: 12.5px; padding: 5px 9px; border-radius: 7px; }
.jump-go { font-size: 12px; padding: 0 12px; }
.dir-err {
  color: var(--danger);
  background: var(--danger-weak);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 12px;
  margin-bottom: 8px;
}
.dir-list {
  border: 1px solid var(--line);
  border-radius: 9px;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.dir-item {
  border: none;
  background: none;
  text-align: left;
  font-size: 12.5px;
  padding: 7px 11px;
  cursor: pointer;
}
.dir-item:hover { background: var(--brand-weak); }
.dir-item + .dir-item { border-top: 1px solid var(--line); }
.dir-empty { color: var(--muted); font-size: 12px; text-align: center; padding: 16px 0; }
</style>
