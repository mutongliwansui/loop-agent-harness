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
import {
  capPasteFiles,
  collectPasteFiles,
  visionSkipReason,
  PASTE_MAX_FILES,
  type VisionGate,
} from '../paste-files.js';
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
import { groupToolSegs, type RenderItem, type ToolCardVM } from '../tool-meta.js';
import ToolCard from '../components/ToolCard.vue';
import { nextTextareaHeight } from '../autogrow.js';
import { createFollowState, type FollowState } from '../scroll-follow.js';
import { buildPickerRows, resolvePill, type ModelProfileRow, type PickerRow } from '../model-picker.js';
import { metaRev } from '../mcp-tool-meta-loader.js';

/* ===== 工具调用卡片（Task-20261024-001：方案 B 卡片内聚式，渲染与样式在 ToolCard.vue）===== */
/** segments → 顺序渲染项：连续 ≥3 次同工具合并成组（D5），文本段原样透传 */
function renderItems(m: ChatMsg): RenderItem<Segment>[] {
  // 20261104-001：读取 metaRev 以建立渲染依赖——元信息异步到位后卡片需要重算中文名/图标/参数标签
  void metaRev.value;
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
  /** 图片附件的本地缩略图 blob URL（task-20261028-005 D6）；非图片为 undefined */
  thumbUrl?: string;
  /** 视觉链路不可用/超限等可观测警告（D8）；无问题为 undefined */
  warn?: string;
}

// 消息与运行状态由 chat-stream 单例按 sessionId 持有：切换会话/离开页面不中断 run
const messages = computed(() => messagesOf(activeId.value));
const stream = computed(() => (activeId.value ? stateOf(activeId.value) : null));
const draft = ref('');
const streaming = computed(() => (activeId.value ? isRunning(activeId.value) : false));

/* ===== 会话级模型选择（task-20261025-002 D4/D8/D9）=====
 * 只影响本会话后续消息，不改全局激活（不发 PUT /model）。
 * 数据源复用 GET /models；apiKey 已被服务端遮蔽，前端不持有明文。 */
const modelProfiles = ref<ModelProfileRow[]>([]);
const modelActive = ref<string | null>(null);
/** 当前会话所选别名；空串/undefined = 跟随全局 */
const modelAlias = ref<string>('');
const modelOpen = ref(false);
const modelLoadFailed = ref(false);
const modelPillEl = ref<HTMLElement | null>(null);
const rows = computed<PickerRow[]>(() =>
  buildPickerRows(modelProfiles.value, modelActive.value, modelAlias.value),
);
const pill = computed(() => resolvePill(modelAlias.value, modelActive.value));
const uploads = ref<UploadChip[]>([]);
const upPopOpen = ref(false);
/**
 * 上传面板开关（task-20261025-002 D9）：与模型面板互斥，避免两个浮层叠在一起
 */
function toggleUpPop(): void {
  upPopOpen.value = !upPopOpen.value;
  if (upPopOpen.value) modelOpen.value = false;
}
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
/** FilesView 实例引用（20261028-006 D2：工具卡片路径 chip 直调 openPath） */
const filesRef = ref<InstanceType<typeof FilesView> | null>(null);
/**
 * 工具卡片路径 chip 点击（20261028-006 D1/D2）：自动展开文件面板并打开预览/定位目录。
 * openPath 内部已含 toast 兜底，此处不再重复提示。
 */
function onOpenPath(payload: { path: string; kind: 'file' | 'dir' }): void {
  void filesRef.value?.openPath(payload.path, payload.kind);
}

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

/* ===== 滚动跟随（task-20261027-004 / 优化建议 20261027-002）=====
 * 问题：原实现无条件把 scrollTop 写成 scrollHeight，且 chat-stream 每个流式 chunk 都会
 * 触发 setActivityHandler，导致用户上滑后几十毫秒就被拽回底部，中途无法阅读。
 * 方案：贴底才跟随（pinned）+ 上滑即解绑（released），判定逻辑在 ../scroll-follow.ts。
 *   - released 时 scrollBottom() 直接返回：既不写 scrollTop，也不读 scrollHeight（免一次强制重排）；
 *   - released 由用户手势（滚轮/触摸/拖动滚动条/键盘）触发，滚回底部（距底 ≤ 24px）自动回吸；
 *   - 发送消息 / 切换会话 / 新建会话 / 点「回到最新」按钮为强制回底（D6）。
 * 为何不处理程序化写入引发的 scroll 事件：released 态完全不写 scrollTop，故 scroll 事件
 * 只可能在 pinned 态出现；而 pinned 态的 onScroll() 不做解绑判定（只做回吸），互不干扰。 */
