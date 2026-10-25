<script setup lang="ts">
// FilesView：工作空间文件浏览器（原型-20261018-001）
// 端点：GET /fs/tree?path=（懒加载单层目录）、GET /fs/file?path=（文本预览）、GET /fs/raw?path=（二进制文档）、
//       GET /fs/search?q=&hidden=1（搜索）、GET /fs/fingerprint（目录指纹轮询，自动刷新）；
//       写操作与下载：DELETE /fs/entry、POST /fs/rename、POST /fs/mkdir、POST /fs/upload、GET /fs/download
//       （优化建议 20261021-005：行内/右键菜单、拖拽上传、删除与覆盖二次确认、目录 zip 下载）
// 布局：v-model:open 面板展开态；默认宽度使对话区恰占 1/3（面板 = 容器 2/3 − 会话侧栏 220px），
//       左缘分割条拖拽调宽（360 ~ 父宽-340），双击复位；左侧预览按类型分流：md 渲染 markdown、
//       html/htm 沙箱 iframe 预览 + 源码、pdf iframe 原生渲染、图片 blob 直显（svg 另附源码模式）、
//       csv/tsv 表格 + 源码、xlsx/xls 多 sheet 表格（SheetJS）、docx 转 HTML（mammoth）、
//       pptx 真渲染（@file-viewer/pptx Web Worker，失败降级占位）、doc 复用 md 渲染管线
//       （后端 word-extractor 提取 + 转 markdown）；ppt 占位提示；其余按代码高亮文本查看。
//       支持预览/源码切换、文内搜索；md 相对链接在预览区内跳转（含 #锚点），外链新标签打开，
//       带「← 返回」栈；右侧工具列（搜索 + 隐藏目录开关 + 文件树，默认收起）。
// 窄屏 ≤900px：浮层 + 遮罩（点击关闭），树列置顶，分割条停用。
// 工作空间路径（wsPath）变化时重置状态并重新加载。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  api,
  deleteFsEntry,
  downloadFsEntry,
  fetchRaw,
  mkdirFs,
  renameFsEntry,
  uploadToWorkspace,
} from '../api/client.js';
import { showToast } from '../toast.js';
import DOMPurify from 'dompurify';
import { highlightIn } from '../markdown.js';
import { renderMermaidIn } from '../mermaid.js';
import { renderEChartsIn } from '../echarts.js';
import { splitStreamBlocks, type Block } from '../stream-blocks.js';
// 终端组件独立文件（Task-20261027-001 D6）：本组件已 2500+ 行，禁止继续内联
import TerminalPanel from '../components/TerminalPanel.vue';
// 纯逻辑下沉：摊平树/搜索分组/高亮/面包屑/字节格式化均在本模块，可被 vitest 直接覆盖（20261026-001 D3/D6/D9）
import {
  crumbOf,
  flattenRows,
  fmtBytes,
  groupHits,
  highlightParts,
  type FsNode,
  type SearchResult,
} from '../fs-tree.js';
// pptx Worker 脚本 URL：库默认按 import.meta.url 相对解析 worker 路径，vite 打包后失效，必须显式传入
import pptxWorkerUrl from '@file-viewer/pptx/worker/pptx.worker.js?url';

/* 内联 SVG 图标表（跟随 currentColor，零依赖不引 icon 库 —— D3/D10）。
   刻意只用两档色相：目录走 --brand、文件走 --muted，不按扩展名上色（原型 note 04）。 */
const ICONS = {
  chevron:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.2 3.6 10.6 8l-4.4 4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.9 4.4c0-.7.6-1.3 1.3-1.3h2.8c.4 0 .8.2 1 .5l.6.8h6.2c.7 0 1.3.6 1.3 1.3v6.5c0 .7-.6 1.3-1.3 1.3H3.2c-.7 0-1.3-.6-1.3-1.3V4.4Z" fill="currentColor" fill-opacity=".14"/><path d="M1.9 4.4c0-.7.6-1.3 1.3-1.3h2.8c.4 0 .8.2 1 .5l.6.8h6.2c.7 0 1.3.6 1.3 1.3v6.5c0 .7-.6 1.3-1.3 1.3H3.2c-.7 0-1.3-.6-1.3-1.3V4.4Z" stroke="currentColor" stroke-width="1.2"/></svg>',
  file:
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.1 2.2h4.6l3.2 3.2v8.4c0 .5-.4.9-.9.9H4.1a.9.9 0 0 1-.9-.9V3.1c0-.5.4-.9.9-.9Z" stroke="currentColor" stroke-width="1.2"/><path d="M8.6 2.4v3.2h3.3" stroke="currentColor" stroke-width="1.2"/></svg>',
  search:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7.1" cy="7.1" r="4.4" stroke="currentColor" stroke-width="1.4"/><path d="m10.6 10.6 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  plus:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  upload:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 10.4V2.9M4.9 5.9 8 2.8l3.1 3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.7 10.4v1.6c0 .7.6 1.3 1.3 1.3h8c.7 0 1.3-.6 1.3-1.3v-1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.2 2.6v2.9h-2.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.8v7.4M4.9 7.1 8 10.2l3.1-3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.9 12.4h10.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  pen:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.9 2.9a1.4 1.4 0 0 1 2 2L5.6 12.2l-2.6.6.6-2.6 7.3-7.3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  trash:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 4.5h9.6M6.4 4.5V3.2c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.3M4.6 4.5l.6 8c0 .4.4.7.8.7h4c.4 0 .8-.3.8-.7l.6-8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dots:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.4" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.6" cy="8" r="1.25"/></svg>',
  eye:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.6 8S4.1 3.9 8 3.9 14.4 8 14.4 8 11.9 12.1 8 12.1 1.6 8 1.6 8Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" stroke-width="1.3"/></svg>',
  copy:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.4" y="2.6" width="8" height="8" rx="1.4" stroke="currentColor" stroke-width="1.3"/><path d="M10.6 12.8c0 .4-.3.7-.7.7H3.3c-.4 0-.7-.3-.7-.7V6.1c0-.4.3-.7.7-.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  warn:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4.6 21 19.4H3L12 4.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="16.6" r=".95" fill="currentColor"/></svg>',
  empty:
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="1.5"/><path d="m15.2 15.2 4.2 4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  // 空目录态专用：空心虚线文件夹（搜索无命中仍用放大镜 empty，语义不同不可混用）
  folderEmpty:
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.2 7c0-1.1.9-2 2-2h3.6c.6 0 1.2.3 1.6.8l.9 1.2h7.5c1.1 0 2 .9 2 2v8.5c0 1.1-.9 2-2 2H5.2c-1.1 0-2-.9-2-2V7Z" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2.4" stroke-linejoin="round"/></svg>',
} as const;

const props = defineProps<{ wsPath: string }>();
const open = defineModel<boolean>('open', { default: true });

/* ================= 预览区标签：文件预览 与 终端 共存 =================
   Task-20261027-001 D6：终端不另开浮层，而是预览区顶部标签行的一等公民。
   activeTab 为 'file' 或终端 id；终端列表只存轻量元数据，
   xterm 实例与 WS 连接由 TerminalPanel 自持（避免 FilesView 继续膨胀）。 */
type TermTab = { id: number; title: string; state: string; shellId?: string };
const terminals = ref<TermTab[]>([]);
const activeTab = ref<'file' | number>('file');
let termSeq = 0;

/** 页签只显示文件名（长路径在 title 里给全） */
function shortName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 终端子组件实例（页签 ✕ 需要主动关闭服务端 PTY，不能只删数组） */
const termPanels = new Map<number, { shutdown(): void }>();

/** 函数式 ref 收集：卸载时 Vue 以 null 调用，正好顺带清理 */
function bindTermPanel(id: number, inst: unknown): void {
  if (inst) termPanels.set(id, inst as { shutdown(): void });
  else termPanels.delete(id);
}

/** 新建终端并激活 */
function newTerminal(): void {
  termSeq += 1;
  terminals.value.push({ id: termSeq, title: '', state: 'connecting' });
  activeTab.value = termSeq;
}

/**
 * 关闭终端页签；若关的是当前页，回落到最后一个终端或文件页。
 *
 * 必须先调用子组件的 shutdown() 真正关掉服务端 PTY：
 * 只从 terminals 数组移除会让 TerminalPanel 走 onBeforeUnmount → dispose()，
 * 那份逻辑只断 WS、不发 close，服务端会话转入 60s 宽限期但**仍占并发名额**，
 * 于是反复开关几次就会「并发终端数已达上限」而界面上一个终端都没有。
 */
function closeTerminal(id: number): void {
  termPanels.get(id)?.shutdown();
  termPanels.delete(id);
  terminals.value = terminals.value.filter((t) => t.id !== id);
  if (activeTab.value === id) {
    const last = terminals.value[terminals.value.length - 1];
    activeTab.value = last ? last.id : 'file';
  }
}

const panelEl = ref<HTMLElement | null>(null);
const viewerEl = ref<HTMLElement | null>(null);
const mdEl = ref<HTMLElement | null>(null); // md 预览容器（mermaid 后处理目标）

/* ================= 树 ================= */
const tree = ref<FsNode[]>([]);
const treeLoading = ref(false);
const treeError = ref('');
const showHidden = ref(false);
const expanded = ref(new Set<string>()); // 展开的目录 path 集合（整体替换实例以触发响应）
const loadedDirs = ref(new Set<string>()); // 子项已拉取过的目录（空目录也记住，避免重复请求）
const loadingDirs = ref(new Set<string>()); // 正在拉取子项的目录

/** 树扁平化为行（仅渲染展开目录的子级）；guides 为各层引导线位图，见 fs-tree.flattenRows */
const rows = computed(() => flattenRows(tree.value, expanded.value));

/** 行尾 meta 文案：目录显示已加载子项数（未展开无数据则不显示），文件显示体积（D5） */
function metaOf(n: FsNode): string {
  if (n.type === 'dir') return n.children ? String(n.children.length) : '';
  return typeof n.size === 'number' ? fmtBytes(n.size) : '';
}

/** 骨架屏行宽序列（12 行，按 --row-h 节奏铺满首屏，D7） */
const SKEL_W = [46, 72, 58, 86, 64, 52, 78, 40, 68, 60, 44, 74];


/** 请求工作空间参数：显式传活跃会话所属空间，后端据此解析 /fs/* 根 */
function wsQuery(): string {
  return props.wsPath ? `&ws=${encodeURIComponent(props.wsPath)}` : '';
}

/** 拉取单个目录的直接子项（懒加载，无深度上限） */
async function fetchDir(path: string): Promise<FsNode[]> {
  const r = await api<{ children: FsNode[]; truncated: boolean }>(
    `/fs/tree?path=${encodeURIComponent(path)}&hidden=${showHidden.value ? 1 : 0}${wsQuery()}`,
  );
  if (r.truncated) showToast('目录条目过多，仅显示前 2000 条', 'warn');
  return r.children ?? [];
}

/** 整树重载序号：wsPath 变化会重置并重载，旧空间在途响应按序号丢弃 */
let treeSeq = 0;

async function loadTree(): Promise<void> {
  const seq = ++treeSeq;
  if (!props.wsPath) {
    treeLoading.value = false;
    tree.value = [];
    return;
  }
  treeLoading.value = true;
  treeError.value = '';
  try {
    const children = await fetchDir(''); // 只拉根目录，子目录按需展开
    if (seq !== treeSeq) return; // 空间已变化，丢弃过期响应
    tree.value = children;
    loadedDirs.value = new Set(['']);
  } catch (e) {
    if (seq !== treeSeq) return;
    tree.value = [];
    treeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === treeSeq) treeLoading.value = false;
  }
}

