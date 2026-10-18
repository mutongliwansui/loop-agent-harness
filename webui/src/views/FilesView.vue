<script setup lang="ts">
// FilesView：工作空间文件浏览器（原型-20261018-001）
// 端点：GET /fs/tree?hidden=1（树）、GET /fs/file?path=（文本预览）、GET /fs/raw?path=（二进制文档）、
//       GET /fs/search?q=&hidden=1（搜索）
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
import { api, fetchRaw } from '../api/client.js';
import { showToast } from '../toast.js';
import DOMPurify from 'dompurify';
import { highlightIn, renderMarkdown } from '../markdown.js';
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

/* ================= 树 ================= */
const tree = ref<FsNode[]>([]);
const treeLoading = ref(false);
const treeError = ref('');
const showHidden = ref(false);
const expanded = ref(new Set<string>()); // 展开的目录 path 集合（整体替换实例以触发响应）

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
const emptyHint = computed(() => (props.wsPath ? '（空）' : '无当前工作空间'));

async function loadTree(): Promise<void> {
  if (!props.wsPath) {
    tree.value = [];
    return;
  }
  treeLoading.value = true;
  treeError.value = '';
  try {
    const r = await api<{ children: FsNode[] }>(`/fs/tree?hidden=${showHidden.value ? 1 : 0}`);
    tree.value = r.children ?? []; // 目录默认收起，点击展开
  } catch (e) {
    tree.value = [];
    treeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    treeLoading.value = false;
  }
}

function onRowClick(n: FsNode): void {
  if (n.type === 'dir') {
    const s = new Set(expanded.value);
    if (s.has(n.path)) s.delete(n.path);
    else s.add(n.path);
    expanded.value = s;
  } else {
    void openFile(n.path);
  }
}

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
  const blob = await fetchRaw(path);
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
        `/fs/${ep}?path=${encodeURIComponent(path)}`,
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
      `/fs/search?q=${encodeURIComponent(q)}&hidden=${showHidden.value ? 1 : 0}`,
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
  if (viewerKw.value.trim()) applyHits(); // 分支切换会丢掉 mark，重扫
});

/* ================= 工作空间切换 ================= */
watch(
  () => props.wsPath,
  () => {
    expanded.value = new Set();
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
    void loadTree();
  },
  { immediate: true },
);
onBeforeUnmount(releaseBinary); // 组件卸载释放 blob objectURL
watch(showHidden, () => {
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

    <div class="files-body">
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
          <div v-else-if="kind === 'md' && viewMode === 'prev'" class="fv-md" v-html="mdHtml" @click="onMdClick"></div>
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

      <!-- 右：搜索 + 文件树 -->
      <div class="files-side">
        <div class="fs-tools">
          <div class="fs-search">
            <input v-model="searchKw" type="text" placeholder="搜索文件内容…">
            <button v-if="searchKw || searchResults.length" title="清除搜索" @click="clearSearch">✕</button>
          </div>
          <label class="fs-chk" title="在树与搜索中显示 dot 开头的隐藏目录">
            <input v-model="showHidden" type="checkbox"> 隐藏目录
          </label>
        </div>
        <div class="fs-list">
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
              :class="{ sel: r.node.type === 'file' && r.node.path === selected }"
              :style="{ paddingLeft: 6 + r.depth * 13 + 'px' }"
              :title="r.node.path"
              @click="onRowClick(r.node)"
            >
              <span class="tw">{{ r.node.type === 'dir' ? (expanded.has(r.node.path) ? '▼' : '▶') : '' }}</span>
              <span class="nm">{{ r.node.type === 'dir' ? '📁' : '📄' }} {{ r.node.name }}</span>
              <span v-if="r.node.type === 'file'" class="sz">{{ fmtBytes(r.node.size ?? 0) }}</span>
            </div>
          </template>
        </div>
      </div>
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
.tree-row .nm { overflow: hidden; text-overflow: ellipsis; }
.tree-row .sz { margin-left: auto; font-size: 10px; color: var(--muted); flex: none; padding-left: 6px; }
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
