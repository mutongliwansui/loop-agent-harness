<script setup lang="ts">
// ChatView：会话 CRUD + SSE 流式对话 + 停止生成 + 对话内上传（Task-20261017-001 D5/D7）
// 端点映射：
//   GET    /workspaces          → 左侧会话列表（按工作空间分组聚合，顺序稳定：按空间首次使用时间升序）
//   POST   /sessions            → 新建会话（body 可带 workspacePath 异空间切换；发送前无会话时也自动创建）
//   GET    /fs/dirs             → 服务端目录浏览（新建弹窗「浏览磁盘」；纯 Web 拿不到本地目录绝对路径）
//   GET    /sessions/:id        → 恢复历史消息（{meta, messages, workspace}；跨空间会话自动切换到其所在空间）
//   DELETE /sessions/:id        → 删除（二次确认；in-flight 409；支持跨工作空间会话）
//   POST   /sessions/:id/messages → 发消息（默认 SSE；stream:false 非流式 JSON；跨空间会话自动切换空间）
//   POST   /uploads/raw         → 📎 文件选择框上传 → chip（contextNote 随下一条消息注入）
//   DELETE /uploads             → 上传面板「清空全部」（二次确认）
// 停止生成：AbortController 中断 fetch（服务端照常完成并持久化，停止后刷新列表）
// mermaid：流式结束/历史加载后对 ```mermaid 代码块后处理渲染为 SVG（动态 import 独立 chunk；
//          主题跟随 prefers-color-scheme；解析失败保留代码块并标红）
//          交互：工具栏 放大/缩小/适应宽度/全屏 + 滚轮缩放（以视口中心为锚）

import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, AuthError, uploadRaw } from '../api/client.js';
import { sseFetch, type SseEvent } from '../api/sse.js';
import { showToast } from '../toast.js';

interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
interface WorkspaceGroup {
  id: string;
  name: string;
  path: string;
  current: boolean;
  createdAt: string;
  lastAccessedAt: string;
  sessions: SessionMeta[];
}
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
}
interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  segments: Segment[]; // 按序渲染形成 思考→命令→思考→命令→总结 的完整过程
  files?: string[]; // 该消息附带的上传文件名（仅用户消息展示）
  streaming?: boolean;
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

const workspaces = ref<WorkspaceGroup[]>([]);
const collapsedWs = ref<Set<string>>(new Set());
const sessKw = ref('');
const activeId = ref<string | null>(null);
const messages = ref<ChatMsg[]>([]);
const draft = ref('');
const streaming = ref(false);
const streamChk = ref(true);
const uploads = ref<UploadChip[]>([]);
const upPopOpen = ref(false);
const upBusy = ref(false);
const upCleanArmed = ref(false);
const delArmedId = ref<string | null>(null);
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
const foreignActive = computed(() => activeWs.value !== null && !activeWs.value.current);
const filteredGroups = computed(() => {
  const kw = sessKw.value.trim().toLowerCase();
  if (!kw) return workspaces.value;
  return workspaces.value
    .map((w) => {
      if (w.name.toLowerCase().includes(kw) || w.path.toLowerCase().includes(kw)) return w;
      const hit = w.sessions.filter((s) => (s.title || '').toLowerCase().includes(kw));
      return hit.length > 0 ? { ...w, sessions: hit } : null;
    })
    .filter((w): w is WorkspaceGroup => w !== null);
});

let msgSeq = 0;
let chipSeq = 0;
let abortCtrl: AbortController | null = null;
let composing = false; // 中文输入法组词中的 Enter 不发送

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function renderMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/* ================= mermaid 后处理渲染 ================= */
// 流式期间 segments 文本段逐 chunk 变化触发 v-html 重渲，不能边流边渲；
// 只在流式结束（send finally）或历史加载（selectSession）后，把 marked 输出的
// <pre><code class="language-mermaid"> 替换为 mermaid SVG。失败保留代码块。

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null;
let mermaidSeq = 0;
let mermaidQueue: Promise<void> = Promise.resolve(); // 串行排队，避免并发调用 mermaid.render

function renderMermaidDiagrams(): Promise<void> {
  mermaidQueue = mermaidQueue.then(() => renderMermaidInMsgs());
  return mermaidQueue;
}