/** 展开时懒加载子项；失败保留可重试状态 */
async function expandDir(n: FsNode): Promise<void> {
  if (loadedDirs.value.has(n.path) || loadingDirs.value.has(n.path)) return;
  loadingDirs.value = new Set(loadingDirs.value).add(n.path);
  try {
    const children = await fetchDir(n.path);
    n.children = children; // 节点属于深层响应式对象，直接赋值即可触发渲染
    loadedDirs.value = new Set(loadedDirs.value).add(n.path);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    const s = new Set(loadingDirs.value);
    s.delete(n.path);
    loadingDirs.value = s;
  }
}

function onRowClick(n: FsNode): void {
  if (n.type === 'dir') {
    const s = new Set(expanded.value);
    if (s.has(n.path)) {
      s.delete(n.path);
    } else {
      s.add(n.path);
      void expandDir(n); // 已加载则内部直接返回
    }
    expanded.value = s;
  } else {
    void openFile(n.path);
  }
}

/* ================= 自动刷新（目录指纹轮询） ================= */
// 已加载目录按 1s 轮询 GET /fs/fingerprint，只重拉指纹变化的目录；
// 页面隐藏 / 面板收起 / 关闭自动刷新时停表，不留后台请求。

const AUTO_REFRESH_KEY = 'loop_agent_fs_autorefresh';
const autoRefresh = ref(localStorage.getItem(AUTO_REFRESH_KEY) !== '0'); // 默认开启
const refreshing = ref(false);
/** 目录 path → 指纹基线（未记录视为新展开目录，首轮只建基线不重拉） */
const fpSigs = new Map<string, string | null>();
let fpTimer: ReturnType<typeof setInterval> | null = null;
let fpBusy = false;

/** 按 path 在已加载树中定位节点（只遍历已拉取的层级） */
function findNodeByPath(path: string): FsNode | undefined {
  let list = tree.value;
  let node: FsNode | undefined;
  for (const seg of path.split('/')) {
    node = list.find((n) => n.name === seg);
    if (!node) return undefined;
    list = node.children ?? [];
  }
  return node;
}

/** 合并新旧子项：同名目录保留已加载的 children，刷新不丢失展开内容 */
function mergeNodes(prev: FsNode[], next: FsNode[]): FsNode[] {
  const byPath = new Map(prev.map((n) => [n.path, n]));
  return next.map((n) => {
    const old = byPath.get(n.path);
    return old && old.type === 'dir' && old.children ? { ...n, type: 'dir' as const, children: old.children } : n;
  });
}

/** 清理已消失目录的展开/加载记录、指纹基线与选中项 */
function pruneState(): void {
  const alive = (p: string): boolean => p === '' || findNodeByPath(p) !== undefined;
  expanded.value = new Set([...expanded.value].filter(alive));
  loadedDirs.value = new Set([...loadedDirs.value].filter(alive));
  loadingDirs.value = new Set([...loadingDirs.value].filter(alive));
  for (const p of [...fpSigs.keys()]) if (!alive(p)) fpSigs.delete(p);
  if (selected.value && !alive(selected.value)) {
    selected.value = '';
    fileData.value = null;
    fileError.value = '';
    releaseBinary();
  }
}

/** 重拉单个已加载目录（根目录合并后保留子级；目录已删由父级指纹触发移除） */
async function reloadDir(path: string): Promise<void> {
  if (path === '') {
    tree.value = mergeNodes(tree.value, await fetchDir(''));
    return;
  }
  const node = findNodeByPath(path);
  if (!node || node.type !== 'dir') return;
  try {
    node.children = mergeNodes(node.children ?? [], await fetchDir(path));
  } catch {
    // 目录已在刷新间隙被删除：等待父级指纹触发合并移除
  }
}

/** 轮询一次；baseline=true 时仅重建基线 */
async function pollChanges(baseline = false): Promise<void> {
  if (fpBusy || !props.wsPath || document.hidden) return;
  const paths = [...loadedDirs.value];
  if (paths.length === 0) return;
  fpBusy = true;
  try {
    const q = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
    const r = await api<{ dirs: { path: string; sig: string | null }[] }>(
      `/fs/fingerprint?${q}${wsQuery()}`,
    );
    if (baseline || fpSigs.size === 0) {
      for (const d of r.dirs) fpSigs.set(d.path, d.sig);
      return;
    }
    const changed = r.dirs.filter((d) => fpSigs.get(d.path) !== d.sig);
    for (const d of changed) {
      if (!fpSigs.has(d.path) && d.sig !== null) {
        fpSigs.set(d.path, d.sig); // 新展开目录：只建基线，不重拉
        continue;
      }
      if (d.sig === null) {
        // 目录本身消失：重拉父级，由合并结果移除该节点
        const parent = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
        await reloadDir(parent);
        fpSigs.delete(d.path);
      } else {
        await reloadDir(d.path);
        fpSigs.set(d.path, d.sig);
      }
    }
    if (changed.length > 0) pruneState();
  } catch {
    // 轮询失败静默：下一 tick 自然重试，不打断用户操作
  } finally {
    fpBusy = false;
  }
}

/** 手动刷新：重拉所有已加载目录并重建基线 */
async function refreshNow(): Promise<void> {
  if (!props.wsPath || fpBusy || refreshing.value) return;
  fpBusy = true;
  refreshing.value = true;
  try {
    for (const p of [...loadedDirs.value]) await reloadDir(p);
    pruneState();
    fpSigs.clear();
    fpBusy = false; // 交给 pollChanges 自持锁
    await pollChanges(true);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    fpBusy = false;
    refreshing.value = false;
  }
}

function stopAutoRefresh(): void {
  if (fpTimer) clearInterval(fpTimer);
  fpTimer = null;
}

/** 面板展开 + 有空间 + 已开启 + 页面可见时才轮询，其余情况停表 */
function syncAutoRefresh(): void {
  stopAutoRefresh();
  if (!autoRefresh.value || !props.wsPath || !open.value || document.hidden) return;
  fpTimer = setInterval(() => void pollChanges(), 1000);
}

function onVisibilityChange(): void {
  syncAutoRefresh();
  if (!document.hidden) void pollChanges(); // 回到前台立即对齐一次
}

watch([autoRefresh, open, () => props.wsPath], syncAutoRefresh, { immediate: true });
watch(autoRefresh, (v) => localStorage.setItem(AUTO_REFRESH_KEY, v ? '1' : '0'));
document.addEventListener('visibilitychange', onVisibilityChange);

/* ================= 预览 ================= */
const selected = ref('');

/** 树/搜索结果滚动容器（面包屑定位用） */
const sideBodyEl = ref<HTMLElement | null>(null);

/** 面包屑：根名 + 选中文件所在目录链（未选中只显示根名，D9） */
const rootLabel = computed(() => {
  const p = (props.wsPath || '').replace(/[\\/]+$/, '');
  return p ? p.split(/[\\/]/).pop() || p : '工作空间';
});
const crumbs = computed(() => crumbOf(selected.value, rootLabel.value));

/** 面包屑点击：展开该目录链并滚动定位（D9） */
function gotoCrumb(path: string): void {
  const parts = path ? path.split('/') : [];
  const next = new Set(expanded.value);
  for (let k = 1; k <= parts.length; k++) {
    const p = parts.slice(0, k).join('/');
    next.add(p);
    const nd = findNodeByPath(p);
    if (nd) void expandDir(nd); // 已加载则内部直接返回
  }
  expanded.value = next;
  void nextTick(() => {
    const el = sideBodyEl.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  });
}
const fileLoading = ref(false);
const fileError = ref('');
const fileData = ref<{ name: string; bytes: number; truncated: boolean; content: string } | null>(null);

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript', vue: 'xml', html: 'xml', xml: 'xml', svg: 'xml', md: 'markdown',
  json: 'json', css: 'css', scss: 'scss', less: 'less', py: 'python', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp',
  cc: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'bash', ps1: 'powershell', yml: 'yaml',
  yaml: 'yaml', sql: 'sql', php: 'php', swift: 'swift', toml: 'ini', ini: 'ini',
};
function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i + 1).toLowerCase() : '';
}
/** 预览类型分流 */
type ViewKind =
  | 'md' | 'html' | 'pdf' | 'img' | 'svg' | 'csv' | 'tsv' | 'xlsx' | 'xls' | 'docx' | 'doc' | 'pptx' | 'legacy' | 'text';
const IMG_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const BINARY_KINDS: ReadonlySet<ViewKind> = new Set(['pdf', 'img', 'svg', 'xlsx', 'xls', 'docx', 'pptx', 'legacy']);
const MODE_KINDS: ReadonlySet<ViewKind> = new Set(['md', 'html', 'svg', 'csv', 'tsv']); // svg：预览 + 源码
const GRID_KINDS: ReadonlySet<ViewKind> = new Set(['csv', 'tsv', 'xlsx', 'xls']);
const SEARCHABLE_KINDS: ReadonlySet<ViewKind> = new Set(['md', 'docx', 'doc', 'csv', 'tsv', 'xlsx', 'xls']); // svg 预览为图，源码模式自动可搜

function viewKindOf(p: string): ViewKind {
  const e = extOf(p);
  if (e === 'md') return 'md';
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'pdf') return 'pdf';
  if (e === 'svg') return 'svg';
  if (IMG_EXTS.has(e)) return 'img';
  if (e === 'csv') return 'csv';
  if (e === 'tsv') return 'tsv';
  if (e === 'xlsx') return 'xlsx';
  if (e === 'xls') return 'xls';
  if (e === 'docx') return 'docx';
  if (e === 'doc') return 'doc';
  if (e === 'pptx') return 'pptx';
  if (e === 'ppt') return 'legacy';
  return 'text';
}

const kind = computed(() => viewKindOf(selected.value));
const codeLang = computed(() => EXT_LANG[extOf(selected.value)] ?? 'plaintext');
// md/doc 预览的块序列（Task-20261023-002 D9）：与对话流共用 stream-blocks 切分，
// 图表围栏成为 .chart-slot 槽位由 mermaid/echarts 后处理填充；非流式（无 pending 分支）。
const mdBlocks = computed<Block[]>(() =>
  fileData.value && (kind.value === 'md' || kind.value === 'doc')
    ? splitStreamBlocks(fileData.value.content, { streaming: false })
    : [],
);
const viewMode = ref<'prev' | 'src'>('prev'); // 预览 / 源码 切换（md/html/表格类）
const hasModes = computed(() => MODE_KINDS.has(kind.value));
const prevLabel = computed(() => (GRID_KINDS.has(kind.value) ? '表格' : '预览'));
const showGrid = computed(() => GRID_KINDS.has(kind.value) && viewMode.value === 'prev');
const searchable = computed(() => SEARCHABLE_KINDS.has(kind.value) || viewMode.value === 'src');

/* ---- 二进制文档：/fs/raw 拉取后本地解析（Blob/objectURL 需手动释放） ---- */
const binData = ref<Blob | null>(null);
const pdfUrl = ref('');
const imgUrl = ref(''); // 图片（含 svg 预览）objectURL
const docxHtml = ref('');
const sheetNames = ref<string[]>([]);
const activeSheet = ref('');
const grid = ref<string[][]>([]);
const gridCapped = ref(false);
const MAX_GRID_ROWS = 2000;
let workbook: import('xlsx').WorkBook | null = null;
let xlsxMod: typeof import('xlsx') | null = null;
let openSeq = 0; // 打开请求序号：快速连点文件时丢弃过期响应

/* pptx：@file-viewer/pptx 渲染器（动态 import；容器在 fileLoading 结束后才存在，挂载延迟到 openFile） */
const pptxContainer = ref<HTMLElement | null>(null);
const pptxFail = ref(false);
let pptxViewer: { destroy(): void } | null = null;
let pptxBuf: ArrayBuffer | null = null;