const followCtl = createFollowState();
const follow = ref<'pinned' | 'released'>('pinned');
/** 解绑期间是否有新内容（驱动按钮上的圆点，不计数：单条消息在增长，条数无意义） */
const hasPending = ref(false);

/** 控制器状态 → 模板响应式状态 */
function syncFollow(st: FollowState): void {
  if (follow.value !== st.follow) follow.value = st.follow;
  if (hasPending.value !== st.hasPending) hasPending.value = st.hasPending;
}

/** 滚到底（仅在 pinned 时生效）；smooth 用于「回到最新」按钮的一次性回底（D8） */
function scrollBottom(opts?: { smooth?: boolean }): void {
  if (follow.value === 'released') return; // 已解绑：视口归用户，不读高度也不写位置
  const el = msgsEl.value;
  if (!el) return;
  if (opts?.smooth) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    return;
  }
  el.scrollTop = el.scrollHeight;
}

/** DOM 更新（新增消息/切换会话）后滚底：nextTick 等 v-for 落地再读 scrollHeight */
function scrollBottomAfterRender(opts?: { smooth?: boolean }): void {
  void nextTick(() => scrollBottom(opts));
}

/** 强制回底（D6）：发送消息 / 切换会话 / 新建会话 / 点回底按钮，无视当前解绑状态 */
function forceScrollBottom(opts?: { smooth?: boolean }): void {
  syncFollow(followCtl.forcePin());
  scrollBottomAfterRender(opts);
}

/** 用户手势 → 解绑跟随（D3）：wheel / touchmove / 拖动滚动条 / 键盘滚动键 */
function markUserScroll(): void {
  const el = msgsEl.value;
  // 内容不足一屏（无滚动空间）时手势不算「脱离」：否则按钮会出现在无内容可滚的会话里
  if (el && el.scrollHeight <= el.clientHeight + 1) return;
  syncFollow(followCtl.onUserGesture());
}

/** 容器滚动 → 仅用于「滚回底部自动重新吸附」（距底 ≤ STICK_THRESHOLD_PX） */
function onMsgsScroll(): void {
  const el = msgsEl.value;
  if (!el) return;
  syncFollow(
    followCtl.onScroll({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }),
  );
}

/** 拖动滚动条才算滚动意图：点消息正文属选择/复制，不解绑 */
function onMsgsPointerDown(e: PointerEvent): void {
  if (e.target instanceof Element && e.target.closest('.msg-wrap')) return;
  markUserScroll();
}

/** 键盘滚动键（事件绑在 .msgs 上，焦点必在该容器内，天然排除输入框，见 D3） */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar']);
function onMsgsKeydown(e: KeyboardEvent): void {
  if (SCROLL_KEYS.has(e.key)) markUserScroll();
}

/** 点「回到最新」：恢复跟随并平滑回底，同时清掉新内容圆点 */
function jumpToBottom(): void {
  forceScrollBottom({ smooth: true });
}

