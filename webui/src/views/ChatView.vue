<script setup lang="ts">
// ChatView：会话 CRUD + SSE 流式对话 + 停止生成 + 对话内上传（Task-20261017-001 D5/D7）
// 端点映射：
//   GET    /workspaces          → 左侧菜单会话列表（sessions.ts 共享 store；按工作空间分组聚合）
//   POST   /sessions            → 新建会话（body 可带 workspacePath 直接在目标空间创建；发送前无会话时也自动创建）
//   GET    /fs/dirs             → 服务端目录浏览（新建弹窗「浏览磁盘」；纯 Web 拿不到本地目录绝对路径）
//   GET    /sessions/:id        → 恢复历史消息（{meta, messages, workspace}；按 id 定位归属空间，不再切换）
//   DELETE /sessions/:id        → 删除（二次确认；in-flight 409；支持跨工作空间会话）
//   POST   /sessions/:id/messages → 发消息（默认 SSE；stream:false 非流式 JSON；跨空间会话在归属空间内执行）
//   POST   /uploads/raw         → 📎 文件选择框上传 → chip（contextNote 随下一条消息注入）
//   DELETE /uploads             → 上传面板「清空全部」（二次确认）
// 停止生成：POST /sessions/:id/stop 服务端真取消（Task-20261021-002-04），终态由 SSE aborted 事件驱动
// mermaid：流式结束/历史加载后对 ```mermaid 代码块后处理渲染为 SVG（../mermaid.ts 共享模块，
//          FilesView md 预览同款；动态 import 独立 chunk，主题跟随 prefers-color-scheme；
//          解析失败保留代码块并标红；交互：工具栏 放大/缩小/适应宽度/全屏 + 滚轮缩放）

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api, AuthError, ApiError, uploadRaw } from '../api/client.js';
import { showToast } from '../toast.js';
import { highlightIn } from '../markdown.js';
import { renderMermaidIn } from '../mermaid.js';
import { renderEChartsIn } from '../echarts.js';
import { splitStreamBlocks, type Block } from '../stream-blocks.js';
import FilesView from './FilesView.vue';
import LiveStatus from '../components/LiveStatus.vue';
import {
  workspaces,
  activeId,
  activeWsPath,
  wsColor,
  loadSessions,
  registerChatBridge,
  consumePendingNewPop,
  consumePendingSelect,
  type SessionMeta,
} from '../sessions.js';
import {
  messagesOf,
  stateOf,
  isRunning,
  ensureLoaded,
  initEmpty,
  sendMessage,
  abortRun,
  setActiveSession,
  setChatViewMounted,
  setActivityHandler,
  onRunFinished,
  type ChatMsg,
  type Segment,
  type ToolSeg,
} from '../chat-stream.js';
import {
  getNotifySettings,
  setNotifySettings,
  requestNotifyPermission,
  notifySupported,
  type NotifySettings,
} from '../notify.js';
import { groupToolSegs, type RenderItem, type ToolCardVM } from '../tool-meta.js';
import ToolCard from '../components/ToolCard.vue';

/* ===== 工具调用卡片（Task-20261024-001：方案 B 卡片内聚式，渲染与样式在 ToolCard.vue）===== */
/** segments → 顺序渲染项：连续 ≥3 次同工具合并成组（D5），文本段原样透传 */
function renderItems(m: ChatMsg): RenderItem<Segment>[] {
  return groupToolSegs(m.segments);
}
/** tool 分支的 items 恒为 ToolSeg（groupToolSegs 只在 type==='tool' 的段上产出），此处仅对齐类型 */
function cardVM(it: RenderItem<Segment>): ToolCardVM<ToolSeg> {
  return (it as Extract<RenderItem<Segment>, { kind: 'tool' }>).card as unknown as ToolCardVM<ToolSeg>;
}
/** 非 assistant 消息的纯文本段 */
function textOf(it: RenderItem<Segment>): string {
  return it.kind === 'seg' && it.seg.type === 'text' ? it.seg.text : '';
}
interface UploadChip {
  id: number;
  fileName: string;
  bytes: number;
  contextNote: string;
}

// 消息与运行状态由 chat-stream 单例按 sessionId 持有：切换会话/离开页面不中断 run
const messages = computed(() => messagesOf(activeId.value));
const stream = computed(() => (activeId.value ? stateOf(activeId.value) : null));
const draft = ref('');
const streaming = computed(() => (activeId.value ? isRunning(activeId.value) : false));
const streamChk = ref(true);
// 后台完成提醒（Task-20261021-002-07）：🔔 面板两开关 + 非安全上下文降级说明
const notifyPopOpen = ref(false);
const notifyCfg = ref<NotifySettings>(getNotifySettings());
const notifySecure = notifySupported();