const headBytes = computed(() => fileData.value?.bytes ?? binData.value?.size ?? 0);

function releaseBinary(): void {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = '';
  if (imgUrl.value) URL.revokeObjectURL(imgUrl.value);
  imgUrl.value = '';
  binData.value = null;
  docxHtml.value = '';
  sheetNames.value = [];
  activeSheet.value = '';
  grid.value = [];
  gridCapped.value = false;
  workbook = null;
  pptxViewer?.destroy();
  pptxViewer = null;
  pptxBuf = null;
  pptxFail.value = false;
}

/** 解析 csv/tsv 文本为表格（RFC4180：支持引号包裹与 "" 转义）；超过上限截断 */
function parseDelimited(text: string, delim: string): void {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  gridCapped.value = false;
  const pushField = (): void => { row.push(field); field = ''; };
  const pushRow = (): void => {
    pushField();
    if (row.length > 1 || row[0] !== '') out.push(row); // 跳过连续空行
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // "" 转义为 "
        else inQ = false;
      } else if (c !== '\r') field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) pushField();
    else if (c === '\n') {
      pushRow();
      if (out.length >= MAX_GRID_ROWS) { gridCapped.value = true; row = []; field = ''; break; }
    } else if (c !== '\r') field += c;
  }
  if (!gridCapped.value && (field !== '' || row.length)) pushRow(); // flush 无换行结尾的残余行
  grid.value = out;
}

/** 切换 xlsx 活动工作表 → 表格数据（超过上限截断） */
function selectSheet(name: string): void {
  activeSheet.value = name;
  grid.value = [];
  gridCapped.value = false;
  if (!workbook || !name) return;
  const ws = workbook.Sheets[name];
  if (!ws) return;
  const rows = xlsxMod!.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' });
  grid.value = rows.length > MAX_GRID_ROWS ? rows.slice(0, MAX_GRID_ROWS) : rows;
  gridCapped.value = rows.length > MAX_GRID_ROWS;
}

/** 二进制文档拉取与解析：pdf/图片 → objectURL；svg → objectURL + 源码文本；docx → mammoth；xlsx/xls → SheetJS */
async function openBinary(path: string, k: ViewKind, seq: number): Promise<void> {
  const blob = await fetchRaw(path, props.wsPath);
  if (seq !== openSeq) return;
  binData.value = blob;
  if (k === 'pdf') {
    pdfUrl.value = URL.createObjectURL(blob);
    return;
  }
  if (k === 'img' || k === 'svg') {
    imgUrl.value = URL.createObjectURL(blob);
    if (k === 'svg') {
      const text = await blob.text(); // 源码模式复用该文本，免二次请求
      if (seq !== openSeq) return;
      const name = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
      fileData.value = { name, bytes: blob.size, truncated: false, content: text };
    }
    return;
  }
  if (k === 'legacy') return; // 仅占位卡 + 大小展示
  if (k === 'pptx') {
    pptxBuf = await blob.arrayBuffer(); // 容器未挂载，延迟到 openFile 的 nextTick 后再渲染
    if (seq !== openSeq) return;
    return;
  }
  const buf = await blob.arrayBuffer();
  if (seq !== openSeq) return;
  if (k === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const r = await mammoth.convertToHtml({ arrayBuffer: buf });
    if (seq !== openSeq) return;
    docxHtml.value = DOMPurify.sanitize(r.value, { ADD_DATA_URI_TAGS: ['img'] });
  } else {
    xlsxMod = await import('xlsx');
    if (seq !== openSeq) return;
    workbook = xlsxMod.read(buf, { type: 'array' });
    sheetNames.value = workbook.SheetNames;
    selectSheet(workbook.SheetNames[0] ?? '');
  }
}

/** 挂载 pptx 渲染器：动态加载库（workerUrl 显式注入，默认路径打包后失效）；失败置 pptxFail 降级占位卡 */
async function mountPptx(seq: number): Promise<void> {
  if (!pptxBuf || !pptxContainer.value) return;
  try {
    const mod = await import('@file-viewer/pptx');
    if (seq !== openSeq) return;
    const viewer = await mod.PptxViewer.open(pptxBuf, pptxContainer.value, {
      fitMode: 'contain',
      workerUrl: pptxWorkerUrl,
    });
    if (seq !== openSeq) {
      viewer.destroy(); // 打开期间已切换文件：销毁避免泄漏
      return;
    }
    pptxViewer = viewer;
  } catch {
    if (seq === openSeq) pptxFail.value = true;
  }
}

async function openFile(path: string, anchor = ''): Promise<void> {
  const k = viewKindOf(path);
  selected.value = path;
  // 打开文件即切回文件页签（终端在后台保活，不打断正在跑的命令）
  activeTab.value = 'file';
  viewMode.value = 'prev';
  const seq = ++openSeq;
  fileLoading.value = true;
  fileError.value = '';
  releaseBinary();
  fileData.value = null;
  try {
    if (BINARY_KINDS.has(k)) await openBinary(path, k, seq);
    else {
      // doc 走后端提取端点（word-extractor + 转 markdown），响应结构与 /fs/file 同构
      const ep = k === 'doc' ? 'doc2md' : 'file';
      fileData.value = await api<{ name: string; bytes: number; truncated: boolean; content: string }>(
        `/fs/${ep}?path=${encodeURIComponent(path)}${wsQuery()}`,
      );
      if (seq !== openSeq) return;
      if (k === 'csv') parseDelimited(fileData.value.content, ',');
      else if (k === 'tsv') parseDelimited(fileData.value.content, '\t');
    }
    if (seq !== openSeq) return;
    // 先摘 loading 再等一帧：pptx 容器挂在 fileLoading 的 v-else 分支上，不先置 false 拿不到 DOM
    if (seq === openSeq) fileLoading.value = false;
    await nextTick();
    if (seq !== openSeq) return;
    if (k === 'pptx') void mountPptx(seq); // 容器已挂载，异步渲染不阻塞
    if (viewerEl.value && !(kind.value === 'md' && viewMode.value === 'prev')) highlightIn(viewerEl.value); // md 预览无需高亮；其余分支（含源码模式）高亮
    if (k === 'md' && viewMode.value === 'prev' && mdEl.value) void renderMermaidIn(mdEl.value); // md 预览：mermaid 图表后处理（../mermaid.ts 共享模块）
    if (k === 'md' && viewMode.value === 'prev' && mdEl.value) void renderEChartsIn(mdEl.value); // md 预览：echarts 图表后处理（../echarts.ts 共享模块）
    if (viewerKw.value.trim()) applyHits(); // 打开新文件后沿用文内搜索关键词
    if (anchor) scrollToAnchor(anchor); // 跨文件锚点：渲染完成后滚动（仅 md）
  } catch (e) {
    if (seq !== openSeq) return;
    fileData.value = null;
    releaseBinary();
    fileError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === openSeq) fileLoading.value = false;
  }
}

/* ================= 写操作与下载（优化建议 20261021-005） ================= */
// 删除 / 重命名 / 新建目录 / 上传（按钮、右键菜单、拖拽）/ 下载（文件附件、目录 zip）。
// 操作成功后只局部刷新对应目录，并清掉该目录的指纹基线，避免下一轮轮询重复重拉。

interface UploadItem {
  file: File;
  /** 相对目标目录的层级路径（目录上传保留原层级） */
  rel: string;
}

type DropEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader: () => {
    readEntries: (cb: (es: DropEntry[]) => void, err: (e: unknown) => void) => void;
  };
};

const fileInput = ref<HTMLInputElement | null>(null);
const dirInput = ref<HTMLInputElement | null>(null);
const uploading = ref<{ done: number; total: number } | null>(null);
const dropTarget = ref<string | null>(null); // 高亮中的拖拽目标目录（'' 为根）
/** 上传进度百分比（头部下沿 3px 细线，D8） */
const upPct = computed(() => {
  const u = uploading.value;
  if (!u || !u.total) return 0;
  return Math.min(100, Math.round((u.done / u.total) * 100));
});
let pendingUploadDir = '';
const MENU_MAX_FILES = 1000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 写操作前置守卫：无活跃会话所属工作空间时不允许落到启动空间 */
function requireWs(): boolean {
  if (props.wsPath) return true;
  showToast('无活跃会话所属工作空间，无法操作文件', 'warn');
  return false;
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 操作后局部刷新目录：重拉子项并标记已加载，同时清掉该目录指纹基线 */
async function afterMutation(dir: string): Promise<void> {
  await reloadDir(dir);
  loadedDirs.value = new Set(loadedDirs.value).add(dir);
  fpSigs.delete(dir);
  pruneState();
}

/** 触发浏览器下载（Blob → 临时 <a download>） */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 删除（目录递归；二次确认） */
async function removeEntry(node: FsNode): Promise<void> {
  if (!requireWs()) return;
  const what = node.type === 'dir' ? '目录（含全部内容）' : '文件';
  if (!window.confirm(`确定删除${what}？\n\n${node.path}`)) return;
  try {
    await deleteFsEntry(node.path, node.type === 'dir', props.wsPath);
    if (selected.value === node.path || selected.value.startsWith(`${node.path}/`)) {
      selected.value = '';
      fileData.value = null;
      fileError.value = '';
      releaseBinary();
    }
    await afterMutation(parentOf(node.path));
    showToast(`已删除 ${node.path}`, 'success');
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

/** 重命名 / 移动（输入不含 / 视为同目录改名，含 / 视为工作空间相对路径） */
async function startRename(node: FsNode): Promise<void> {
  if (!requireWs()) return;
  const input = window.prompt(
    `重命名${node.type === 'dir' ? '目录' : '文件'}（输入含 / 的路径可移动到其他目录）`,
    node.name,
  );
  if (input === null) return;
  const typed = input.trim().replace(/\\/g, '/');
  if (!typed) return;
  if (typed.split('/').some((s) => s === '..')) {
    showToast('路径不能包含 ..', 'error');
    return;
  }
  const to = typed.includes('/') ? typed.replace(/^\/+/, '') : joinRel(parentOf(node.path), typed);
  if (to === node.path) return;
  try {
    const r = await renameFsEntry(node.path, to, props.wsPath);
    if (selected.value === node.path || selected.value.startsWith(`${node.path}/`)) {
      if (node.type === 'file') void openFile(r.to);
      else {
        selected.value = '';
        fileData.value = null;
        releaseBinary();
      }
    }
    await afterMutation(parentOf(node.path));
    if (parentOf(r.to) !== parentOf(node.path)) await afterMutation(parentOf(r.to));
    showToast(`已重命名 → ${r.to}`, 'success');
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

/** 新建目录（parent 为空串表示工作空间根） */
async function createDir(parent: string): Promise<void> {
  if (!requireWs()) return;
  const input = window.prompt(`在 ${parent || '/'} 下新建目录`, '新建目录');
  if (input === null) return;
  const name = input.trim();
  if (!name) return;
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    showToast('目录名不能包含路径分隔符', 'error');
    return;
  }
  const path = joinRel(parent, name);
  try {
    await mkdirFs(path, props.wsPath);
    if (parent) expanded.value = new Set(expanded.value).add(parent);
    await afterMutation(parent);
    showToast(`已创建 ${path}`, 'success');
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

/** 下载文件或目录（目录后端打包 zip） */
async function downloadEntry(node: FsNode): Promise<void> {
  if (!requireWs()) return;
  try {
    const { blob, name } = await downloadFsEntry(node.path, props.wsPath);
    saveBlob(blob, name);
    showToast(`开始下载 ${name}`, 'success');
  } catch (e) {
    showToast(errMsg(e), 'error');
  }
}

/* ---- 上传（按钮选择 / 拖拽，多文件逐个请求，展示进度） ---- */

function pickFiles(dir: string): void {
  if (!requireWs()) return;
  pendingUploadDir = dir;
  fileInput.value?.click();
}

function pickDir(dir: string): void {
  if (!requireWs()) return;
  pendingUploadDir = dir;
  dirInput.value?.click();
}

function onFilesPicked(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ''; // 允许连续选择同一文件
  const dir = pendingUploadDir;
  pendingUploadDir = '';
  const items = files.map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file: f, rel: rel || f.name };
  });
  void uploadItems(items, dir);
}

async function uploadItems(items: UploadItem[], targetDir: string): Promise<void> {
  if (!items.length || !props.wsPath || uploading.value) return;
  uploading.value = { done: 0, total: items.length };
  let ok = 0;
  const errors: string[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      await uploadToWorkspace(items[i].file, targetDir, { relativePath: items[i].rel, ws: props.wsPath });
      ok++;
    } catch (e) {
      errors.push(`${items[i].rel}: ${errMsg(e)}`);
    }
    uploading.value = { done: i + 1, total: items.length };
  }
  uploading.value = null;
  if (ok) {
    if (targetDir) expanded.value = new Set(expanded.value).add(targetDir);
    await afterMutation(targetDir);
    showToast(`已上传 ${ok} 个文件`, 'success');
  }
  if (errors.length) {
    showToast(`上传失败 ${errors.length} 个：${errors.slice(0, 2).join('；')}`, 'error', 8000);
  }
}

function entryFile(entry: DropEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntries(reader: ReturnType<DropEntry['createReader']>): Promise<DropEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** webkitGetAsEntry 递归：目录拖拽保留原层级 */
async function walkEntry(entry: DropEntry, prefix: string, out: UploadItem[]): Promise<void> {
  if (out.length >= MENU_MAX_FILES) return;
  if (entry.isFile) {
    out.push({ file: await entryFile(entry), rel: prefix ? `${prefix}/${entry.name}` : entry.name });
    return;
  }
  if (!entry.isDirectory) return;
  const dirRel = prefix ? `${prefix}/${entry.name}` : entry.name;
  const reader = entry.createReader();
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, dirRel, out);
  }
}

async function collectDropItems(dt: DataTransfer | null): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  if (!dt) return out;
  if (dt.items?.length) {
    const roots: DropEntry[] = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => DropEntry | null })
        .webkitGetAsEntry;
      const entry = getEntry ? getEntry.call(item) : null;
      if (entry) roots.push(entry);
      else {
        const f = item.getAsFile();
        if (f) out.push({ file: f, rel: f.name });
      }
    }
    for (const entry of roots) await walkEntry(entry, '', out);
  } else {
    for (const f of Array.from(dt.files)) out.push({ file: f, rel: f.name });
  }
  return out;
}