// 高频事件（llm_stream / tool_call_delta）合并到下一帧：避免逐 chunk 读取 scrollHeight 强制重排
let scrollRaf = 0;
function scrollBottomSoon(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    scrollBottom(); // rAF 在 Vue 的 nextTick 之后执行，读到的 scrollHeight 已是最新
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
    forceScrollBottom(); // 新建会话：强制回底（D6）
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
  if (!dirPath.value) void browseDirs(''); // 缺省 → 服务端缺省空间（最近使用）
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
    // 恢复该会话的模型选择（D7）：列表里的 meta 已带 modelAlias，缺省即跟随全局
    modelAlias.value = '';
    for (const w of workspaces.value) {
      const s = w.sessions.find((x) => x.id === id);
      if (s) {
        modelAlias.value = s.modelAlias ?? '';
        break;
      }
    }
    modelOpen.value = false;
    forceScrollBottom(); // 切换会话：强制回底（D6）；不再保留上一个会话的滚动位置
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
  forceScrollBottom(); // 自己发消息：强制回底（D6）

  // 发送与流式累加在 chat-stream（模块级状态，切换会话/离开聊天页不中断）
  const outcome = await sendMessage(sessionId, {
    message: full,
    text,
    files: chipsSnapshot.map((u) => u.fileName),
    // D2：输入区不再暴露流式开关，恒为流式
    stream: true,
    // D4：会话级模型覆盖（空串 = 不覆盖，走全局）
    modelAlias: modelAlias.value,
  });
  if (outcome === 'failed') {
    // 请求未成功：恢复输入，用户可直接重试（D7：此处不释放缩略图 URL，恢复后仍要能显示）
    uploads.value = chipsSnapshot;
    setDraft(draftSnapshot);
  } else {
    // 发送成功：此时 chip 已被清空，缩略图不再需要（D7）
    releaseChips(chipsSnapshot);
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

/* ===== 粘贴附件（task-20261028-005）=====
 * 截图与资源管理器复制的文件都落在 paste.clipboardData.files（实测见需求台账），
 * 故只有一条收集路径；纯文本粘贴（files 为空）必须原样放行，绝不 preventDefault。 */

/** 视觉链路门控配置：GET /vision 的 available（已含 enabled=false 与无 Key 两种判定）+ 图片字节上限 */
const visionGate = ref<VisionGate | null>(null);
let visionGateLoading: Promise<VisionGate | null> | null = null;

/** 惰性加载一次并缓存（D8）；失败降级为 null → 不显示警告、不阻断上传 */
async function loadVisionGate(): Promise<VisionGate | null> {
  if (visionGate.value) return visionGate.value;
  if (visionGateLoading) return visionGateLoading;
  visionGateLoading = (async () => {
    try {
      const [st, maxBytes] = await Promise.all([
        api<{ available: boolean; reason?: string }>('/vision'),
        api<{ value: unknown }>(`/config/${encodeURIComponent('vision.maxImageBytes')}`),
      ]);
      const n = Number(maxBytes.value);
      const gate: VisionGate = {
        available: st.available === true,
        ...(st.reason ? { unavailableReason: st.reason } : {}),
        maxImageBytes: Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024,
      };
      visionGate.value = gate;
      return gate;
    } catch {
      return null; // 配置读不到不该阻止用户传图
    } finally {
      visionGateLoading = null;
    }
  })();
  return visionGateLoading;
}

/** 释放单个 chip 的缩略图 URL（幂等） */
function releaseChip(u: UploadChip): void {
  if (!u.thumbUrl) return;
  try {
    URL.revokeObjectURL(u.thumbUrl);
  } catch {
    // 环境不支持 revokeObjectURL 时忽略（不影响功能）
  }
  u.thumbUrl = undefined;
}

/** 批量释放（D7：仅在发送成功 / 删除 chip / 清空 / 卸载四处调用；发送失败不释放） */
function releaseChips(list: readonly UploadChip[]): void {
  for (const u of list) releaseChip(u);
}

/** 输入框粘贴：有文件才接管（D1），无文件一律走浏览器默认文本粘贴（D2） */
async function onPaste(ev: ClipboardEvent): Promise<void> {
  const pasted = collectPasteFiles(ev.clipboardData);
  if (pasted.length === 0) return; // 纯文本粘贴：不拦、不提示
  ev.preventDefault();
  if (streaming.value) {
    showToast('当前会话正在生成回复，请先停止', 'error');
    return;
  }
  if (upBusy.value) {
    showToast('已有附件正在上传，请稍候', 'error');
    return;
  }
  const { accepted, dropped } = capPasteFiles(pasted);
  if (dropped > 0) showToast(`单次最多 ${PASTE_MAX_FILES} 个附件，已忽略 ${dropped} 个`, 'error');
  const sessionId = await ensureSession();
  if (!sessionId) return;
  const gate = await loadVisionGate();
  upBusy.value = true;
  try {
    for (const p of accepted) {
      try {
        const r = await uploadRaw(p.file, sessionId, p.name);
        const chip: UploadChip = {
          id: ++chipSeq,
          fileName: r.fileName,
          bytes: r.bytes,
          contextNote: r.contextNote,
        };
        if (p.isImage) chip.thumbUrl = URL.createObjectURL(p.file);
        const warn = gate ? visionSkipReason(p.name, p.file.type, p.file.size, gate) : null;
        if (warn) chip.warn = warn;
        uploads.value.push(chip);
        showToast(`已粘贴 → ${r.fileName}（${fmtBytes(r.bytes)}）`, 'success');
      } catch (e) {
        if (e instanceof AuthError) break;
        showToast(`上传失败 ${p.name}: ${errText(e)}`, 'error');
      }
    }
  } finally {
    upBusy.value = false;
  }
}

function removeChip(u: UploadChip): void {
  releaseChip(u);
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
      releaseChips(uploads.value);
      uploads.value = [];
      showToast('上传目录已清空', 'success');
    } catch (e) {
      if (!(e instanceof AuthError)) showToast(errText(e), 'error');
    }
  })();
}