/** 勾选「系统通知」：手势中请求权限（D4）；denied 回退开关并提示 */
async function toggleNotifySystem(on: boolean): Promise<void> {
  if (on) {
    if (!notifySecure) {
      notifyCfg.value.system = false;
      showToast('当前环境不支持系统通知（需 https/localhost），提示音仍可用', 'error');
      return;
    }
    const perm = await requestNotifyPermission();
    if (perm !== 'granted') {
      notifyCfg.value.system = false;
      showToast(perm === 'denied' ? '通知权限已被拒绝，可在浏览器设置中恢复' : '通知权限未授权', 'error');
      setNotifySettings({ asked: true });
      return;
    }
  }
  notifyCfg.value.system = on;
  setNotifySettings({ system: on, asked: true });
}

/** 勾选「提示音」：AudioContext 在手势中创建解锁（自动播放策略） */
function toggleNotifySound(on: boolean): void {
  notifyCfg.value.sound = on;
  setNotifySettings({ sound: on });
  if (on) playChime(); // 手势中播放同时解锁 AudioContext
}
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

let chipSeq = 0;
let composing = false; // 中文输入法组词中的 Enter 不发送
/** 模板经此函数改写 composing：vue-tsc 对模板内直接赋值顶层 let 存在字面量收窄误报（TS2322） */
function setComposing(v: boolean): void {
  composing = v;
}

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/* ================= 消息后处理：代码高亮 + 图表 ================= */
// Task-20261023-002 D1/D4：文本段改为「稳定块 + 可变尾部」渲染（见 ../stream-blocks.ts），
// 图表围栏闭合即可渲染，无需再等整条消息结束——流式期间由 streamTextLen 的 watch 节流触发，
// 结束时（send finally / onRunFinished）与历史加载（selectSession）仍各做一次全量兜底。
// 后处理顺序：先 highlight.js 高亮普通代码块，再渲染 mermaid、echarts（各自跳过对方语言）。

async function postRenderMsgs(): Promise<void> {
  await nextTick();
  if (!msgsEl.value) return;
  highlightIn(msgsEl.value); // 高亮在图表前：mermaid/echarts 块在 highlightIn 内部被跳过
  await renderMermaidIn(msgsEl.value); // 槽位路径为主（D3），legacy 旧代码块形态默认不启用
  void renderEChartsIn(msgsEl.value);
}

/* ---- 流式增量渲染（D1/D4/D5） ---- */

/** 文本段 → 块序列（模板用；splitStreamBlocks 内部有 md HTML 的 LRU 缓存，D8） */
function segBlocks(m: ChatMsg, seg: Segment, i: number): Block[] {
  if (seg.type !== 'text') return [];
  return splitStreamBlocks(seg.text, {
    streaming: !!m.streaming,
    isTail: i === m.segments.length - 1,
  });
}

/** 当前会话文本总长度：作为「有新 chunk 到达」的响应式信号（D4） */
const streamTextLen = computed(() => {
  let n = 0;
  for (const m of messages.value) {
    for (const s of m.segments) if (s.type === 'text') n += s.text.length;
  }
  return n;
});