/** 构建 mermaid 图表容器：工具栏（放大/缩小/适应宽度/全屏）+ 滚轮缩放 + 视口滚动 */
function buildMermaidBox(svgMarkup: string): { el: HTMLDivElement; fit: () => void } {
  const el = document.createElement('div');
  el.className = 'mermaid-block';
  el.innerHTML =
    '<div class="mmd-bar">' +
    '<span class="mmd-cap">mermaid</span>' +
    '<span class="mmd-spring"></span>' +
    '<button type="button" data-act="in" title="放大">＋</button>' +
    '<button type="button" data-act="out" title="缩小">－</button>' +
    '<button type="button" data-act="fit" title="适应宽度">100%</button>' +
    '<button type="button" data-act="fs" title="全屏">⛶</button>' +
    '</div>' +
    '<div class="mmd-view"><div class="mmd-stage">' +
    svgMarkup +
    '</div></div>';
  const view = el.querySelector<HTMLElement>('.mmd-view')!;
  const svgEl = el.querySelector<SVGSVGElement>('svg')!;
  const fitBtn = el.querySelector<HTMLButtonElement>('[data-act=fit]')!;

  // 基准尺寸取 viewBox（mermaid 恒有输出；attr width 常为 100% 不可用）
  const vb = svgEl.viewBox.baseVal;
  const baseW = vb.width || parseFloat(svgEl.getAttribute('width') || '') || 0;
  const baseH = vb.height || parseFloat(svgEl.getAttribute('height') || '') || 0;
  const zoomable = baseW > 0 && baseH > 0;
  let scale = 1;

  const apply = (s: number): void => {
    scale = Math.min(5, Math.max(0.2, s));
    svgEl.style.maxWidth = 'none';
    svgEl.style.width = `${baseW * scale}px`;
    svgEl.style.height = `${baseH * scale}px`;
    fitBtn.textContent = `${Math.round(scale * 100)}%`;
    // 内容超出视口才可拖拽平移（grab 光标）
    view.classList.toggle(
      'pan-able',
      view.scrollWidth > view.clientWidth || view.scrollHeight > view.clientHeight,
    );
  };

  /** 以视口中心为锚缩放，避免缩放后视点漂移 */
  const zoomTo = (next: number): void => {
    if (!zoomable) return;
    const prev = scale;
    const r = view.getBoundingClientRect();
    const cx = view.scrollLeft + r.width / 2;
    const cy = view.scrollTop + r.height / 2;
    apply(next);
    view.scrollLeft = (cx * scale) / prev - r.width / 2;
    view.scrollTop = (cy * scale) / prev - r.height / 2;
  };

  /** 适应容器宽度（不放大超过 100%） */
  const fit = (): void => {
    if (!zoomable) return;
    apply(Math.min(1, (view.clientWidth - 24) / baseW)); // 24 = .mmd-view 左右 padding
    view.scrollLeft = 0;
    view.scrollTop = 0;
  };

  el.querySelector('[data-act=in]')!.addEventListener('click', () => zoomTo(scale * 1.25));
  el.querySelector('[data-act=out]')!.addEventListener('click', () => zoomTo(scale / 1.25));
  fitBtn.addEventListener('click', fit);
  el.querySelector('[data-act=fs]')!.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  });
  el.addEventListener('fullscreenchange', fit); // 进出全屏视口宽度变化，重算适应宽度
  view.addEventListener(
    'wheel',
    (e) => {
      if (!zoomable) return;
      e.preventDefault(); // 劫持滚轮用于缩放
      zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false },
  );
  // 拖拽平移：按住左键拖动同步视口滚动（grab & pan）；触摸设备走原生滚动
  view.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (view.scrollWidth <= view.clientWidth && view.scrollHeight <= view.clientHeight) return;
    e.preventDefault(); // 阻止拖拽选中文本
    const startX = e.clientX;
    const startY = e.clientY;
    const sl = view.scrollLeft;
    const st = view.scrollTop;
    view.classList.add('panning');
    view.setPointerCapture(e.pointerId); // 移出视口仍持续跟踪
    const onMove = (ev: PointerEvent): void => {
      view.scrollLeft = sl - (ev.clientX - startX);
      view.scrollTop = st - (ev.clientY - startY);
    };
    const onUp = (): void => {
      view.classList.remove('panning');
      view.removeEventListener('pointermove', onMove);
      view.removeEventListener('pointerup', onUp);
      view.removeEventListener('pointercancel', onUp);
    };
    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp);
    view.addEventListener('pointercancel', onUp);
  });
  if (!zoomable) {
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-act=in],[data-act=out],[data-act=fit]')) {
      b.disabled = true;
    }
  }
  return { el, fit };
}