function onDragOver(e: DragEvent, dir: string): void {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropTarget.value = dir;
}

function onDragLeave(): void {
  dropTarget.value = null;
}

async function onDrop(e: DragEvent, dir: string): Promise<void> {
  e.preventDefault();
  dropTarget.value = null;
  if (!props.wsPath) return;
  const items = await collectDropItems(e.dataTransfer);
  if (items.length >= MENU_MAX_FILES) showToast(`单次最多上传 ${MENU_MAX_FILES} 个文件`, 'warn');
  await uploadItems(items.slice(0, MENU_MAX_FILES), dir);
}

/** 行级拖拽：仅目录行可作为落点（文件行吞掉事件，避免上浮到根区误上传） */
function onDragOverRow(e: DragEvent, node: FsNode): void {
  // 必须阻断冒泡：.fs-body 上还有 onDragOver($event, '')，否则行级目标会被重置成根目录
  e.stopPropagation();
  if (node.type === 'dir') {
    onDragOver(e, node.path);
    return;
  }
  dropTarget.value = null; // 文件行不是落点：收起浮层，别让人以为会传到当前目录
}

function onDropRow(e: DragEvent, node: FsNode): void {
  e.preventDefault();
  e.stopPropagation();
  if (node.type === 'dir') void onDrop(e, node.path);
}

/* ---- 浮层菜单（右键菜单 + 头部上传二级菜单共用） ---- */
interface MenuState {
  x: number;
  y: number;
  node: FsNode | null; // null = 树空白处（操作根目录）
  /** 'node' 节点菜单（默认）；'root' 根目录菜单；'upload' 头部上传按钮的二级菜单（D2） */
  kind?: 'node' | 'root' | 'upload';
}
const menu = ref<MenuState | null>(null);

function openMenu(e: MouseEvent, node: FsNode | null): void {
  e.preventDefault();
  e.stopPropagation();
  menu.value = { x: e.clientX, y: e.clientY, node, kind: node ? 'node' : 'root' };
}

/** 头部「上传」按钮 → 弹出「上传文件 / 上传文件夹」二级菜单（D2：原两个入口合一） */
function openUploadMenu(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = {
    x: Math.max(8, Math.min(r.right - 212, window.innerWidth - 220)),
    y: r.bottom + 6,
    node: null,
    kind: 'upload',
  };
}

/** 行内「⋯」→ 在该按钮下方打开节点菜单（D4：与右键菜单同一份实现） */
function openRowMenu(e: MouseEvent, node: FsNode): void {
  e.preventDefault();
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = {
    x: Math.max(8, Math.min(r.right - 212, window.innerWidth - 220)),
    y: r.bottom + 4,
    node,
    kind: 'node',
  };
}

function closeMenu(): void {
  menu.value = null;
}

/** 树空白处菜单代表的根节点（下载整个工作空间用） */
const rootNode = computed<FsNode>(() => ({ name: props.wsPath, path: '', type: 'dir' }));

/** 菜单动作分发：先关菜单再执行，node 为 null 表示根目录 */
function menuAction(
  kind: 'upload' | 'uploadDir' | 'mkdir' | 'download' | 'rename' | 'delete' | 'copy',
  node: FsNode | null,
): void {
  closeMenu();
  if (kind === 'upload') return pickFiles(node?.path ?? '');
  if (kind === 'uploadDir') return pickDir(node?.path ?? '');
  if (kind === 'mkdir') {
    void createDir(node?.path ?? '');
    return;
  }
  if (kind === 'copy') {
    const p = node?.path ?? '';
    void navigator.clipboard?.writeText(p).then(
      () => showToast(p ? `已复制相对路径：${p}` : '已复制根路径', 'success'),
      () => showToast('复制失败，请手动选择路径', 'error'),
    );
    return;
  }
  const target = node ?? rootNode.value;
  if (kind === 'download') void downloadEntry(target);
  else if (kind === 'rename' && node) void startRename(node);
  else if (kind === 'delete' && node) void removeEntry(node);
}

document.addEventListener('click', closeMenu);
window.addEventListener('scroll', closeMenu, true);

/* ================= md 内链跳转 ================= */
const viewerHistory = ref<string[]>([]); // md 跳转来源文件栈（← 返回用）

/** 相对当前文件目录解析链接 → 工作区内规范路径（/ 开头视为根） */
function resolveRel(base: string, link: string): string {
  const p = link.startsWith('/')
    ? link.slice(1)
    : (base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '') + link;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** 拆分 href 为 [路径, 锚点]，均 decode（含非法 % 编码时回退原文） */
function splitHref(href: string): [string, string] {
  const dec = (s: string): string => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  const i = href.indexOf('#');
  return i >= 0 ? [dec(href.slice(0, i)), dec(href.slice(i + 1))] : [dec(href), ''];
}

/** 滚动到预览区内指定标题 id（marked 为标题生成 slug id） */
function scrollToAnchor(id: string): void {
  viewerEl.value?.querySelector('#' + CSS.escape(id))?.scrollIntoView({ block: 'start' });
}

/** md 预览内链接点击分流：页内锚点 / 外链新标签 / 工作区 md 跳转，其余提示 */
function onMdClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest('a');
  if (!a || !viewerEl.value?.contains(a)) return;
  const href = a.getAttribute('href') ?? '';
  e.preventDefault(); // 一律接管，避免 SPA 整页跳转
  if (!href) return;
  if (href.startsWith('#')) {
    scrollToAnchor(splitHref(href)[1]);
    return;
  }
  if (/^(https?:)?\/\//i.test(href) || /^(mailto|tel):/i.test(href)) {
    window.open(href, '_blank', 'noopener');
    return;
  }
  const [rawPath, anchor] = splitHref(href);
  const target = resolveRel(selected.value, rawPath);
  if (extOf(target) === 'md') {
    if (selected.value) viewerHistory.value.push(selected.value); // 记录来源，供返回
    void openFile(target, anchor);
  } else {
    showToast('暂不支持在预览中打开该类型链接', 'info');
  }
}

/** 返回上一个文件（md 跳转栈） */
function goBackFile(): void {
  const prev = viewerHistory.value.pop();
  if (prev) void openFile(prev);
}

/* ================= 搜索 ================= */
const searchKw = ref('');
const searching = ref(false);
const searchResults = ref<SearchResult[]>([]);
const searchTruncated = ref(false);
/** 搜索结果按文件分组（D6）：组头显示目录 + 文件名 + 命中数，组内行号升序 */
const hitGroups = computed(() => groupHits(searchResults.value));

/** 底部状态条左侧文案（D8）：上传中 > 加载/错误 > 搜索中 > 搜索命中 > 树项数 */
const footCount = computed(() => {
  const u = uploading.value;
  if (u) return `上传 ${u.done}/${u.total}`;
  if (treeLoading.value && rows.value.length === 0) return '加载中…';
  if (treeError.value) return '读取失败';
  if (searching.value) return '搜索中…';
  if (searchKw.value.trim()) {
    return `${searchResults.value.length} 处命中 · ${hitGroups.value.length} 个文件`;
  }
  return `${rows.value.length} 项`;
});
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function doSearch(): Promise<void> {
  const q = searchKw.value.trim();
  const seq = ++searchSeq;
  if (!q) {
    searchResults.value = [];
    searchTruncated.value = false;
    searching.value = false;
    return;
  }
  searching.value = true;
  try {
    const r = await api<{ truncated: boolean; results: SearchResult[] }>(
      `/fs/search?q=${encodeURIComponent(q)}&hidden=${showHidden.value ? 1 : 0}${wsQuery()}`,
    );
    if (seq !== searchSeq) return; // 已有更新的请求，丢弃过期响应
    searchResults.value = r.results;
    searchTruncated.value = r.truncated;
  } catch {
    if (seq === searchSeq) searchResults.value = [];
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
}

function clearSearch(): void {
  searchKw.value = '';
  searchResults.value = [];
  searchTruncated.value = false;
}

watch(searchKw, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void doSearch(), 300);
});

/* ================= 文内搜索（预览区） ================= */
const viewerKw = ref('');
const hitCount = ref(0);
const hitIdx = ref(0); // 1-based 当前命中；0 = 无命中
let viewerTimer: ReturnType<typeof setTimeout> | null = null;