let renderTimer = 0;
/** 尾段以围栏行结尾的快速预判（```` ``` ```` / 更长围栏，允许尾随空白） */
const FENCE_TAIL_RE = /\n? {0,3}`{3,}[ \t]*$/;
function clearRenderTimer(): void {
  if (!renderTimer) return;
  clearTimeout(renderTimer);
  renderTimer = 0;
}

/** 节流后处理：把多 chunk 合并为一次，避免每个 token 都扫描整棵消息树 */
function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = window.setTimeout(() => {
    renderTimer = 0;
    void postRenderMsgs();
  }, 300);
}

/** 尾段最后一块是否为已闭合图表块：是则立即渲染，让图表尽早出现（不等节流窗口） */
function tailChartReady(): boolean {
  const list = messages.value;
  const m = list[list.length - 1];
  if (!m?.streaming) return false;
  for (let i = m.segments.length - 1; i >= 0; i--) {
    const s = m.segments[i];
    if (s.type !== 'text') continue;
    // 快速预判：文本不以围栏行结尾则不可能新闭合出图表块，省掉一次完整切分
    if (!FENCE_TAIL_RE.test(s.text)) return false;
    const blks = splitStreamBlocks(s.text, { streaming: true, isTail: true });
    return blks[blks.length - 1]?.kind === 'chart';
  }
  return false;
}

watch(streamTextLen, () => {
  if (tailChartReady()) {
    clearRenderTimer();
    void postRenderMsgs();
  } else {
    scheduleRender();
  }
});

// mermaid 容器构建（缩放/平移/全屏/源码切换）与渲染排队逻辑见 ../mermaid.ts、
// ../chart-box.ts，样式见 ../mermaid.css

function scrollBottom(): void {
  nextTick(() => {
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  });
}

// 高频事件（llm_stream / tool_call_delta）合并到下一帧：避免逐 chunk 读取 scrollHeight 强制重排
let scrollRaf = 0;
function scrollBottomSoon(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    scrollBottom();
  });
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ================= 会话创建（列表数据见 sessions.ts 共享 store） ================= */

/**
 * 创建会话；带 workspacePath 时直接在目标空间创建（同空间视为直建）。
 * 从弹窗发起（传参）时整体刷新列表——分组顺序不变。
 */
async function createSession(workspacePath?: string): Promise<string | null> {
  const fromPop = workspacePath !== undefined;
  if (fromPop) newBusy.value = true;
  try {
    const r = await api<SessionMeta & { workspace?: { path: string; id: string } }>(
      '/sessions',
      { method: 'POST', json: fromPop ? { workspacePath } : undefined },
    );
    await loadSessions();
    activeId.value = r.id;
    initEmpty(r.id);
    scrollBottom();
    if (fromPop) {
      closeNewPop();
      showToast('会话已创建', 'success');
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

/** 当前浏览目录与已知空间的匹配：known=已知空间 fresh=未知目录 */
const dirTargetKind = computed(() => {
  const p = dirPath.value.toLowerCase();
  return workspaces.value.some((w) => w.path.toLowerCase() === p) ? 'known' : 'fresh';
});

const createInDirLabel = computed(() => {
  if (newBusy.value) return '创建中…';
  if (dirTargetKind.value === 'known') {
    const w = workspaces.value.find((x) => x.path.toLowerCase() === dirPath.value.toLowerCase());
    return `在 ${w?.name ?? '该空间'} 中新建会话`;
  }
  return '在此目录中新建会话';
});

async function selectSession(id: string): Promise<void> {
  // 同会话且消息已在场（含从管理页返回重挂载场景）不重复拉取；运行中的会话由 chat-stream 续传
  if (id === activeId.value && messagesOf(id).length > 0) return;
  try {
    // task-05：跨空间会话不再切换服务端状态，按 id 定位归属空间后直接加载
    await ensureLoaded(id);
    activeId.value = id;
    scrollBottom();
    void postRenderMsgs();
  } catch (e) {
    if (e instanceof AuthError) return;
    // 会话不存在（落盘数据被清理等）：重置视图并刷新列表，让僵尸条目消失
    if (e instanceof ApiError && e.code === 'not_found') {
      showToast('会话不存在或已被删除，列表已刷新', 'error');
      activeId.value = '';
      await loadSessions();
      return;
    }
    showToast(errText(e), 'error');
  }
}

/* ================= 消息发送（事件渲染见 chat-stream） ================= */

async function ensureSession(): Promise<string | null> {
  return activeId.value ?? (await createSession());
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text && uploads.value.length === 0) return;
  if (streaming.value) {
    showToast('当前会话正在生成回复，请先停止', 'error');
    return;
  }
  // 20261021-002-05：服务端 AgentPool 已支持同空间多会话并发，
  // 跨会话发送拦截移除（服务端 entry.inFlight 仅约束同会话串行）
  const sessionId = await ensureSession();
  if (!sessionId) return;

  // contextNote 拼接进 message 文本（POST messages 无独立 contextNote 字段）
  const notes = uploads.value.map((u) => u.contextNote);
  const full = [...notes, text].filter(Boolean).join('\n\n');

  const chipsSnapshot = uploads.value;
  const draftSnapshot = draft.value;
  uploads.value = [];
  draft.value = '';
  scrollBottom();

  // 发送与流式累加在 chat-stream（模块级状态，切换会话/离开聊天页不中断）
  const outcome = await sendMessage(sessionId, {
    message: full,
    text,
    files: chipsSnapshot.map((u) => u.fileName),
    stream: streamChk.value,
  });
  if (outcome === 'failed') {
    // 请求未成功：恢复输入，用户可直接重试
    uploads.value = chipsSnapshot;
    draft.value = draftSnapshot;
  }
  scrollBottom();
  void postRenderMsgs(); // 流式/非流式/停止/失败统一在此做代码高亮 + mermaid
  void loadSessions(); // 刷新 messageCount / updatedAt
}

/** 停止生成（Task-20261021-002-04）：请求服务端真取消，终态由 SSE aborted 事件驱动渲染 */
async function stopGen(): Promise<void> {
  if (!activeId.value) return;
  const outcome = await abortRun(activeId.value);
  if (outcome === 'aborting') showToast('已请求停止（服务端正在收尾）');
  else if (outcome === 'none') showToast('当前无正在运行的任务');
  else showToast('停止请求失败，已断开本页连接', 'error');
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

// 活跃会话同步给 chat-stream：离开聊天页时 run 完成要记未读并提示
watch(activeId, (v) => setActiveSession(v));

// Esc 关闭新建会话弹窗（window 级监听：焦点可能落在弹窗内输入框，元素级 @keydown 不可靠）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && newPopOpen.value) closeNewPop();
}

let offRunFinished: (() => void) | null = null;

onMounted(() => {
  setChatViewMounted(true);
  setActiveSession(activeId.value);
  // 流式事件到达时仅活跃会话滚动（组件卸载后 handler 置空，run 不受影响）
  setActivityHandler((id) => {
    if (id === activeId.value) scrollBottomSoon();
  });
  offRunFinished = onRunFinished((id) => {
    if (id === activeId.value) {
      scrollBottom();
      void postRenderMsgs();
    }
  });
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
  // 只清理视图侧监听：run / SSE 连接由 chat-stream 持有，离开页面继续运行
  setChatViewMounted(false);
  setActivityHandler(null);
  offRunFinished?.();
  offRunFinished = null;
  registerChatBridge(null);
  window.removeEventListener('keydown', onGlobalKeydown);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  clearRenderTimer(); // 流式图表渲染的节流定时器
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
              <template
                v-for="it in renderItems(m)"
                :key="it.kind === 'tool' ? `t${it.card.index}` : `s${it.index}`"
              >
                <ToolCard v-if="it.kind === 'tool'" :card="cardVM(it)" />
                <div v-else-if="m.role === 'assistant'" class="md">
                  <!-- 稳定块 + 可变尾部（D1）：内容未变的块 key 不变 → Vue 复用 DOM，
                       块内 append 的图表容器得以存活；每个 chunk 只重渲尾部块 -->
                  <template v-for="blk in segBlocks(m, it.seg, it.index)" :key="blk.k">
                    <!-- eslint-disable-next-line vue/no-v-html — 内容经 DOMPurify 消毒（../markdown.ts） -->
                    <div v-if="blk.kind === 'md'" v-html="blk.html"></div>
                    <div v-else-if="blk.kind === 'chart'" class="chart-slot" :data-lang="blk.lang" :data-src="blk.src"></div>
                    <!-- 未闭合的图表围栏：显示占位而非逐字刷屏的裸源码（D5） -->
                    <div v-else class="chart-pending">
                      <span class="cp-spin"></span>
                      <span>正在生成 {{ blk.lang }} 图表…</span>
                      <span class="cp-num">已生成 {{ blk.chars }} 字符</span>
                    </div>
                  </template>
                </div>
                <div v-else class="plain">{{ textOf(it) }}</div>
              </template>
              <!-- 压缩 loading 放在消息末尾：长链路时仍可见（滚动由 compaction_start 的 notifyActivity 驱动） -->
              <div v-if="m.compacting" class="compact-loading">
                <span class="cl-spin"></span>正在压缩对话历史…
              </div>
              <LiveStatus
                v-if="m.streaming && !m.compacting && !m.failed && m.live"
                :live="m.live ?? null"
                :last-event-at="m.lastEventAt"
              />
              <span v-if="m.streaming && !m.compacting && !m.live" class="cursor"></span>
              <div v-if="m.failed" class="fatal">⚠ {{ m.failedText }}</div>
              <div v-if="m.aborted" class="aborted-note">⏹ 已被用户停止，以上为已生成的部分输出</div>
              <div v-if="m.meta" class="meta-line">{{ m.meta }}</div>
            </div>
          </div>
        </div>
        <!-- 时间线尾注记（task-06）：重启后的中断/停止说明，前端态灰条，不进消息数组 -->
        <div v-if="stream?.note" class="aborted-note run-note">{{ stream.note }}</div>
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
            <button class="attach" title="上传文件" :disabled="streaming" @click="upPopOpen = !upPopOpen">📎</button>
            <textarea
              v-model="draft"
              :placeholder="'输入消息，Enter 发送，Shift+Enter 换行'"
              @keydown.enter="onEnter"
              @compositionstart="setComposing(true)"
              @compositionend="setComposing(false)"
            ></textarea>
            <button v-if="streaming" class="stop" title="停止本次运行（服务端将中断）" @click="stopGen">■ 停止</button>
            <button
              v-else
              class="primary send"
              :disabled="!draft.trim() && uploads.length === 0"
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
            <button
              class="chk notify-btn"
              type="button"
              title="后台完成提醒设置"
              @click="notifyPopOpen = !notifyPopOpen"
            >
              🔔<span class="muted-hint">{{ notifyCfg.sound ? '声音开' : '声音关' }}{{ notifyCfg.system ? ' · 通知开' : '' }}</span>
            </button>
          </div>

          <!-- 后台完成提醒面板（Task-20261021-002-07）：系统通知/提示音两开关 -->
          <div v-if="notifyPopOpen" class="up-pop notify-pop">
            <div class="up-row notify-row">
              <label class="chk">
                <input
                  type="checkbox"
                  :checked="notifyCfg.system"
                  @change="toggleNotifySystem(($event.target as HTMLInputElement).checked)"
                > 系统通知
              </label>
              <label class="chk">
                <input
                  type="checkbox"
                  :checked="notifyCfg.sound"
                  @change="toggleNotifySound(($event.target as HTMLInputElement).checked)"
                > 提示音
              </label>
            </div>
            <div v-if="!notifySecure" class="notify-degrade">
              当前通过局域网 IP + http 访问，浏览器不提供系统通知；提示音与页内提醒不受影响
            </div>
            <div v-else-if="!notifyCfg.system && !notifyCfg.asked" class="notify-degrade">
              开启「系统通知」后，切到其他窗口时完成/停止会弹系统提醒
            </div>
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
    <FilesView v-model:open="filesOpen" :ws-path="activeWsPath" />

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
              <span class="act">新建会话</span>
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
/* 首/尾块清零：分块渲染后（D1）不能再用 `.md :first-child` 这类全局后代选择器，
   否则每个块的首尾元素 margin 都被清零、块间距塌陷；限定到首/尾 md 块内部。
   块 div 无 padding/border，子元素 margin 会正常 collapse 穿过块边界。 */
.md > .md-blk:first-child :deep(:first-child) { margin-top: 0; }
.md > .md-blk:last-child :deep(:last-child) { margin-bottom: 0; }
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
/* 被用户停止的部分输出灰条（m.aborted，Task-20261021-002-04）：中性灰，与失败红区分 */
.aborted-note {
  color: var(--muted);
  background: var(--bg);
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12.5px;
  margin-top: 8px;
}
/* 时间线尾注记（stream.note，Task-20261021-002-06）：与 aborted 灰条同色系，独立于消息卡片 */
.run-note {
  margin: 10px 2px 0;
  text-align: center;
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

/* ===== 压缩中 loading（compaction_start/compaction 事件配对驱动；渲染在消息末尾） ===== */
.compact-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
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

/* ===== 工具调用卡片（Task-20261024-001：方案 B 卡片内聚式；主体样式见 components/ToolCard.vue）===== */
/* 旧类名别名（D9，只保一版）：旧 bundle 的 <details class="tool-call"> 与新样式短暂共存时仍有外框与状态色 */
.tool-call {
  border: 1px solid var(--line);
  border-radius: 10px;
  margin: 8px 0;
  overflow: hidden;
  background: var(--panel);
}
.tool-call > summary {
  cursor: pointer;
  padding: 7px 12px;
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  white-space: nowrap;
  overflow: hidden;
}
.tool-call > summary::-webkit-details-marker { display: none; }
.tc-badge {
  flex: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
}
.tc-badge.ok { background: var(--ok-weak); color: var(--ok); }
.tc-badge.run { background: var(--warn-weak); color: var(--warn); }
.tc-badge.fail { background: var(--danger-weak); color: var(--danger); }

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
/* 后台完成提醒（Task-20261021-002-07）：🔔 按钮 + 面板 */
.composer .notify-btn { background: none; border: none; padding: 0; font-size: 12.5px; }
.composer .notify-btn .muted-hint { color: var(--muted, #888); font-size: 11.5px; margin-left: 3px; }
.notify-pop { min-width: 300px; }
.notify-pop .notify-row { display: flex; gap: 18px; margin-bottom: 6px; }
.notify-pop .notify-degrade { font-size: 11.5px; color: var(--muted, #888); line-height: 1.5; }.composer .hint { font-size: 11.5px; }

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