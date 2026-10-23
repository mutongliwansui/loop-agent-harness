// stream-blocks.ts：流式文本段 → 稳定块序列（Task-20261023-002 D1/D2/D8）
//
// 为什么需要切分：改造前 ChatView 用单个 v-html 渲染整段文本，每个 chunk 都整体重写
// innerHTML，手动插入的图表容器必被 Vue 抹掉，所以图表只能等整条消息结束后统一渲染。
// 切成块数组用 v-for 渲染后，key = 块序号 + 内容指纹：内容未变的块 Vue 复用 DOM 且不重写
// innerHTML，块内 append 的图表容器得以原地存活；每个 chunk 只重渲尾部块。
//
// 切分边界（D2）：只在【顶层】围栏（行首无缩进）处切 ```mermaid / ```echarts；
// 列表项/引用块内的缩进围栏不切分，按普通代码块渲染（不参与图表渲染）。
// 未闭合围栏：流式中且为消息尾段 → pending 占位（D5，模板渲染「正在生成…」），
// 否则并入 md 块由 marked 按代码块处理。
//
// md → HTML 走 LRU 缓存（D8）：拆分后若每个 chunk 都重新 marked+DOMPurify 解析前面所有块，
// 开销会随消息长度平方增长；缓存按内容指纹命中，稳定块直接取 HTML。

import { renderMarkdown } from './markdown.js';

/** 图表代码块语言（与 mermaid.ts / echarts.ts 的 language-xxx 对应） */
export type ChartLang = 'mermaid' | 'echarts';

/** 普通 markdown 块：html 由 renderMarkdown 生成（已过 DOMPurify） */
export interface MdBlock {
  kind: 'md';
  k: string;
  text: string;
  html: string;
}

/** 已闭合的图表代码块：src 为围栏内原始文本（换行原样保留） */
export interface ChartBlock {
  kind: 'chart';
  k: string;
  lang: ChartLang;
  src: string;
}

/** 未闭合的图表围栏（流式中且为尾段）：显示 loading 占位而非裸源码 */
export interface PendingBlock {
  kind: 'pending';
  k: string;
  lang: ChartLang;
  partial: string;
  /** 已生成字符数（占位处展示，让用户知道仍在推进） */
  chars: number;
}

export type Block = MdBlock | ChartBlock | PendingBlock;

export interface SplitOptions {
  /** 流式输出中：决定未闭合围栏是否产出 pending 占位 */
  streaming?: boolean;
  /** 是否为该消息最后一个文本段：仅尾段才可能是"正在生成" */
  isTail?: boolean;
  /** md → HTML；默认 renderMarkdown。单测可注入纯函数实现，避免依赖 DOM */
  render?: (md: string) => string;
}

/** 顶层围栏起始行：行首无缩进 + 语言为 mermaid/echarts（info string 仅允许空白） */
const FENCE_OPEN = /^(`{3,})(mermaid|echarts)[ \t]*$/;
/** 闭合围栏：仅反引号与空白（CommonMark：闭合围栏不允许 info string） */
const FENCE_CLOSE = /^`{3,}[ \t]*$/;

/** md HTML 缓存上限（D8）：对话流通常只有少数几段稳定块，50 足够覆盖多消息切换 */
const MD_CACHE_MAX = 50;

/**
 * 内容指纹：djb2 哈希 + 原文长度。
 * 长度参与编码使「哈希碰撞且长度相同」才可能误判，块内容极小概率相同也不会错渲
 * （key 相同意味着内容指纹相同，Vue 复用 DOM 的前提即内容一致）。
 */
export function contentKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${s.length.toString(36)}`;
}

const mdCache = new Map<string, string>();

/** md → HTML（LRU 命中缓存，D8）；导出供单测验证缓存行为 */
export function renderMdCached(md: string, render: (s: string) => string = renderMarkdown): string {
  const key = contentKey(md);
  const hit = mdCache.get(key);
  if (hit !== undefined) {
    mdCache.delete(key); // 命中后移到队尾（LRU）
    mdCache.set(key, hit);
    return hit;
  }
  const html = render(md);
  mdCache.set(key, html);
  if (mdCache.size > MD_CACHE_MAX) {
    const oldest = mdCache.keys().next();
    if (!oldest.done) mdCache.delete(oldest.value);
  }
  return html;
}

/** 清空 md 缓存（单测用；运行期无需调用） */
export function clearMdCache(): void {
  mdCache.clear();
}

/** 去掉行尾 CR（Windows 换行下切分与围栏匹配不受 \r 干扰；原文保留仍用 raw） */
function chompCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 把文本段切分为稳定块序列。
 * 空文本返回 []（模板不渲染空块）；纯空白 md 块跳过（不产出空 div）。
 */
export function splitStreamBlocks(text: string, opts: SplitOptions = {}): Block[] {
  if (!text) return [];
  const { streaming = false, isTail = false, render = renderMarkdown } = opts;
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];
  let mdSeq = 0;
  let chartSeq = 0;

  const flushMd = (): void => {
    if (buf.length === 0) return;
    const md = buf.join('\n');
    buf = [];
    if (!md.trim()) return; // 纯空白不入块，交给相邻块的间距
    blocks.push({ kind: 'md', k: `m${mdSeq++}:${contentKey(md)}`, text: md, html: renderMdCached(md, render) });
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const open = FENCE_OPEN.exec(chompCR(raw));
    if (!open) {
      buf.push(raw);
      i++;
      continue;
    }
    const fenceLen = open[1].length;
    const lang = open[2] as ChartLang;
    // 向下找闭合围栏（闭合行只含反引号+空白，且不短于起始围栏）
    const body: string[] = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = chompCR(lines[j]);
      if (FENCE_CLOSE.test(l) && l.trim().length >= fenceLen) {
        closed = true;
        break;
      }
      body.push(chompCR(lines[j])); // 图表源码统一为 LF，避免 \r 干扰 mermaid / JSON
    }
    if (closed) {
      flushMd();
      const src = body.join('\n');
      blocks.push({ kind: 'chart', k: `c${chartSeq++}:${contentKey(src)}`, lang, src });
      i = j + 1;
      continue;
    }
    // 未闭合：仅「流式中 + 尾段」产出 pending 占位；否则按普通文本交回 md（流结束后可见源码）
    if (streaming && isTail) {
      flushMd();
      const partial = body.join('\n');
      blocks.push({
        kind: 'pending',
        // key 不含内容指纹：占位块的 div 需被 Vue 复用，否则每个 chunk 重建会让
        // 旋转动画从头播放（视觉上像卡住），且丢掉已产生的 DOM
        k: `p${chartSeq++}:${lang}`,
        lang,
        partial,
        chars: partial.length,
      });
      return blocks; // 尾段已到结尾，后续无内容
    }
    buf.push(raw);
    i++;
  }
  flushMd();
  return blocks;
}

/** 统计文本段中已闭合的图表块数量（ChatView 判「刚闭合出图表」用，D4） */
export function countChartBlocks(text: string, opts: SplitOptions = {}): number {
  let n = 0;
  for (const b of splitStreamBlocks(text, opts)) if (b.kind === 'chart') n++;
  return n;
}