/** 清除预览区全部命中高亮 */
function clearHits(): void {
  const root = viewerEl.value;
  if (!root) return;
  root.querySelectorAll('mark.fp-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent ?? '')));
  root.normalize();
  hitCount.value = 0;
  hitIdx.value = 0;
}

/** 高亮全部命中（大小写不敏感，字面匹配）；打开文件 / 关键词变化后调用 */
function applyHits(): void {
  clearHits();
  const root = viewerEl.value;
  const kw = viewerKw.value.trim().toLowerCase();
  if (!root || !kw) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      // mermaid 不参与搜索：已渲染 SVG 插 mark 会破坏图形；未渲染源码块稍后被整体替换（mark 会丢、计数会虚高）
      if (n.parentElement?.closest('svg, code.language-mermaid')) return NodeFilter.FILTER_REJECT;
      const tag = n.parentElement?.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
      return n.nodeValue?.toLowerCase().includes(kw) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const targets: Text[] = [];
  while (walker.nextNode()) targets.push(walker.currentNode as Text);
  let count = 0;
  for (const t of targets) {
    const text = t.nodeValue ?? '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (let i = lower.indexOf(kw); i >= 0; i = lower.indexOf(kw, pos)) {
      if (i > pos) frag.appendChild(document.createTextNode(text.slice(pos, i)));
      const mark = document.createElement('mark');
      mark.className = 'fp-hit';
      mark.textContent = text.slice(i, i + kw.length);
      frag.appendChild(mark);
      count++;
      pos = i + kw.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    t.replaceWith(frag);
  }
  hitCount.value = count;
  if (!count) return;
  hitIdx.value = 1;
  const first = root.querySelectorAll('mark.fp-hit')[0];
  first?.classList.add('cur');
  first?.scrollIntoView({ block: 'center' });
}

/** 跳转上/下一个命中（step = ±1，循环） */
function gotoHit(step: number): void {
  if (!hitCount.value) return;
  hitIdx.value = ((hitIdx.value - 1 + step + hitCount.value) % hitCount.value) + 1;
  const root = viewerEl.value;
  if (!root) return;
  const marks = root.querySelectorAll('mark.fp-hit');
  marks.forEach((m) => m.classList.remove('cur'));
  const cur = marks[hitIdx.value - 1];
  cur?.classList.add('cur');
  cur?.scrollIntoView({ block: 'center' });
}

watch(viewerKw, () => {
  if (viewerTimer) clearTimeout(viewerTimer);
  viewerTimer = setTimeout(() => applyHits(), 200); // 防抖：连续输入只搜最后一次
});

watch(viewMode, async (m) => {
  await nextTick(); // 等 v-if 分支重建 DOM
  if (m === 'src' && viewerEl.value) highlightIn(viewerEl.value); // 源码模式上高亮
  if (m === 'prev' && kind.value === 'md' && mdEl.value) void renderMermaidIn(mdEl.value); // 切回预览：重跑 mermaid
  if (m === 'prev' && kind.value === 'md' && mdEl.value) void renderEChartsIn(mdEl.value); // 切回预览：重跑 echarts
  if (viewerKw.value.trim()) applyHits(); // 分支切换会丢掉 mark，重扫
});

/* ================= 工作空间变化（活跃会话所属空间） ================= */
watch(
  () => props.wsPath,
  () => {
    expanded.value = new Set();
    loadedDirs.value = new Set();
    loadingDirs.value = new Set();
    tree.value = [];
    treeError.value = '';
    selected.value = '';
    fileData.value = null;
    fileError.value = '';
    releaseBinary(); // 释放 objectURL 等二进制状态
    viewerKw.value = ''; // 触发 watch 清除文内命中
    viewerHistory.value = [];
    viewMode.value = 'prev';
    clearSearch();
    fpSigs.clear(); // 新空间的指纹基线重来
    closeMenu();
    dropTarget.value = null;
    uploading.value = null;
    void loadTree();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  releaseBinary(); // 释放 blob objectURL
  stopAutoRefresh();
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.removeEventListener('click', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
});
watch(showHidden, () => {
  expanded.value = new Set(); // 隐藏目录开关改变可见集合，已加载的子项需重新拉取
  loadedDirs.value = new Set();
  fpSigs.clear();
  void loadTree();
  if (searchKw.value.trim()) void doSearch(); // 隐藏目录开关同时影响搜索范围
});

/* ================= 分割条 ================= */
const dragging = ref(false);
const splitterW = ref(0); // 0 = 默认宽度（对话区 1/3）
let savedW = 0; // 收起前宽度，重新展开时还原

const panelStyle = computed(() => {
  if (!open.value) return { width: '0px' }; // 收起必须走内联：内联样式优先级高于类规则，否则压不住拖拽写入的宽度
  return splitterW.value ? { width: splitterW.value + 'px' } : {};
});

function onSplitDown(e: PointerEvent): void {
  const panel = panelEl.value;
  const parent = panel?.parentElement;
  if (!panel || !parent) return;
  const total = parent.clientWidth;
  const startX = e.clientX;
  const startW = panel.getBoundingClientRect().width;
  dragging.value = true;
  panel.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent): void => {
    // 分割条在面板左缘：向左拖增宽
    splitterW.value = Math.min(total - 340, Math.max(360, startW + (startX - ev.clientX)));
  };
  const onUp = (): void => {
    dragging.value = false;
    panel.removeEventListener('pointermove', onMove);
    panel.removeEventListener('pointerup', onUp);
    panel.removeEventListener('pointercancel', onUp);
  };
  panel.addEventListener('pointermove', onMove);
  panel.addEventListener('pointerup', onUp);
  panel.addEventListener('pointercancel', onUp);
}

function onSplitDbl(): void {
  splitterW.value = 0;
  showToast('已恢复默认占比（工作空间 2/3）', 'success');
}

/* ================= 预览 / 文件目录 内部分割条 ================= */
const SIDE_MIN = 204; // 目录区最小宽度（20261026-001 D1：160 → 204，容器查询阈值 246 留出余量）
const SIDE_DEFAULT = 264; // 与 .files-side 默认宽度一致（D1：240 → 264）
const VIEWER_MIN = 320; // 预览区最小宽度
const sideW = ref(SIDE_DEFAULT);
const bodyEl = ref<HTMLElement | null>(null);
const sideDragging = ref(false);

const sideStyle = computed(() => ({ width: sideW.value + 'px' }));

function clampSide(next: number, total: number): number {
  const upper = Math.max(SIDE_MIN, total - VIEWER_MIN);
  return Math.min(upper, Math.max(SIDE_MIN, next));
}

function onSideSplitDown(e: PointerEvent): void {
  const body = bodyEl.value;
  if (!body) return;
  const total = body.clientWidth;
  const startX = e.clientX;
  const startW = sideW.value;
  sideDragging.value = true;
  body.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent): void => {
    // 分割条在预览右侧：向左拖放大预览（目录变窄），向右拖放大目录
    sideW.value = clampSide(startW - (ev.clientX - startX), total);
  };
  const onUp = (): void => {
    sideDragging.value = false;
    body.removeEventListener('pointermove', onMove);
    body.removeEventListener('pointerup', onUp);
    body.removeEventListener('pointercancel', onUp);
  };
  body.addEventListener('pointermove', onMove);
  body.addEventListener('pointerup', onUp);
  body.addEventListener('pointercancel', onUp);
}

function onSideSplitDbl(): void {
  sideW.value = SIDE_DEFAULT;
  showToast('已恢复默认宽度（目录 264px）', 'success');
}

watch(open, (v) => {
  if (!v) {
    savedW = splitterW.value;
  } else if (savedW) {
    splitterW.value = savedW;
    savedW = 0;
  }
});

/* ================= 头部搜索框聚焦（Ctrl K） ================= */
const searchInputEl = ref<HTMLInputElement | null>(null);

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    if (!open.value) return; // 面板收起时不抢焦点
    e.preventDefault();
    searchInputEl.value?.focus();
    searchInputEl.value?.select();
  }
}
document.addEventListener('keydown', onGlobalKeydown);

onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKeydown));
</script>