async function renderMermaidInMsgs(): Promise<void> {
  const root = msgsEl.value;
  if (!root) return;
  await nextTick();
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  if (blocks.length === 0) return;
  try {
    mermaidPromise ??= import('mermaid').then((m) => m.default);
    const mermaid = await mermaidPromise;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    });
    for (const code of blocks) {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== 'PRE') continue; // v-html 重渲后已被替换/移除
      const id = `mmd-svg-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, code.textContent ?? ''); // strict 模式下 mermaid 内部已 sanitize
        const box = buildMermaidBox(svg);
        pre.replaceWith(box.el);
        box.fit(); // 已插入 DOM 后才能测量视口宽度
      } catch {
        // mermaid v11 render 失败时会遗留错误占位元素，需手动清理
        document.getElementById(`d${id}`)?.remove();
        pre.classList.add('mermaid-err'); // 解析失败：保留代码块并标红
      }
    }
  } catch {
    // mermaid 动态加载失败：静默保留代码块形态
  }
}

function scrollBottom(): void {
  nextTick(() => {
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ================= 会话列表（按工作空间分组） ================= */

const WS_COLORS = ['#0e9f6e', '#4f46e5', '#b45309', '#0e7490', '#be185d', '#7c3aed'];

function wsColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = h * 31 + name.charCodeAt(i);
  return WS_COLORS[Math.abs(h) % WS_COLORS.length];
}

function toggleWs(id: string): void {
  const next = new Set(collapsedWs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedWs.value = next;
}

async function loadSessions(): Promise<void> {
  try {
    const r = await api<{ workspaces: WorkspaceGroup[] }>('/workspaces');
    workspaces.value = r.workspaces;
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(errText(e), 'error');
  }
}

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
    if (m.role === 'user') {
      flush();
      out.push({ id: ++msgSeq, role: 'user', segments: [{ type: 'text', text: m.content ?? '' }] });
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
  if (id === activeId.value) return;
  if (streaming.value) {
    showToast('正在生成回复，请先停止', 'error');
    return;
  }
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
    void renderMermaidDiagrams();
    if (switched) showToast(`已切换工作空间：${r.workspace?.path}`, 'success');
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(errText(e), 'error');
  }
}

function onDelSession(s: SessionMeta): void {
  if (delArmedId.value !== s.id) {
    delArmedId.value = s.id; // 动词即确认：二次点击
    setTimeout(() => {
      if (delArmedId.value === s.id) delArmedId.value = null;
    }, 2600);
    return;
  }
  delArmedId.value = null;
  void (async () => {
    try {
      await api(`/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      for (const w of workspaces.value) {
        const i = w.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) {
          w.sessions.splice(i, 1);
          break;
        }
      }
      if (activeId.value === s.id) {
        activeId.value = null;
        messages.value = [];
      }
      showToast('会话已删除', 'success');
    } catch (e) {
      if (e instanceof AuthError) return;
      showToast((e as { code?: string }).code === 'busy' ? '会话正在处理消息，暂不能删除' : errText(e), 'error');
    }
  })();
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
    void renderMermaidDiagrams(); // 流式/非流式/停止/失败统一在此渲染 mermaid
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

onMounted(() => {
  void loadSessions();
});
</script>

