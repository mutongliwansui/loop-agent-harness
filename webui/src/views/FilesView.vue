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
import { highlightIn, renderMarkdown } from '../markdown.js';
import { renderMermaidIn } from '../mermaid.js';
// pptx Worker 脚本 URL：库默认按 import.meta.url 相对解析 worker 路径，vite 打包后失效，必须显式传入
import pptxWorkerUrl from '@file-viewer/pptx/worker/pptx.worker.js?url';

interface FsNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: FsNode[];
}
interface SearchResult {
  path: string;
  name: string;
  line: number;
  text: string;
}

const props = defineProps<{ wsPath: string }>();
const open = defineModel<boolean>('open', { default: true });

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

/** 树扁平化为行（仅渲染展开目录的子级） */
const rows = computed(() => {
  const out: { node: FsNode; depth: number }[] = [];
  const walk = (nodes: FsNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.type === 'dir' && expanded.value.has(n.path)) walk(n.children ?? [], depth + 1);
    }
  };
  walk(tree.value, 0);
  return out;
});
const emptyHint = computed(() => (props.wsPath ? '（空）' : '无活跃会话所属工作空间'));

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
const mdHtml = computed(() =>
  fileData.value && (kind.value === 'md' || kind.value === 'doc') ? renderMarkdown(fileData.value.content) : '',
); // doc：后端 /fs/doc2md 已把提取文本转成 markdown，复用 md 渲染管线
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

/** 行级拖拽：仅目录行可作为落点（文件行忽略，避免误传到根） */
function onDragOverRow(e: DragEvent, node: FsNode): void {
  if (node.type === 'dir') onDragOver(e, node.path);
}

function onDropRow(e: DragEvent, node: FsNode): void {
  e.preventDefault();
  e.stopPropagation();
  if (node.type === 'dir') void onDrop(e, node.path);
}

/* ---- 右键菜单 ---- */
interface MenuState {
  x: number;
  y: number;
  node: FsNode | null; // null = 树空白处（操作根目录）
}
const menu = ref<MenuState | null>(null);

function openMenu(e: MouseEvent, node: FsNode | null): void {
  e.preventDefault();
  e.stopPropagation();
  menu.value = { x: e.clientX, y: e.clientY, node };
}

function closeMenu(): void {
  menu.value = null;
}

/** 树空白处菜单代表的根节点（下载整个工作空间用） */
const rootNode = computed<FsNode>(() => ({ name: props.wsPath, path: '', type: 'dir' }));