<template>
  <!-- 窄屏遮罩（宽屏不渲染显示） -->
  <div v-if="open" class="fp-mask" @click="open = false"></div>

  <div ref="panelEl" class="files-panel" :class="{ open, dragging }" :style="panelStyle">
    <div class="splitter" title="拖拽调整宽度；双击恢复默认" @pointerdown="onSplitDown" @dblclick="onSplitDbl"></div>

    <div ref="bodyEl" class="files-body" :class="{ 'side-dragging': sideDragging }">
      <!-- 左：文件预览 / 终端 -->
      <div ref="viewerEl" class="files-viewer">
        <!-- 预览区顶部标签行：文件预览与终端共存为同级页签（Task-20261027-001 D6） -->
        <div class="viewer-tabs">
          <button
            class="vtab"
            :class="{ on: activeTab === 'file' }"
            :title="selected || '文件预览'"
            @click="activeTab = 'file'"
          >
            <span class="vtab-label">{{ selected ? shortName(selected) : '文件预览' }}</span>
          </button>
          <button
            v-for="t in terminals"
            :key="t.id"
            class="vtab term"
            :class="{ on: activeTab === t.id }"
            :title="t.title || '终端'"
            @click="activeTab = t.id"
          >
            <span class="vtab-dot" :class="t.state"></span>
            <span class="vtab-label">{{ t.title || '终端' }}</span>
            <span class="vtab-x" title="关闭该终端" @click.stop="closeTerminal(t.id)">✕</span>
          </button>
          <button class="vtab-add" title="新建终端（可运行 cmd / PowerShell 命令）" @click="newTerminal">＋</button>
        </div>

        <!-- 文件预览：原 .files-viewer 的滚动与内边距迁到本层（外层已改 flex column） -->
        <div v-show="activeTab === 'file'" class="fv-scroll">
          <div v-if="!selected" class="fv-empty">点击右侧文件预览内容</div>
        <template v-else>
          <div class="fv-head">
            <button v-if="viewerHistory.length" class="fv-back" title="返回上一个文件" @click="goBackFile">←</button>
            <span class="fv-name" :title="selected">{{ selected }}</span>
            <span v-if="headBytes" class="fv-meta">{{ fmtBytes(headBytes) }}</span>
            <span v-if="fileData?.truncated" class="fv-trunc">仅显示前 512 KB</span>
            <div v-if="hasModes" class="md-mode">
              <button :class="{ on: viewMode === 'prev' }" :title="prevLabel" @click="viewMode = 'prev'">{{ prevLabel }}</button>
              <button :class="{ on: viewMode === 'src' }" title="查看源代码" @click="viewMode = 'src'">源码</button>
            </div>
          </div>
          <div v-if="searchable" class="fv-tools">
            <input v-model="viewerKw" type="text" placeholder="在文件中搜索…">
            <span v-if="viewerKw.trim()" class="fv-hits" :class="{ none: !hitCount }">
              {{ hitCount ? `${hitIdx}/${hitCount}` : '无匹配' }}
            </span>
            <template v-if="hitCount">
              <button title="上一个（循环）" @click="gotoHit(-1)">▲</button>
              <button title="下一个（循环）" @click="gotoHit(1)">▼</button>
            </template>
            <button v-if="viewerKw" title="清除搜索" @click="viewerKw = ''">✕</button>
          </div>
          <div v-if="fileLoading" class="fv-empty">加载中…</div>
          <div v-else-if="fileError" class="fv-err">⚠ {{ fileError }}</div>
          <!-- md 预览：块渲染（稳定块 + 图表槽位，与对话流同一路径 D9）；mermaid/echarts 后处理填充槽位 -->
          <div v-else-if="kind === 'md' && viewMode === 'prev'" ref="mdEl" class="fv-md" @click="onMdClick">
            <template v-for="blk in mdBlocks" :key="blk.k">
              <!-- eslint-disable-next-line vue/no-v-html — 内容经 DOMPurify 消毒（../markdown.ts） -->
              <div v-if="blk.kind === 'md'" v-html="blk.html"></div>
              <div v-else-if="blk.kind === 'chart'" class="chart-slot" :data-lang="blk.lang" :data-src="blk.src"></div>
            </template>
          </div>
          <!-- html 预览：沙箱 iframe（孤立 origin：脚本可运行，无法触达主页面/存储） -->
          <iframe
            v-else-if="kind === 'html' && viewMode === 'prev'"
            class="fv-frame"
            sandbox="allow-scripts"
            :srcdoc="fileData?.content ?? ''"
          ></iframe>
          <!-- pdf：blob objectURL 交给浏览器原生渲染 -->
          <iframe v-else-if="kind === 'pdf'" class="fv-frame" :src="pdfUrl" title="PDF 预览"></iframe>
          <!-- 图片（含 svg 预览态）：blob objectURL 直显；svg 另有源码模式（落入底部 pre 兜底） -->
          <img
            v-else-if="kind === 'img' || (kind === 'svg' && viewMode === 'prev')"
            class="fv-img"
            :src="imgUrl"
            :alt="selected"
          >
          <!-- csv/tsv/xlsx/xls 表格；多 sheet 时显示切换条 -->
          <template v-else-if="showGrid">
            <div v-if="sheetNames.length > 1" class="fv-sheets">
              <button v-for="s in sheetNames" :key="s" :class="{ on: s === activeSheet }" @click="selectSheet(s)">
                {{ s }}
              </button>
            </div>
            <table class="fv-grid">
              <tbody>
                <tr v-for="(row, i) in grid" :key="i">
                  <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="gridCapped" class="fv-cap">内容过多，仅显示前 {{ MAX_GRID_ROWS }} 行</div>
          </template>
          <!-- eslint-disable-next-line vue/no-v-html — mammoth 输出经 DOMPurify 消毒 -->
          <div v-else-if="kind === 'docx'" class="fv-md" v-html="docxHtml" @click="onMdClick"></div>
          <!-- doc：后端 /fs/doc2md 已转 markdown，复用同一块渲染管线 -->
          <div v-else-if="kind === 'doc'" class="fv-md">
            <template v-for="blk in mdBlocks" :key="blk.k">
              <!-- eslint-disable-next-line vue/no-v-html — 内容经 DOMPurify 消毒（../markdown.ts） -->
              <div v-if="blk.kind === 'md'" v-html="blk.html"></div>
              <div v-else-if="blk.kind === 'chart'" class="chart-slot" :data-lang="blk.lang" :data-src="blk.src"></div>
            </template>
          </div>
          <!-- pptx 渲染失败降级占位 -->
          <div v-else-if="kind === 'pptx' && pptxFail" class="fv-empty fv-nosup">
            <div class="big">PPTX 渲染失败</div>
            <div class="sub">解析组件加载异常，建议用 PowerPoint / WPS 打开或转 PDF 后查看</div>
          </div>
          <!-- pptx：@file-viewer/pptx 渲染容器（分页 DOM 与样式由库自动注入） -->
          <div v-else-if="kind === 'pptx'" ref="pptxContainer" class="fv-pptx"></div>
          <!-- ppt 旧版二进制格式：纯 JS 生态无可靠轻量解析，占位提示 -->
          <div v-else-if="kind === 'legacy'" class="fv-empty fv-nosup">
            <div class="big">PPT 文档暂不支持在线预览</div>
            <div class="sub">旧版二进制格式暂无轻量解析方案，建议另存为 pptx 或转 PDF 后查看</div>
          </div>
          <!-- 源码兜底：md/html/表格类源码与非文档文本（codeLang 已把 md/html 映射高亮） -->
          <pre v-else class="fv-code"><code :class="'language-' + codeLang">{{ fileData?.content }}</code></pre>
        </template>
        </div>

        <!-- 终端标签页：v-show 保活，避免切换标签销毁 xterm 实例与已输出的内容 -->
        <TerminalPanel
          v-for="t in terminals"
          v-show="activeTab === t.id"
          :key="t.id"
          :ref="(el) => bindTermPanel(t.id, el)"
          :ws-path="wsPath"
          :visible="activeTab === t.id"
          :initial-shell="t.shellId"
          @close="closeTerminal(t.id)"
          @title="(v: string) => (t.title = v)"
          @state="(v: string) => (t.state = v)"
        />
      </div>

      <!-- 预览 / 目录 分割条：拖拽调整占比，双击恢复默认 -->
      <div
        class="side-split"
        title="拖拽调整预览与目录宽度；双击恢复默认"
        @pointerdown="onSideSplitDown"
        @dblclick="onSideSplitDbl"
      ></div>

      <!-- 右：文件目录（20261026-001 重设计：头部一行 + 树/搜索 + 状态条） -->
      <div class="files-side" :style="sideStyle">
        <!-- 第 1 行：搜索 + 新建 / 上传 / 刷新（原 3 行 115px → 1 行 ≤64px，D2） -->
        <div class="pn-head">
          <div class="search">
            <span class="s-ico" v-html="ICONS.search"></span>
            <input
              ref="searchInputEl"
              v-model="searchKw"
              type="text"
              placeholder="搜索文件…"
              spellcheck="false"
              title="搜索文件内容（Ctrl K 聚焦）"
            >
            <button v-if="searchKw" class="s-clr" title="清除搜索" @click="clearSearch">✕</button>
          </div>
          <button
            class="ib"
            :disabled="!props.wsPath"
            title="在根目录新建文件夹"
            @click="createDir('')"
            v-html="ICONS.plus"
          ></button>
          <button
            class="ib"
            :disabled="!props.wsPath"
            title="上传文件 / 文件夹"
            @click="openUploadMenu"
            v-html="ICONS.upload"
          ></button>
          <button
            class="ib"
            :class="{ spin: refreshing }"
            :disabled="refreshing || !props.wsPath"
            title="刷新已展开的目录"
            @click="refreshNow"
            v-html="ICONS.refresh"
          ></button>
        </div>

        <!-- 上传进度细线：贴头部下沿，不挡操作（D8） -->
        <div class="up" :class="{ on: !!uploading }"><i :style="{ width: upPct + '%' }"></i></div>

        <!-- 面包屑：根名 › 选中文件所在目录链（D9） -->
        <div class="crumb">
          <template v-for="(c, i) in crumbs" :key="c.path || 'root'">
            <span v-if="i" class="sep">›</span>
            <button
              class="c"
              :class="{ last: i === crumbs.length - 1 }"
              :title="c.path || rootLabel"
              @click="gotoCrumb(c.path)"
            >{{ c.label }}</button>
          </template>
        </div>

        <!-- 树 / 搜索结果 / 四态 -->
        <div
          ref="sideBodyEl"
          class="fs-body"
          :class="{ 'drop-root': dropTarget === '' }"
          role="tree"
          @contextmenu.prevent="openMenu($event, null)"
          @dragover="onDragOver($event, '')"
          @dragleave="onDragLeave"
          @drop="onDrop($event, '')"
        >
          <!-- 加载中：骨架屏（D7） -->
          <div v-if="treeLoading && rows.length === 0" class="skel">
            <div
              v-for="(w, i) in SKEL_W"
              :key="i"
              class="sk"
              :style="{ paddingLeft: 9 + (i % 4 === 0 ? 0 : 14) + 'px' }"
            >
              <i class="sq"></i>
              <i class="ln" :style="{ width: w + '%', animationDelay: i * 60 + 'ms' }"></i>
            </div>
          </div>

          <!-- 读取失败（D7） -->
          <div v-else-if="treeError" class="empt">
            <span class="big" v-html="ICONS.warn"></span>
            <b>读不到这个目录</b>
            <span class="sub">{{ treeError }}</span>
            <button @click="loadTree()">重试</button>
          </div>

          <!-- 搜索态 -->
          <template v-else-if="searchKw.trim()">
            <div v-if="searching" class="skel">
              <div v-for="i in 6" :key="i" class="sk" :style="{ paddingLeft: 9 + 'px' }">
                <i class="ln" :style="{ width: 60 + ((i * 13) % 30) + '%', animationDelay: i * 60 + 'ms' }"></i>
              </div>
            </div>
            <template v-else-if="searchResults.length">
              <div class="res-head">
                <span><b>{{ searchResults.length }}</b> 处命中 · <b>{{ hitGroups.length }}</b> 个文件</span>
                <button @click="clearSearch">清除</button>
              </div>
              <div v-if="searchTruncated" class="res-trunc">结果过多，仅显示前 {{ searchResults.length }} 条</div>
              <!-- 按文件分组 + 命中数徽标 + 关键词高亮（D6） -->
              <div v-for="g in hitGroups" :key="g.path" class="res-group">
                <div class="res-file" :title="g.path" @click="openFile(g.path)">
                  <span class="ico" v-html="ICONS.file"></span>
                  <span class="dir">{{ g.dir }}</span><span class="name">{{ g.name }}</span>
                  <span class="n">{{ g.hits.length }}</span>
                </div>
                <div
                  v-for="h in g.hits"
                  :key="g.path + ':' + h.line"
                  class="res-hit"
                  :title="`${h.path}:${h.line}`"
                  @click="openFile(g.path)"
                >
                  <span class="ln">{{ h.line }}</span>
                  <span class="tx"><template
                    v-for="(p, pi) in highlightParts(h.text, searchKw)"
                    :key="pi"
                  ><mark v-if="p.hit">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
                </div>
              </div>
            </template>
            <div v-else class="empt">
              <span class="big" v-html="ICONS.empty"></span>
              <b>没有匹配的文件</b>
              <span class="sub">试试更短的关键词，或打开「隐藏项」把 . 开头的目录纳入搜索。</span>
              <button @click="clearSearch">清除搜索</button>
            </div>
          </template>

          <!-- 树 -->
          <template v-else-if="rows.length">
            <div
              v-for="r in rows"
              :key="r.node.path"
              class="row"
              :class="{
                dir: r.node.type === 'dir',
                file: r.node.type === 'file',
                open: r.node.type === 'dir' && expanded.has(r.node.path),
                sel: r.node.path === selected,
                drop: r.node.type === 'dir' && dropTarget === r.node.path,
              }"
              :style="{ '--lv': r.depth }"
              :data-path="r.node.path"
              role="treeitem"
              tabindex="0"
              :aria-expanded="r.node.type === 'dir' ? expanded.has(r.node.path) : undefined"
              :title="r.node.path"
              @click="onRowClick(r.node)"
              @keydown.enter.prevent="onRowClick(r.node)"
              @contextmenu="openMenu($event, r.node)"
              @dragover="onDragOverRow($event, r.node)"
              @dragleave="onDragLeave"
              @drop="onDropRow($event, r.node)"
            >
              <!-- 层级引导线：guides[k] = 第 k 层祖先仍有后续兄弟 -->
              <template v-for="(on, gi) in r.guides" :key="'g' + gi">
                <i
                  v-if="on"
                  class="gl"
                  :style="{ left: 'calc(5px + ' + gi + ' * var(--step) + 7px)' }"
                ></i>
              </template>
              <button
                v-if="r.node.type === 'dir'"
                class="twisty"
                tabindex="-1"
                aria-hidden="true"
                v-html="loadingDirs.has(r.node.path) ? ICONS.dots : ICONS.chevron"
              ></button>
              <span v-else class="space"></span>
              <span
                class="ico"
                :class="{ dir: r.node.type === 'dir' }"
                v-html="r.node.type === 'dir' ? ICONS.folder : ICONS.file"
              ></span>
              <span class="nm">{{ r.node.name }}</span>
              <span v-if="metaOf(r.node)" class="meta">{{ metaOf(r.node) }}</span>
              <!-- 行内操作：2 个高频 + ⋯ 菜单，hover / focus 淡入（D4） -->
              <span class="acts" @click.stop>
                <template v-if="r.node.type === 'dir'">
                  <button title="在此新建文件夹" @click="createDir(r.node.path)" v-html="ICONS.plus"></button>
                  <button title="上传到此目录" @click="pickFiles(r.node.path)" v-html="ICONS.upload"></button>
                </template>
                <template v-else>
                  <button title="下载" @click="downloadEntry(r.node)" v-html="ICONS.download"></button>
                  <button title="重命名 / 移动" @click="startRename(r.node)" v-html="ICONS.pen"></button>
                </template>
                <button title="更多操作" @click="openRowMenu($event, r.node)" v-html="ICONS.dots"></button>
              </span>
            </div>
          </template>

          <!-- 空目录 / 无工作空间 -->
          <div v-else class="empt">
            <span class="big" v-html="ICONS.folderEmpty"></span>
            <b>{{ props.wsPath ? '这里还没有文件' : '无活跃会话所属工作空间' }}</b>
            <span v-if="props.wsPath" class="sub">点上方 ＋ 新建文件夹，或把文件拖到这里上传。</span>
          </div>

          <!-- 拖拽浮层（D7）：明确告诉用户会传到哪 -->
          <div v-if="dropTarget !== null" class="drop">
            <span class="d-ico" v-html="ICONS.upload"></span>
            <span>松开即上传</span>
            <span class="sub">目标：{{ dropTarget ? dropTarget : rootLabel + ' / 根目录' }}</span>
          </div>
        </div>

        <!-- 底部状态条（D8） -->
        <div class="fs-foot">
          <span class="cnt">{{ footCount }}</span>
          <label class="sw" title="显示 / 隐藏 . 开头的目录与文件">
            <input v-model="showHidden" type="checkbox" role="switch">
            <span class="tk"></span>
            <span>隐藏项</span>
          </label>
          <button
            class="live"
            :class="{ off: !autoRefresh }"
            :title="autoRefresh ? '自动刷新已开启（点击暂停）' : '自动刷新已暂停（点击恢复）'"
            @click="autoRefresh = !autoRefresh"
          >
            <i></i><span>自动刷新</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 上传入口（点击触发；目录上传保留 webkitRelativePath 层级） -->
    <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked">
    <input ref="dirInput" type="file" webkitdirectory multiple hidden @change="onFilesPicked">

    <!-- 浮层菜单：右键 / 行内 ⋯ / 头部上传，三处共用（D2/D4） -->
    <div
      v-if="menu"
      class="fs-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <template v-if="menu.kind === 'upload'">
        <div class="mh">{{ rootLabel }} / 根目录</div>
        <button @click="menuAction('upload', null)">
          <span class="mi" v-html="ICONS.upload"></span>上传文件
        </button>
        <button @click="menuAction('uploadDir', null)">
          <span class="mi" v-html="ICONS.folder"></span>上传文件夹<span class="k">保留层级</span>
        </button>
      </template>
      <template v-else-if="menu.node">
        <div class="mh" :title="menu.node.path">{{ menu.node.path || rootLabel }}</div>
        <button v-if="menu.node.type === 'dir'" @click="menuAction('upload', menu.node)">
          <span class="mi" v-html="ICONS.upload"></span>上传到此目录
        </button>
        <button v-if="menu.node.type === 'dir'" @click="menuAction('uploadDir', menu.node)">
          <span class="mi" v-html="ICONS.folder"></span>上传目录到此
        </button>
        <button v-if="menu.node.type === 'dir'" @click="menuAction('mkdir', menu.node)">
          <span class="mi" v-html="ICONS.plus"></span>新建子目录
        </button>
        <button @click="menuAction('download', menu.node)">
          <span class="mi" v-html="ICONS.download"></span>{{ menu.node.type === 'dir' ? '下载目录（zip）' : '下载文件' }}
        </button>
        <button @click="menuAction('rename', menu.node)">
          <span class="mi" v-html="ICONS.pen"></span>重命名 / 移动<span class="k">F2</span>
        </button>
        <div class="sep"></div>
        <button @click="menuAction('copy', menu.node)">
          <span class="mi" v-html="ICONS.copy"></span>复制相对路径
        </button>
        <button class="danger" @click="menuAction('delete', menu.node)">
          <span class="mi" v-html="ICONS.trash"></span>删除<span class="k">Del</span>
        </button>
      </template>
      <template v-else>
        <div class="mh">{{ rootLabel }}</div>
        <button @click="menuAction('upload', null)">
          <span class="mi" v-html="ICONS.upload"></span>上传到根目录
        </button>
        <button @click="menuAction('uploadDir', null)">
          <span class="mi" v-html="ICONS.folder"></span>上传目录（保留层级）
        </button>
        <button @click="menuAction('mkdir', null)">
          <span class="mi" v-html="ICONS.plus"></span>新建目录
        </button>
        <button @click="menuAction('download', null)">
          <span class="mi" v-html="ICONS.download"></span>下载整个工作空间（zip）
        </button>
        <div class="sep"></div>
        <button @click="menuAction('copy', null)">
          <span class="mi" v-html="ICONS.copy"></span>复制根路径
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ===== 面板：默认宽度使对话区（chat-main）恰占 1/3，即面板 = 容器 2/3 − 会话侧栏 220px；
        收起 0；拖拽中停用过渡 ===== */