<template>
  <div class="chat">
    <!-- ===== 会话侧栏 ===== -->
    <aside class="sess-panel">
      <div class="h">
        <b>会话</b>
        <button class="primary new" :disabled="streaming" @click="openNewPop">＋ 新建</button>
      </div>
      <div class="sess-filter">
        <span class="ico">🔍</span>
        <input v-model="sessKw" type="text" placeholder="搜索会话 / 工作空间">
      </div>
      <div class="sess-list">
        <div
          v-for="w in filteredGroups"
          :key="w.id"
          class="ws-group"
          :class="{ collapsed: collapsedWs.has(w.id) }"
        >
          <div class="ws-head" :title="w.path" @click="toggleWs(w.id)">
            <span class="arrow">▼</span>
            <span class="dot" :style="{ background: wsColor(w.name) }"></span>
            <span class="nm">{{ w.name }}</span>
            <span v-if="w.current" class="cur">当前</span>
            <span class="cnt">{{ w.sessions.length }}</span>
          </div>
          <div
            v-for="s in w.sessions"
            :key="s.id"
            class="sess"
            :class="{ active: s.id === activeId }"
            @click="selectSession(s.id)"
          >
            <div class="t">
              <div class="n">{{ s.title || '新会话' }}</div>
              <div class="s">{{ s.messageCount }} 条 · {{ fmtTime(s.updatedAt) }}</div>
            </div>
            <button
              class="del"
              :class="{ armed: delArmedId === s.id }"
              :title="delArmedId === s.id ? '再次点击确认删除' : '删除会话'"
              @click.stop="onDelSession(s)"
            >
              {{ delArmedId === s.id ? '确认？' : '🗑' }}
            </button>
          </div>
        </div>
        <div v-if="filteredGroups.length === 0" class="empty">
          {{ sessKw.trim() ? '无匹配会话' : '暂无会话' }}
        </div>
      </div>
    </aside>

    <!-- ===== 主区 ===== -->
    <div class="chat-main">
      <div class="chat-head">
        <b>{{ activeMeta?.title || (activeId ? '会话' : '开始新对话') }}</b>
        <span v-if="activeMeta" class="sid">#{{ activeMeta.id }}</span>
        <span v-if="activeWs" class="ws-badge" :title="activeWs.path">📁 {{ activeWs.name }}</span>
        <span v-if="foreignActive" class="ro-badge">只读</span>
        <span class="spacer"></span>
        <span class="muted-hint">{{ streamChk ? 'SSE 流式' : '非流式' }}</span>
      </div>

      <div ref="msgsEl" class="msgs">
        <div class="msg-wrap">
          <div v-if="!activeId && messages.length === 0" class="chat-empty">
            选择左侧会话，或点击「＋ 新建」开始对话
          </div>
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div class="ava">{{ m.role === 'user' ? '你' : 'L' }}</div>
            <div class="bubble">
              <div v-if="m.files?.length" class="msg-files">📎 {{ m.files.join('、') }}</div>
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
              @compositionstart="composing = true"
              @compositionend="composing = false"
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

/* ===== 会话侧栏 ===== */
.sess-panel {
  width: 220px;
  flex: none;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}
.sess-panel .h {
  padding: 12px 12px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sess-panel .h b { font-size: 13px; }
.sess-panel .h .new { padding: 4px 10px; font-size: 12.5px; }
.sess-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}
.sess {
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
.sess:hover { background: var(--bg); }
.sess.active { background: var(--brand-weak); }
.sess .t { flex: 1; min-width: 0; }
.sess .t .n {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sess .t .s { font-size: 11px; color: var(--muted); }
.sess .del {
  visibility: hidden;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  padding: 0 3px;
}
.sess:hover .del { visibility: visible; }
.sess .del:hover, .sess .del.armed { color: var(--danger); }
.sess-list .empty { color: var(--muted); font-size: 12.5px; padding: 10px; text-align: center; }

/* ===== 会话过滤与工作空间分组 ===== */
.sess-filter {
  position: relative;
  margin: 0 12px 6px;
}
.sess-filter .ico {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  opacity: 0.55;
  pointer-events: none;
}
.sess-filter input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 9px 5px 26px;
  font-size: 12.5px;
  border-radius: 7px;
}
.ws-group { margin-bottom: 2px; }
.ws-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 6px 3px;
  cursor: pointer;
  border-radius: 7px;
  user-select: none;
}
.ws-head:hover { background: var(--bg); }
.ws-head .arrow {
  font-size: 9px;
  color: var(--muted);
  transition: transform 0.15s;
  flex: none;
}
.ws-group.collapsed .ws-head .arrow { transform: rotate(-90deg); }
.ws-head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.ws-head .nm {
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.ws-head .cur {
  font-size: 10px;
  color: var(--brand);
  background: var(--brand-weak);
  border-radius: 999px;
  padding: 1px 6px;
  flex: none;
}
.ws-head .cnt {
  font-size: 10.5px;
  color: var(--muted);
  background: var(--bg);
  border-radius: 999px;
  padding: 1px 6px;
  flex: none;
}
.ws-group.collapsed .sess { display: none; }
.ws-group .sess { margin-left: 10px; }
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
}
.chat-head b { font-size: 14px; }
.chat-head .sid {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--muted);
}
.chat-head .spacer { flex: 1; }
.muted-hint { font-size: 12px; color: var(--muted); }