/** 菜单动作分发：先关菜单再执行，node 为 null 表示根目录 */
function menuAction(
  kind: 'upload' | 'uploadDir' | 'mkdir' | 'download' | 'rename' | 'delete',
  node: FsNode | null,
): void {
  closeMenu();
  if (kind === 'upload') return pickFiles(node?.path ?? '');
  if (kind === 'uploadDir') return pickDir(node?.path ?? '');
  if (kind === 'mkdir') {
    void createDir(node?.path ?? '');
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
const SIDE_MIN = 160; // 目录区最小宽度
const SIDE_DEFAULT = 240; // 与 .files-side 默认宽度一致
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
  showToast('已恢复默认占比（目录 240px）', 'success');
}

watch(open, (v) => {
  if (!v) {
    savedW = splitterW.value;
  } else if (savedW) {
    splitterW.value = savedW;
    savedW = 0;
  }
});

function fmtBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
</script>

<template>
  <!-- 窄屏遮罩（宽屏不渲染显示） -->
  <div v-if="open" class="fp-mask" @click="open = false"></div>

  <div ref="panelEl" class="files-panel" :class="{ open, dragging }" :style="panelStyle">
    <div class="splitter" title="拖拽调整宽度；双击恢复默认" @pointerdown="onSplitDown" @dblclick="onSplitDbl"></div>

    <div ref="bodyEl" class="files-body" :class="{ 'side-dragging': sideDragging }">
      <!-- 左：文件预览 -->
      <div ref="viewerEl" class="files-viewer">
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
          <!-- eslint-disable-next-line vue/no-v-html — 内容经 DOMPurify 消毒 -->
          <div v-else-if="kind === 'md' && viewMode === 'prev'" ref="mdEl" class="fv-md" v-html="mdHtml" @click="onMdClick"></div>
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
          <!-- eslint-disable-next-line vue/no-v-html — 内容经 DOMPurify 消毒 -->
          <div v-else-if="kind === 'doc'" class="fv-md" v-html="mdHtml"></div>
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

      <!-- 预览 / 目录 分割条：拖拽调整占比，双击恢复默认 -->
      <div
        class="side-split"
        title="拖拽调整预览与目录宽度；双击恢复默认"
        @pointerdown="onSideSplitDown"
        @dblclick="onSideSplitDbl"
      ></div>

      <!-- 右：搜索 + 文件树 -->
      <div class="files-side" :style="sideStyle">
        <div class="fs-tools">
          <div class="fs-search">
            <input v-model="searchKw" type="text" placeholder="搜索文件内容…">
            <button v-if="searchKw || searchResults.length" title="清除搜索" @click="clearSearch">✕</button>
          </div>
          <div class="fs-chk-row">
            <label class="fs-chk" title="在树与搜索中显示 dot 开头的隐藏目录">
              <input v-model="showHidden" type="checkbox"> 隐藏目录
            </label>
            <label class="fs-chk" title="每 1 秒比对目录指纹，外部新增/删除/改名后自动更新">
              <input v-model="autoRefresh" type="checkbox"> 自动刷新
            </label>
            <button
              class="fs-refresh"
              :disabled="refreshing || !wsPath"
              title="立即重拉已展开的目录"
              @click="refreshNow"
            >{{ refreshing ? '刷新中…' : '↻' }}</button>
          </div>
          <!-- 写操作入口（优化建议 20261021-005）：根目录下的新建/上传，目录行另有行内入口 -->
          <div class="fs-actions">
            <button :disabled="!wsPath" title="在工作空间根目录新建目录" @click="createDir('')">＋ 目录</button>
            <button :disabled="!wsPath" title="上传文件到工作空间根目录" @click="pickFiles('')">↑ 文件</button>
            <button :disabled="!wsPath" title="上传整个目录（保留层级）到工作空间根目录" @click="pickDir('')">↑ 目录</button>
            <span v-if="uploading" class="fs-up">上传 {{ uploading.done }}/{{ uploading.total }}</span>
          </div>
        </div>
        <div
          class="fs-list"
          :class="{ 'drop-root': dropTarget === '' }"
          @contextmenu.prevent="openMenu($event, null)"
          @dragover="onDragOver($event, '')"
          @dragleave="onDragLeave"
          @drop="onDrop($event, '')"
        >
          <div v-if="treeLoading" class="fs-hint">加载中…</div>
          <div v-else-if="treeError" class="fs-hint">⚠ {{ treeError }}</div>
          <template v-else-if="searchKw.trim()">
            <div v-if="searching" class="fs-hint">搜索中…</div>
            <template v-else-if="searchResults.length">
              <div class="sr-cap">
                {{ searchTruncated ? `结果过多，仅显示前 ${searchResults.length} 条` : `${searchResults.length} 条结果` }}
              </div>
              <div
                v-for="r in searchResults"
                :key="r.path + ':' + r.line"
                class="sr-row"
                :title="`${r.path}:${r.line}`"
                @click="openFile(r.path)"
              >
                <div class="p">{{ r.path }}<span class="ln"> :{{ r.line }}</span></div>
                <div class="t">{{ r.text }}</div>
              </div>
            </template>
            <div v-else class="fs-hint">无匹配</div>
          </template>
          <div v-else-if="rows.length === 0" class="fs-hint">{{ emptyHint }}</div>
          <template v-else>
            <div
              v-for="r in rows"
              :key="r.node.path"
              class="tree-row"
              :class="{
                sel: r.node.type === 'file' && r.node.path === selected,
                drop: r.node.type === 'dir' && dropTarget === r.node.path,
              }"
              :style="{ paddingLeft: 6 + r.depth * 13 + 'px' }"
              :title="r.node.path"
              @click="onRowClick(r.node)"
              @contextmenu="openMenu($event, r.node)"
              @dragover="onDragOverRow($event, r.node)"
              @dragleave="onDragLeave"
              @drop="onDropRow($event, r.node)"
            >
              <span class="tw">{{ r.node.type !== 'dir' ? '' : loadingDirs.has(r.node.path) ? '…' : (expanded.has(r.node.path) ? '▼' : '▶') }}</span>
              <span class="nm">{{ r.node.type === 'dir' ? '📁' : '📄' }} {{ r.node.name }}</span>
              <span v-if="r.node.type === 'file'" class="sz">{{ fmtBytes(r.node.size ?? 0) }}</span>
              <!-- 行内操作：悬停显示（右键菜单提供同一组操作） -->
              <span class="ops" @click.stop>
                <button
                  v-if="r.node.type === 'dir'"
                  title="上传文件到该目录"
                  @click="pickFiles(r.node.path)"
                >↑</button>
                <button title="重命名 / 移动" @click="startRename(r.node)">✎</button>
                <button :title="r.node.type === 'dir' ? '下载目录（zip）' : '下载文件'" @click="downloadEntry(r.node)">⤓</button>
                <button class="danger" title="删除" @click="removeEntry(r.node)">✕</button>
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 上传入口（点击触发；目录上传保留 webkitRelativePath 层级） -->
    <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked">
    <input ref="dirInput" type="file" webkitdirectory multiple hidden @change="onFilesPicked">

    <!-- 右键菜单（空白处 = 根目录操作） -->
    <div v-if="menu" class="fs-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <template v-if="menu.node">
        <button v-if="menu.node.type === 'dir'" @click="menuAction('upload', menu.node)">↑ 上传到此目录</button>
        <button v-if="menu.node.type === 'dir'" @click="menuAction('uploadDir', menu.node)">↑ 上传目录到此</button>
        <button v-if="menu.node.type === 'dir'" @click="menuAction('mkdir', menu.node)">＋ 新建子目录</button>
        <button @click="menuAction('download', menu.node)">⤓ {{ menu.node.type === 'dir' ? '下载目录（zip）' : '下载文件' }}</button>
        <button @click="menuAction('rename', menu.node)">✎ 重命名 / 移动</button>
        <button class="danger" @click="menuAction('delete', menu.node)">✕ 删除</button>
      </template>
      <template v-else>
        <button @click="menuAction('upload', null)">↑ 上传到根目录</button>
        <button @click="menuAction('uploadDir', null)">↑ 上传目录（保留层级）</button>
        <button @click="menuAction('mkdir', null)">＋ 新建目录</button>
        <button @click="menuAction('download', null)">⤓ 下载整个工作空间（zip）</button>
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