.files-panel {
  /* 默认与对话区按 2/3 : 1/3 拆分（100% 为对话行宽度，已含左侧菜单之外的全部空间，再扣除分割条 5px） */
  --fpw: calc((100% - 5px) * 2 / 3);
  width: var(--fpw);
  flex: none;
  height: 100%;
  display: flex;
  background: var(--panel);
  border-left: 1px solid var(--line);
  overflow: hidden;
  transition: width 0.18s ease;
}
.files-panel:not(.open) { width: 0; border-left: none; }
.files-panel.dragging { transition: none; }
/* 中屏 901~1400px：会话侧栏被隐藏（见 style.css），同样按 2/3 : 1/3 拆分 */
@media (min-width: 901px) and (max-width: 1400px) {
  .files-panel { --fpw: calc((100% - 5px) * 2 / 3); }
}

.splitter {
  width: 5px;
  flex: none;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
}
.splitter:hover,
.splitter:active { background: var(--brand-weak); }

.files-body { flex: 1; display: flex; min-width: 0; overflow: hidden; }
/* 预览 / 目录 内部分割条 */
.side-split {
  width: 5px;
  flex: none;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
}
.side-split:hover,
.side-split:active { background: var(--brand-weak); }
/* 拖拽中禁止选中文本，避免拖出蓝色选区 */
.files-body.side-dragging { user-select: none; cursor: col-resize; }

/* ===== 左：预览（Task-20261027-001 起改为 flex column：标签行 + 滚动区 / 终端） ===== */
.files-viewer {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 滚动下沉到 .fv-scroll 与终端内部，本层不再滚动 */
}
.fv-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  padding: 12px 18px 14px;
}