/* ===== 消息流 ===== */
.msgs { flex: 1; overflow-y: auto; padding: 20px 0; }
.msg-wrap { max-width: 780px; margin: 0 auto; padding: 0 20px; }
.chat-empty {
  text-align: center;
  color: var(--muted);
  padding: 48px 0;
  font-size: 13.5px;
}
.msg { margin-bottom: 18px; display: flex; gap: 10px; }
.msg .ava {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}
.msg.user { flex-direction: row-reverse; }
.msg.user .ava { background: var(--bg); border: 1px solid var(--line); }
.msg.assistant .ava { background: var(--brand); color: var(--brand-on); }
.bubble { max-width: 76%; padding: 9px 14px; border-radius: 12px; }
.msg.user .bubble {
  background: var(--brand-weak);
  border-top-right-radius: 4px;
}
.msg.user .plain { white-space: pre-wrap; word-break: break-word; }
.msg.assistant .bubble {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top-left-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.msg .bubble p { margin: 0 0 8px; }
.msg .bubble p:last-child { margin-bottom: 0; }
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
/* mermaid 图表容器：工具栏 + 可缩放视口 */
.md :deep(.mermaid-block) {
  margin: 8px 0;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.md :deep(.mermaid-block .mmd-bar) {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}
.md :deep(.mmd-cap) {
  font-size: 10.5px;
  color: var(--muted);
  font-family: ui-monospace, Consolas, monospace;
  margin-left: 4px;
}
.md :deep(.mmd-spring) { flex: 1; }
.md :deep(.mmd-bar button) {
  border: none;
  background: none;
  color: inherit;
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-family: ui-monospace, Consolas, monospace;
}
.md :deep(.mmd-bar button:hover:not(:disabled)) { background: var(--code-bg); }
.md :deep(.mmd-bar button:disabled) { opacity: 0.4; cursor: default; }
.md :deep(.mermaid-block .mmd-view) {
  padding: 10px 12px;
  overflow: auto;
  max-height: 60vh;
}
.md :deep(.mmd-stage) { min-width: max-content; margin: 0 auto; user-select: none; }
.md :deep(.mmd-view.pan-able) { cursor: grab; }
.md :deep(.mmd-view.panning) { cursor: grabbing; }
.md :deep(.mmd-stage svg) { display: block; }
.md :deep(.mermaid-block:fullscreen) {
  border: none;
  border-radius: 0;
  background: var(--bg);
}
.md :deep(.mermaid-block:fullscreen .mmd-view) { max-height: none; flex: 1; }
.md :deep(pre.mermaid-err) { border-color: var(--danger); }
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
}
.composer-inner { max-width: 780px; margin: 0 auto; position: relative; }
.composer .box { display: flex; gap: 10px; align-items: flex-end; }
.composer textarea {
  flex: 1;
  resize: none;
  height: 44px;
  line-height: 1.5;
  padding: 10px 12px;
}
.composer .attach { height: 44px; padding: 0 12px; font-size: 16px; }
.composer .send { height: 44px; padding: 0 18px; }
.composer .stop { height: 44px; padding: 0 14px; color: var(--danger); border-color: var(--danger); }
.composer .meta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 7px;
  font-size: 12px;
  color: var(--muted);
}
.composer label.chk { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.composer .hint { font-size: 11.5px; }

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

/* ===== 窄屏 ===== */
@media (max-width: 900px) {
  .sess-panel { display: none; }
}
</style>