// 活跃会话同步给 chat-stream：离开聊天页时 run 完成要记未读并提示
watch(activeId, (v) => setActiveSession(v));

// Esc 关闭浮层（window 级监听：焦点可能落在弹窗内输入框，元素级 @keydown 不可靠）
// 优先级：新建会话弹窗 > 模型面板 > 上传面板（task-20261025-002 D9 要求 Esc 可关模型面板）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (newPopOpen.value) {
    closeNewPop();
    return;
  }
  if (modelOpen.value) {
    modelOpen.value = false;
    return;
  }
  if (upPopOpen.value) upPopOpen.value = false;
}

let offRunFinished: (() => void) | null = null;

/* ===== 自增高（task-20261025-002 P0 ②）===== */
const taEl = ref<HTMLTextAreaElement | null>(null);

/** 按内容重算高度：夹取到 [44, 200]，超出后内部滚动 */
function autoGrow(): void {
  const el = taEl.value;
  if (!el) return;
  // 先归零再读 scrollHeight，否则缩小时会保留上一次的大高度
  el.style.height = 'auto';
  el.style.height = `${nextTextareaHeight(el.scrollHeight)}px`;
}

/** 写入草稿后同步高度（如点附件补全文本、清空草稿） */
function setDraft(v: string): void {
  draft.value = v;
  void nextTick(autoGrow);
}

/* ===== 会话级模型选择 ===== */

/** 拉取登记簿（懒加载一次）；失败时 pill 禁用但不阻塞发消息（D8） */
async function loadModels(): Promise<void> {
  if (modelProfiles.value.length > 0) return;
  try {
    const res = await api<{ profiles: ModelProfileRow[]; active: string | null }>('/models');
    modelProfiles.value = res.profiles ?? [];
    modelActive.value = res.active ?? null;
    modelLoadFailed.value = false;
  } catch {
    modelLoadFailed.value = true;
    showToast('模型列表加载失败，本次将使用全局模型', 'error');
  }
}

/** 展开/收起面板：与上传浮层互斥；展开时懒加载列表 */
function toggleModelPop(): void {
  if (streaming.value || modelLoadFailed.value) return;
  modelOpen.value = !modelOpen.value;
  if (modelOpen.value) {
    upPopOpen.value = false;
    void loadModels();
  }
}

/** 选择某模型作为本会话所用（选到全局项时等价于「跟随全局」） */
function selectModel(alias: string): void {
  modelAlias.value = alias === (modelActive.value ?? '') ? '' : alias;
  modelOpen.value = false;
  void persistModelAlias();
}

/** 复位为跟随全局 */
function followGlobal(): void {
  modelAlias.value = '';
  modelOpen.value = false;
  void persistModelAlias();
}