/* ---------- 预览区标签行（文件预览 / 终端 共用一行） ---------- */
.viewer-tabs {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 34px;
  padding: 0 8px;
  background: var(--bar-bg);
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none; /* 页签多时横向滚动，但不显示滚动条 */
}
.viewer-tabs::-webkit-scrollbar { height: 0; }
.vtab {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  height: 34px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.13s, border-color 0.13s, background 0.13s;
}
.vtab:hover { color: var(--text-2); background: var(--hover); }
/* 选中态：2px brand 下划线（与既有 .fv-head / .md-mode 的克制风格一致） */
.vtab.on {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--brand);
  background: transparent;
}
.vtab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 终端页签状态圆点：绿=运行、灰=已退出、黄=连接中/重连、红=不可用 */
.vtab-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
}
.vtab-dot.running { background: var(--ok); }
.vtab-dot.busy { background: var(--brand); animation: vtab-pulse 1.1s ease-in-out infinite; }
.vtab-dot.connecting,
.vtab-dot.offline { background: var(--warn); animation: vtab-pulse 1.1s ease-in-out infinite; }
.vtab-dot.exited { background: var(--muted); }
.vtab-dot.unsupported,
.vtab-dot.denied { background: var(--danger); }
@keyframes vtab-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.vtab-x {
  flex: none;
  width: 14px;
  height: 14px;
  line-height: 14px;
  text-align: center;
  font-size: 10px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.13s, background 0.13s;
}
.vtab:hover .vtab-x { opacity: 0.55; }
.vtab-x:hover { opacity: 1; background: var(--active); color: var(--danger); }
.vtab-add {
  flex: none;
  width: 26px;
  height: 34px;
  font-size: 14px;
  color: var(--muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.13s, background 0.13s;
}
.vtab-add:hover { color: var(--brand); background: var(--hover); }

.fv-empty { color: var(--muted); font-size: 13px; text-align: center; padding: 48px 0; }
.fv-err { color: var(--danger); font-size: 13px; padding: 12px 0; }
.fv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.fv-name { font-size: 13px; font-weight: 600; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fv-back {
  flex: none;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 1px 8px;
  font-size: 12px;
  cursor: pointer;
  color: var(--muted);
}
.fv-back:hover { color: var(--brand); border-color: var(--brand-weak); }
.fv-meta { font-size: 11px; color: var(--muted); flex: none; }
.fv-trunc { font-size: 11px; color: var(--warn); background: var(--warn-weak); border-radius: 999px; padding: 1px 8px; flex: none; }
.fv-tools { display: flex; align-items: center; gap: 6px; margin: -2px 0 10px; }
.fv-tools input { flex: 0 1 280px; min-width: 120px; padding: 4px 9px; font-size: 12.5px; border-radius: 7px; }
.fv-tools .fv-hits { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.fv-tools .fv-hits.none { color: var(--warn); }
.fv-tools button {
  flex: none;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 2px 7px;
  font-size: 10px;
  cursor: pointer;
  color: var(--muted);
}
.fv-tools button:hover { color: var(--brand); border-color: var(--brand-weak); }

/* md 预览/源码 分段切换（fv-head 右缘） */
.md-mode { margin-left: auto; flex: none; display: flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.md-mode button {
  border: none;
  background: var(--panel);
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
  color: var(--muted);
}
.md-mode button + button { border-left: 1px solid var(--line); }
.md-mode button.on { background: var(--brand-weak); color: var(--brand); font-weight: 600; }

.fv-md { font-size: 13.5px; line-height: 1.7; }
.fv-md :deep(h1),
.fv-md :deep(h2) { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.fv-md :deep(pre) {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
}
.fv-md :deep(code) { font-family: var(--mono); font-size: 12.5px; }
.fv-md :deep(pre code) { background: none; padding: 0; }
.fv-md :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.fv-md :deep(th),
.fv-md :deep(td) { border: 1px solid var(--line); padding: 5px 10px; }
.fv-md :deep(blockquote) { border-left: 3px solid var(--line); margin: 8px 0; padding: 2px 12px; color: var(--muted); }

.fv-code {
  margin: 0;
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
}
.fv-code code { font-family: inherit; }

/* html/pdf 预览 iframe（白底保证深色主题下文档页仍按原色显示） */
.fv-frame {
  width: 100%;
  height: calc(100vh - 215px);
  min-height: 320px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}
/* 图片预览：白底衬托透明像素，限高防超长图撑爆视口 */
.fv-img {
  max-width: 100%;
  max-height: calc(100vh - 260px);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}
/* xlsx 多 sheet 切换条 */
.fv-sheets { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.fv-sheets button {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 2px 10px;
  font-size: 11.5px;
  cursor: pointer;
  color: var(--muted);
}
.fv-sheets button.on { background: var(--brand-weak); color: var(--brand); border-color: var(--brand-weak); font-weight: 600; }
/* csv/tsv/xlsx 表格预览 */
.fv-grid { border-collapse: collapse; font-size: 12.5px; font-family: var(--mono); background: var(--panel); }
.fv-grid td {
  border: 1px solid var(--line);
  padding: 3px 9px;
  white-space: nowrap;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fv-cap { font-size: 11px; color: var(--muted); margin-top: 6px; }
/* 旧格式占位卡 */
.fv-nosup { padding: 64px 0; }
.fv-nosup .big { font-size: 13.5px; font-weight: 600; margin-bottom: 6px; }
.fv-nosup .sub { font-size: 12px; color: var(--muted); }
/* pptx 渲染容器：白底圆角与其他文档视图一致；分页 DOM 由库注入 */
.fv-pptx {
  min-height: 240px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  overflow: auto;
}
/* 文内搜索命中：mark 由 JS 动态创建、无 scoped 属性，需 :deep 穿透 */
.files-viewer :deep(mark.fp-hit) {
  background: rgba(255, 200, 0, 0.4);
  color: inherit;
  border-radius: 2px;
}
.files-viewer :deep(mark.fp-hit.cur) { background: #f0883e; color: #fff; }

/* ===== 右：文件目录（20261026-001 重设计） =====
   令牌全部取自 style.css，零新增全局变量（D10）：
   --guide → --line-strong、--panel-2 → --bar-bg、--mark → --warn-weak、--t-file → --muted */

.files-side {
  /* 行高与缩进步长：树行节奏的唯一来源，骨架屏与引导线都按它算 */
  --row-h: 26px;
  --step: 14px;
  width: 264px; /* D1：240 → 264，刚好容纳「搜索框 + 3 个 26px 图标按钮」不换行 */
  flex: none;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
  container-type: inline-size; /* D11：面板内宽度自适应，靠拖拽宽度而非视口 */
}

/* ---- 头部：搜索 + 新建 / 上传 / 刷新，一行 ≤64px（D2） ---- */
.pn-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
}
.search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: var(--radius-ctl);
  background: var(--panel);
  transition: border-color 0.15s;
}
.search:focus-within { border-color: var(--brand); }
.search .s-ico { display: flex; flex: none; color: var(--muted); }
.search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.search input::placeholder { color: var(--muted); }
.s-clr {
  flex: none;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.s-clr:hover { color: var(--danger); }
.ib {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-ctl);
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.ib:hover:not(:disabled) { color: var(--brand); border-color: var(--brand); background: var(--brand-weak); }
.ib:disabled { opacity: 0.45; cursor: default; }
.ib svg { display: block; }
.ib.spin svg { animation: fp-spin 1s linear infinite; }
@keyframes fp-spin { to { transform: rotate(360deg); } }

/* ---- 上传进度细线：贴头部下沿（D8） ---- */
.up { flex: none; height: 3px; background: transparent; transition: background 0.2s; }
.up.on { background: var(--line-soft); }
.up i { display: block; height: 100%; width: 0; background: var(--brand); transition: width 0.2s ease; }

/* ---- 面包屑（D9） ---- */
.crumb {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 8px;
  border-bottom: 1px solid var(--line-soft);
  overflow: hidden;
}
.crumb .c {
  max-width: 96px;
  padding: 1px 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.crumb .c:hover { color: var(--brand); background: var(--hover); }
.crumb .c.last { color: var(--text-2); font-weight: 600; cursor: default; }
.crumb .c.last:hover { color: var(--text-2); background: none; }
.crumb .sep { flex: none; font-size: 10px; color: var(--line-strong); }

/* ---- 树 / 搜索结果容器 ---- */
.fs-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px;
}

/* ---- 树行（D3/D4/D5） ---- */
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  height: var(--row-h);
  padding-left: calc(5px + var(--lv, 0) * var(--step));
  padding-right: 6px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-2);
  white-space: nowrap;
  cursor: pointer;
  outline: none;
}
.row:hover { background: var(--hover); }
.row:focus-visible { box-shadow: inset 0 0 0 2px var(--brand); }
.row.sel { background: var(--brand-weak); }
/* 选中定位色条：整行唯一的强指示，长列表里一眼找到 */
.row.sel::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--brand);
}
.row.sel .nm { color: var(--brand); font-weight: 600; }
.row.drop { background: var(--brand-weak); box-shadow: inset 0 0 0 1px var(--brand); }
/* 层级引导线：每层一条 1px 竖线，四层以上也能看清归属 */
.gl {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line-strong);
  opacity: 0.6;
  pointer-events: none;
}
.twisty {
  width: 15px;
  height: 15px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  transition: transform 0.12s ease;
}
.row.open .twisty { transform: rotate(90deg); }
.twisty svg { display: block; }
.space { width: 15px; flex: none; }
.row .ico { display: flex; flex: none; color: var(--muted); }
.row .ico.dir { color: var(--brand); }
.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
.row.dir .nm { font-weight: 500; }
.meta { flex: none; padding-left: 6px; font-size: 10px; color: var(--muted); transition: opacity 0.12s; }
.row:hover .meta { opacity: 0; }

/* 行内操作：2 个高频 + ⋯，hover / focus 淡入，用渐变遮住底下的 meta（D4） */
.acts {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: 1px;
  padding-left: 12px;
  opacity: 0;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--panel) 36%);
  transition: opacity 0.12s;
}
.row.sel .acts { background: linear-gradient(90deg, transparent, var(--brand-weak) 36%); }
.row:hover .acts,
.row:focus-within .acts { opacity: 1; pointer-events: auto; }
.acts button {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.acts button:hover { background: var(--brand-weak); color: var(--brand); }
.acts button svg { display: block; }

/* ---- 搜索结果：按文件分组 + 命中数 + 高亮（D6） ---- */
.res-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 11px;
  color: var(--muted);
}
.res-head b { color: var(--text-2); font-weight: 600; }
.res-head button {
  padding: 1px 5px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}
.res-head button:hover { color: var(--danger); background: var(--danger-weak); }
.res-trunc { padding: 3px 9px; font-size: 10.5px; color: var(--warn); }
.res-group { padding: 2px 0; }
.res-file {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.res-file:hover { background: var(--hover); }
.res-file .ico { display: flex; flex: none; color: var(--muted); }
.res-file .dir {
  max-width: 44%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--muted);
}
.res-file .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text);
}
.res-file .n {
  margin-left: auto;
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: var(--bar-bg);
  font-size: 10px;
  color: var(--muted);
}
.res-hit {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 2px 8px 2px 22px;
  font-size: 11.5px;
  cursor: pointer;
}
.res-hit:hover { background: var(--hover); }
.res-hit .ln {
  width: 30px;
  flex: none;
  text-align: right;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
}
.res-hit .tx {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  color: var(--text-2);
}
.res-hit mark {
  padding: 0 1px;
  border-radius: 2px;
  background: var(--warn-weak);
  color: var(--text);
}

/* ---- 四态（D7） ---- */
.skel { padding: 8px 5px; }
.sk { display: flex; align-items: center; gap: 8px; height: var(--row-h); }
.sk .sq { width: 13px; height: 13px; flex: none; border-radius: 3px; background: var(--line-soft); }
.sk .ln {
  height: 8px;
  border-radius: 4px;
  background: var(--line-soft);
  animation: fp-shimmer 1.3s ease-in-out infinite;
}
@keyframes fp-shimmer { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }

.empt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 34px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
.empt .big { color: var(--line-strong); }
.empt b { font-size: 12.5px; font-weight: 600; color: var(--text-2); }
.empt .sub { max-width: 208px; font-size: 11.5px; line-height: 1.55; word-break: break-word; }
.empt button {
  margin-top: 3px;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-ctl);
  background: var(--panel);
  color: var(--text-2);
  font-size: 11.5px;
  cursor: pointer;
}
.empt button:hover { color: var(--brand); border-color: var(--brand); }

/* 拖拽浮层：整块覆盖 + 明确目标路径 */
.drop {
  position: absolute;
  inset: 6px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1.5px dashed var(--brand);
  border-radius: var(--radius-card);
  background: var(--brand-weak);
  color: var(--brand);
  font-size: 12.5px;
  font-weight: 600;
  pointer-events: none;
}
.drop .d-ico { display: flex; }
.drop .sub { font-size: 11px; font-weight: 400; opacity: 0.85; }

/* ---- 底部状态条（D8） ---- */
.fs-foot {
  flex: none;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 9px;
  border-top: 1px solid var(--line);
  background: var(--bar-bg);
  font-size: 11px;
  color: var(--muted);
}
.fs-foot .cnt { flex: none; white-space: nowrap; }
/* 隐藏项视觉开关：checkbox 藏起，保留原生可访问性与键盘焦点 */
.sw {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.sw input { position: absolute; width: 0; height: 0; opacity: 0; }
.sw .tk {
  position: relative;
  width: 22px;
  height: 13px;
  flex: none;
  border-radius: 7px;
  background: var(--line-strong);
  transition: background 0.15s;
}
.sw .tk::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--panel);
  transition: transform 0.15s;
}
.sw input:checked + .tk { background: var(--brand); }
.sw input:checked + .tk::after { transform: translateX(9px); }
.sw input:focus-visible + .tk { outline: 2px solid var(--brand); outline-offset: 2px; }
/* 自动刷新指示灯：仍可点击暂停（不丢现有能力） */
.live {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 2px 4px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.live:hover { background: var(--hover); color: var(--text-2); }
.live i {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--ok);
  animation: fp-pulse 2.4s ease-in-out infinite;
}
.live.off i { background: var(--muted); animation: none; }
@keyframes fp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ---- 浮层菜单：右键 / 行内 ⋯ / 头部上传三处共用；fixed 定位不受面板 overflow 影响 ---- */
.fs-menu {
  position: fixed;
  z-index: 60;
  min-width: 188px;
  max-width: 224px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: var(--shadow-pop);
}
.fs-menu .mh {
  max-width: 212px;
  padding: 4px 9px 5px;
  margin-bottom: 3px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fs-menu .sep { height: 1px; margin: 3px 0; background: var(--line-soft); }
.fs-menu button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.fs-menu button:hover { background: var(--hover); color: var(--brand); }
.fs-menu .mi { display: flex; flex: none; color: var(--muted); }
.fs-menu button:hover .mi { color: var(--brand); }
.fs-menu .k { margin-left: auto; padding-left: 12px; font-size: 10px; color: var(--muted); }
.fs-menu button.danger { color: var(--danger); }
.fs-menu button.danger:hover { background: var(--danger-weak); color: var(--danger); }
.fs-menu button.danger:hover .mi { color: var(--danger); }

/* ---- 窄面板：容器查询（D11）。面板宽度由拖拽决定，与视口无关 ---- */
@container (max-width: 246px) {
  .pn-head { gap: 2px; padding: 7px 6px; }
  .search { padding: 0 6px; }
  .search .s-ico { display: none; }
  .ib { width: 24px; height: 24px; }
  .fs-foot { gap: 5px; padding: 0 6px; }
  /* 状态条只留开关本体与指示灯，文字靠 title 提示 */
  .sw > span:last-child,
  .live > span { display: none; }
}

/* ===== 窄屏：浮层 + 遮罩，树在上，分割条停用 ===== */
.fp-mask { display: none; }
@media (max-width: 900px) {
  .fp-mask {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 40;
  }
  .files-panel {
    --fpw: min(440px, 92vw);
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    width: var(--fpw) !important; /* 覆盖拖拽内联宽度 */
    border-left: 1px solid var(--line);
  }
  .splitter { display: none; }
  .files-body { flex-direction: column; }
  .files-side {
    order: -2;
    width: auto;
    flex: none;
    max-height: 45%;
    border-left: none;
    border-bottom: 1px solid var(--line);
  }
  .files-viewer { order: -1; min-height: 0; }
}
</style>