/* ===== 左：预览 ===== */
.files-viewer { flex: 1; min-width: 0; overflow: auto; padding: 14px 18px; }
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

/* ===== 右：搜索 + 树 ===== */
.files-side {
  width: 240px;
  flex: none;
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.fs-tools { padding: 10px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.fs-search { display: flex; gap: 6px; }
.fs-search input { flex: 1; min-width: 0; padding: 5px 9px; font-size: 12.5px; border-radius: 7px; }
.fs-search button {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 0 8px;
  cursor: pointer;
  color: var(--muted);
}
.fs-chk { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
/* 工具行：隐藏目录 / 自动刷新 / 手动刷新按钮 */
.fs-chk-row { display: flex; align-items: center; gap: 10px; }
.fs-refresh {
  margin-left: auto;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 1px 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
  cursor: pointer;
}
.fs-refresh:hover:not(:disabled) { color: var(--brand); border-color: var(--brand-weak); }
.fs-refresh:disabled { opacity: 0.45; cursor: default; }
/* 写操作入口行（新建目录 / 上传文件 / 上传目录） */
.fs-actions { display: flex; align-items: center; gap: 6px; }
.fs-actions button {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 7px;
  padding: 1px 7px;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
}
.fs-actions button:hover:not(:disabled) { color: var(--brand); border-color: var(--brand-weak); }
.fs-actions button:disabled { opacity: 0.45; cursor: default; }
.fs-up { margin-left: auto; font-size: 11px; color: var(--brand); white-space: nowrap; }
.fs-list { flex: 1; overflow: auto; padding: 6px; }
.fs-hint { color: var(--muted); font-size: 12px; text-align: center; padding: 16px 0; }
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
}
.tree-row:hover { background: var(--bg); }
.tree-row.sel { background: var(--brand-weak); }
.tree-row.sel .nm { color: var(--brand); font-weight: 600; }
.tree-row .tw { width: 11px; font-size: 8.5px; color: var(--muted); flex: none; text-align: center; }
.tree-row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tree-row .sz { margin-left: auto; font-size: 10px; color: var(--muted); flex: none; padding-left: 6px; }
/* 行内操作：默认隐藏，悬停显示（右键菜单提供同一组操作） */
.tree-row .ops { display: none; flex: none; gap: 1px; margin-left: 4px; }
.tree-row:hover .ops { display: inline-flex; }
.tree-row .ops button {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  padding: 0 3px;
  border-radius: 4px;
  cursor: pointer;
}
.tree-row .ops button:hover { background: var(--brand-weak); color: var(--brand); }
.tree-row .ops button.danger:hover { background: var(--danger-weak); color: var(--danger); }
/* 拖拽落点高亮 */
.tree-row.drop { background: var(--brand-weak); outline: 1px dashed var(--brand); outline-offset: -1px; }
.fs-list.drop-root { outline: 1px dashed var(--brand); outline-offset: -4px; }
/* 右键菜单：fixed 定位（面板 overflow:hidden 不影响） */
.fs-menu {
  position: fixed;
  z-index: 60;
  min-width: 176px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.18);
}
.fs-menu button {
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 5px 9px;
  font-size: 12.5px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.fs-menu button:hover { background: var(--bg); color: var(--brand); }
.fs-menu button.danger { color: var(--danger); }
.fs-menu button.danger:hover { background: var(--danger-weak); }
.sr-cap { font-size: 11px; color: var(--muted); padding: 4px 6px; }
.sr-row { padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.sr-row:hover { background: var(--bg); }
.sr-row .p { font-size: 12px; font-weight: 600; color: var(--brand); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-row .p .ln { color: var(--muted); font-weight: 400; }
.sr-row .t {
  font-size: 11.5px;
  color: var(--muted);
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
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