/** 写入会话元数据（D7：单独写，不混进每轮 updateSession） */
async function persistModelAlias(): Promise<void> {
  const id = activeId.value;
  if (!id) return;
  const alias = modelAlias.value || null;
  try {
    await api(`/sessions/${encodeURIComponent(id)}/model`, {
      method: 'PUT',
      json: { modelAlias: alias },
    });
    // 同步内存列表：否则同页内「切到别的会话再切回」时 selectSession 仍从
    // workspaces 里的旧 meta 取值，pill 会退回全局（只有刷新才恢复），
    // 让用户以为选择丢了——服务端其实已存。
    for (const w of workspaces.value) {
      const s = w.sessions.find((x) => x.id === id);
      if (s) {
        s.modelAlias = alias ?? undefined;
        break;
      }
    }
  } catch {
    // 落盘失败不打断对话：本次仍按内存选择生效
    showToast('模型选择未能保存，仅本次生效', 'error');
  }
}

/** 面板外部点击关闭（D9）：忽略控制条自身，避免「点开即关」 */
function onDocClick(e: MouseEvent): void {
  if (!modelOpen.value) return;
  const el = modelPillEl.value;
  if (el && e.target instanceof Node && el.contains(e.target)) return;
  modelOpen.value = false;
}

onMounted(() => {
  setChatViewMounted(true);
  setActiveSession(activeId.value);
  // 流式事件到达时仅活跃会话滚动（组件卸载后 handler 置空，run 不受影响）
  // task-20261027-004：先喂跟随状态机——released 态只点亮「新内容」圆点，不拽回视口
  setActivityHandler((id) => {
    if (id !== activeId.value) return;
    syncFollow(followCtl.onActivity());
    scrollBottomSoon();
  });
  offRunFinished = onRunFinished((id) => {
    if (id === activeId.value) {
      // run 结束仅在 pinned 时回底；released 时保持阅读位置（用户正在读的内容不该被抢走）
      scrollBottom();
      syncFollow(followCtl.onActivity());
      void postRenderMsgs();
    }
  });
  // 会话切换/新建弹窗依赖本组件的流式与消息状态，注册给 App 侧栏委托调用
  registerChatBridge({ select: (id) => void selectSession(id), openNewPop });
  window.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('click', onDocClick);
  void loadSessions();
  void loadModels();
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
  document.removeEventListener('click', onDocClick);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  clearRenderTimer(); // 流式图表渲染的节流定时器
  releaseChips(uploads.value); // 粘贴附件的缩略图 blob URL（task-20261028-005 D7）
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

      <!-- 消息滚动区（task-20261027-004）：外层只为给「回到最新」按钮提供定位上下文，
           避免按钮 absolute 到 .chat-main 时压住输入坞（composer 高度随自增高变化） -->
      <div class="msgs-wrap">
        <div
          ref="msgsEl"
          class="msgs"
          tabindex="0"
          @scroll="onMsgsScroll"
          @wheel.passive="markUserScroll"
          @touchmove.passive="markUserScroll"
          @pointerdown="onMsgsPointerDown"
          @keydown="onMsgsKeydown"
        >
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
                  <ToolCard
                    v-if="it.kind === 'tool'"
                    :card="cardVM(it)"
                    :ws-root="activeWsPath"
                    @open-path="onOpenPath"
                  />
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
        <!-- 回到最新（D5）：仅在解绑（用户上滑阅读中）出现；有新 chunk 时右上角点圆点提示 -->
        <button
          v-if="follow === 'released'"
          class="jump-bottom"
          :class="{ pending: hasPending }"
          title="回到最新"
          aria-label="回到最新"
          @click="jumpToBottom"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path
              d="M10 4.6v9.8M5.7 10.3 10 14.6l4.3-4.3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div class="composer">
        <div class="composer-inner">
          <div class="dock">
            <!-- 附件 pill（task-20261025-002 ③）：SVG + 文件名 + 大小 + 圆形删除 -->
            <div v-if="uploads.length" class="chips">
              <span
                v-for="u in uploads"
                :key="u.id"
                class="file-pill"
                :class="{ 'is-img': u.thumbUrl }"
                :title="u.contextNote + '（将随下一条消息注入）'"
              >
                <img v-if="u.thumbUrl" class="fp-thumb" :src="u.thumbUrl" alt="" />
                <svg v-else class="fp-ic" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path
                    d="M10.6 4.6 6.2 9a1.6 1.6 0 0 0 2.3 2.3l4.6-4.6a3 3 0 0 0-4.2-4.2L4.2 7.2a4.4 4.4 0 0 0 6.2 6.2l3.3-3.3"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
                <span class="fp-name">{{ u.fileName }}</span>
                <span class="fp-size">{{ fmtBytes(u.bytes) }}</span>
                <span v-if="u.warn" class="fp-warn" :title="u.warn" role="img" aria-label="视觉可用性警告">⚠</span>
                <button class="fp-x" title="移除（不再注入，服务器文件保留）" @click="removeChip(u)">
                  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
              </span>
            </div>

            <textarea
              ref="taEl"
              v-model="draft"
              class="gw"
              rows="1"
              placeholder="输入消息…"
              @input="autoGrow"
              @keydown.enter="onEnter"
              @paste="onPaste"
              @compositionstart="setComposing(true)"
              @compositionend="setComposing(false)"
            ></textarea>

            <div class="tool-row">
              <button
                class="tbtn"
                title="上传文件"
                :disabled="streaming"
                @click="toggleUpPop"
              >
                <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
                  <path
                    d="M13.2 5.9 7.8 11.3a2 2 0 0 0 2.8 2.8l5.4-5.4a3.6 3.6 0 0 0-5.1-5.1l-5.5 5.5a5.2 5.2 0 0 0 7.4 7.4l4.1-4.1"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                  />
                </svg>
              </button>

              <!-- 会话级模型选择（task-20261025-002 D4/D8/D9） -->
              <div ref="modelPillEl" class="model-wrap">
                <button
                  class="model-pill"
                  :class="{ pinned: pill.pinned, muted: modelLoadFailed }"
                  :disabled="streaming || modelLoadFailed"
                  :title="
                    modelLoadFailed
                      ? '模型列表加载失败，本次使用全局模型'
                      : pill.pinned
                        ? `本会话使用 ${pill.label}（不改全局激活）`
                        : '本次对话使用的模型，不改全局激活'
                  "
                  @click="toggleModelPop"
                >
                  <svg class="mp-ic" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M5.6 8h4.8M8 5.6v4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                  </svg>
                  <span class="mp-label">{{ pill.label }}</span>
                  <svg class="mp-chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                    <path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>

                <div v-if="modelOpen" class="model-pop">
                  <div class="mp-head">
                    <b>本次对话使用</b>
                    <span class="mp-cap">不改全局激活模型</span>
                  </div>
                  <button v-if="pill.showFollowGlobal" class="mp-item mp-follow" @click="followGlobal">
                    <span class="mp-alias">跟随全局</span>
                    <span class="mp-sub">恢复为全局激活模型</span>
                  </button>
                  <button
                    v-for="r in rows"
                    :key="r.alias"
                    class="mp-item"
                    :class="{ sel: r.isSelected }"
                    @click="selectModel(r.alias)"
                  >
                    <span class="mp-alias">
                      {{ r.alias }}
                      <span v-if="r.isGlobal" class="mp-badge">全局</span>
                    </span>
                    <span class="mp-sub">{{ r.name }}<template v-if="r.host"> · {{ r.host }}</template></span>
                    <svg v-if="r.isSelected" class="mp-check" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <path d="M2.5 6.4 5 8.9l4.5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                    </svg>
                  </button>
                  <div v-if="rows.length === 0" class="mp-empty">暂无已登记模型（前往「模型」页添加）</div>
                  <p class="mp-foot">只影响本会话后续消息；全局切换仍在「模型」页</p>
                </div>
              </div>

              <span class="kbd-hint">Enter 发送 · Shift+Enter 换行</span>
              <span class="spacer"></span>

              <button v-if="streaming" class="send-btn stop" title="停止本次运行（服务端将中断）" @click="stopGen">
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor" />
                </svg>
              </button>
              <button
                v-else
                class="send-btn"
                :disabled="!draft.trim() && uploads.length === 0"
                title="发送"
                @click="send"
              >
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <path
                    d="M10 15.5V5m0 0L5.6 9.4M10 5l4.4 4.4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
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
                pill ✕ 仅移除不再注入，「清空全部」删除服务器上传目录。
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
    </div>

    <!-- ===== 工作空间文件浏览器（对话右侧，v-model 控制展开） ===== -->
    <FilesView ref="filesRef" v-model:open="filesOpen" :ws-path="activeWsPath" />

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
/* 外层只承担「回到最新」按钮的定位上下文（task-20261027-004）：
   composer 高度随输入自增高变化，按钮若 absolute 到 .chat-main 会压住输入坞，
   故定位基准收在这一层（等价于滚动区可视范围） */
.msgs-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 0;
  /* 显式开启滚动锚定（D4）：postRenderMsgs 的高亮与图表槽位渲染会改变块高度，
     用户解绑阅读时由浏览器校正位置，避免已读内容漂移 */
  overflow-anchor: auto;
  /* 程序化聚焦不显示轮廓；仅键盘 Tab 进入时可见（见 :focus-visible） */
  outline: none;
}
.msgs:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

/* 回到最新（D5）：解绑态浮于滚动区右下角，不占文档流、不遮挡输入坞 */
.jump-bottom {
  position: absolute;
  right: 18px;
  bottom: 14px;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  box-shadow: var(--shadow-pop);
  cursor: pointer;
  z-index: 5;
  transition: color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
}
.jump-bottom:hover {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
}
.jump-bottom:active { transform: scale(0.94); }
/* 解绑期间有新内容：右上角品牌色圆点（不计数——单条消息在增长，条数无意义） */
.jump-bottom.pending::after {
  content: '';
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 2px var(--panel);
}
@media (prefers-reduced-motion: reduce) {
  .jump-bottom { transition: none; }
}
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

/* ===== 输入区（task-20261025-002：一体卡片输入坞）===== */
.composer {
  /* 去掉上沿分隔线（症状⑤）：由 dock 卡片自身描边表达边界 */
  background: var(--bg);
  /* 左右内边距下移到 .composer-inner：container-type 定义在本元素上，
     @container 只能改「后代」——写在本元素上的 padding 永远命中不了（隐含坑） */
  padding: 10px 0 14px;
  /* 容器查询基准：按对话区实际宽度做窄容器兼容 */
  container-type: inline-size;
}
/* 840 = 800 内容宽 + 左右各 20 内边距，与原「composer 20px + inner 800」等效 */
.composer-inner { max-width: 840px; margin: 0 auto; position: relative; padding: 0 20px; }

/* 一体卡片：底 + 描边 + 阴影；focus-within 转品牌色描边 + 3px 光晕 */
.dock {
  /* 浅色：面板白 + 极浅描边；深色由下方覆盖为 --bar-bg + --line */
  --dock-bg: var(--panel);
  --dock-line: var(--line-soft);
  background: var(--dock-bg);
  border: 1px solid var(--dock-line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: 8px 8px 6px;
  position: relative;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.dock:focus-within {
  border-color: var(--brand);
  box-shadow: var(--shadow-card), 0 0 0 3px var(--brand-weak);
}
/* 深色：卡底比对话区略亮，描边用常规 line（与原型一致） */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .dock {
    --dock-bg: var(--bar-bg);
    --dock-line: var(--line);
  }
}
:root[data-theme='dark'] .dock {
  --dock-bg: var(--bar-bg);
  --dock-line: var(--line);
}

/* 无边框自增高输入域（②）：44px 起，200px 封顶后内部滚动 */
.composer .gw {
  display: block;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.5;
  height: 44px;
  min-height: 44px;
  max-height: 200px;
  padding: 8px 8px 4px;
  overflow-y: auto;
}
.composer .gw::placeholder { color: var(--muted); }

/* 工具行：附件 · 模型 pill · 快捷键提示 · 发送 */
.tool-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
  min-width: 0;
}
.tool-row .spacer { flex: 1 1 auto; min-width: 0; }

/* 图标按钮（附件）：28×28，悬停浅底 */
.tbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  border-radius: var(--radius-ctl);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.tbtn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.tbtn:disabled { opacity: 0.45; cursor: not-allowed; }

/* ===== 会话级模型 pill 与面板（D8/D9）===== */
.model-wrap { position: relative; flex: none; min-width: 0; }
.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 190px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text-2);
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.model-pill:hover:not(:disabled) { background: var(--hover); }
.model-pill:disabled { opacity: 0.5; cursor: not-allowed; }
.model-pill.muted { color: var(--muted); }
/* 覆盖全局：转品牌色（不需额外图标也一眼可辨） */
.model-pill.pinned {
  background: var(--brand-weak);
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}
.model-pill .mp-ic, .model-pill .mp-chev { flex: none; opacity: 0.85; }
.model-pill .mp-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 向上展开面板 */
.model-pop {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 292px;
  max-width: min(292px, 78vw);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-pop);
  padding: 8px;
  z-index: 30;
}
.mp-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px 8px;
  border-bottom: 1px solid var(--line-soft);
  margin-bottom: 6px;
}
.mp-head b { font-size: 12.5px; }
.mp-head .mp-cap { font-size: 11px; color: var(--muted); }
.mp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  background: none;
  border-radius: var(--radius-ctl);
  text-align: left;
  cursor: pointer;
  color: var(--text);
}
.mp-item:hover { background: var(--hover); }
.mp-item.sel { background: var(--brand-weak); }
.mp-item .mp-alias {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  flex: none;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-badge {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--hover);
  color: var(--muted);
}
.mp-item .mp-sub {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-check { flex: none; color: var(--brand); }
.mp-follow {
  border-bottom: 1px solid var(--line-soft);
  border-radius: var(--radius-ctl) var(--radius-ctl) 0 0;
  margin-bottom: 4px;
}
.mp-follow .mp-alias { color: var(--brand); }
.mp-empty { padding: 10px 8px; font-size: 11.5px; color: var(--muted); }
.mp-foot {
  margin: 6px 2px 0;
  padding-top: 6px;
  border-top: 1px solid var(--line-soft);
  font-size: 10.5px;
  color: var(--muted);
  line-height: 1.5;
}

/* 快捷键常驻提示 */
.kbd-hint {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 发送 / 停止同位置切换（③）：32×32 图标按钮 */
.send-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--brand);
  color: var(--brand-on);
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease;
}
.send-btn:hover:not(:disabled) { opacity: 0.88; }
.send-btn:disabled { background: var(--line-strong); color: var(--panel); cursor: not-allowed; }
.send-btn.stop { background: var(--danger); color: #fff; }

/* 窄容器两档（D10）：≤440 隐提示、≤380 收内边距且只省略 alias */
@container (max-width: 440px) {
  .kbd-hint { display: none; }
}
@container (max-width: 380px) {
  .composer-inner { padding-left: 12px; padding-right: 12px; }
  .dock { padding: 6px 6px 4px; }
  .model-pill { max-width: 108px; }
  .model-pill .mp-ic { display: none; }
}

/* ===== 上传 pill 与面板 ===== */
.chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 4px 4px; }
.file-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 4px 2px 8px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-2);
}
.file-pill .fp-ic { flex: none; color: var(--muted); }
/* 图片 chip：24×24 缩略图（task-20261028-005 D6），左内边距收紧保持与文本 chip 同高 */
.file-pill.is-img { padding-left: 3px; }
.file-pill .fp-thumb {
  flex: none;
  width: 24px;
  height: 24px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--panel);
}
/* 视觉可用性警告角标（D8）：只着色，不改 chip 主色，原因走 title */
.file-pill .fp-warn { flex: none; color: var(--warn); font-size: 11px; line-height: 1; cursor: help; }
.file-pill .fp-name {
  min-width: 0;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-pill .fp-size { flex: none; color: var(--muted); font-size: 10.5px; }
.file-pill .fp-x {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.file-pill .fp-x:hover { background: var(--danger-weak); color: var(--danger); }

.up-pop {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 8px);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-pop);
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