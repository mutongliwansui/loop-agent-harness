// OCR 版面还原（需求 20261112-003 / 任务 01、02）
//
// 为什么需要这一层：
//   WinRT 的 `OcrResult.Lines` 粒度比人眼所见更细——同一视觉行里的「名称」与「日期」
//   会被切成两个 Line（中间空白大），而 `OcrResult.Text` 更是用**空格**把全部行拼成一行。
//   实测（2026-11-12，1293×1164 文件列表截图）：Lines 45 行、Text 内换行符 0 个 →
//   直接把 Lines 一行一条输出仍是「名称一坨、日期一坨」，读不出表格。
//   正确做法：拿 `OcrWord.BoundingRect` 按 **y 中心聚类**重建视觉行（45 → 23 行，
//   21 条数据的名称与日期全部同行）。
//
// 职责边界：本文件是**纯函数层**（零 IO、零进程、可单测），只消费结构、不决定引擎行为。

import { mergeCjkSpaces } from './postprocess.js';
import type { OcrImageSize, OcrLayout, OcrLine, OcrWord } from './types.js';

/** 一个视觉行：成员词已按 x 升序，`centerY` 为成员中心的均值 */
export interface VisualLine {
  words: OcrWord[];
  centerY: number;
  /** 渲染后的行文本（列间距足够大时用 ` | ` 分隔） */
  text: string;
}

/** 版面渲染结果 */
export interface LayoutRenderResult {
  /** 渲染后的文本（未做 CJK 合并与空白收敛，由 run-ocr 统一后处理） */
  text: string;
  /** 实际生效的形态（table 不可用时回落 text） */
  applied: OcrLayout;
  /** 视觉行数 */
  lineCount: number;
  /** 词数 */
  wordCount: number;
  /** table 形态的列数（其他形态为 undefined） */
  columns?: number;
  /** 回落或降级说明（供 warnings） */
  warning?: string;
}

/** 视觉行聚类容差比例：相对中位字高（D3，绝对像素在不同 DPI / 字号间不可迁移） */
const TOL_RATIO = 0.6;

/** 列间距判定比例：大于 `中位字高 × COL_GAP_RATIO` 的横向空隙视为列分隔（D4） */
const COL_GAP_RATIO = 1.5;

/**
 * 紧邻判定比例：横向空隙小于 `中位字高 × TIGHT_GAP_RATIO` 视为「同一 token 被引擎切开」，
 * 拼接时不插空格。
 *
 * 依据（2026-11-12 真机实测，medH=16）：WinRT 会把 `2026/11/12` 切成
 * `2026` `/` `1` `1` `/` `1` `2` 等独立词，日期**内部**字符间隙实测 1–6px；
 * 而「日期」与「时间」之间的真实空格最小 7px（多为 8px）。取 0.40×medH≈6.4，
 * 落在 6 与 7 之间：日期内部合并成 `2026/11/12`，日期与时间之间保留空格
 * （`2026/11/4 15:19` 不会误成 `2026/11/415：19`）。比例取大到 0.45 会把 7px 交界也吞掉，
 * 取小到 0.3 又会让 6px 的 `11` 重新被拆开。
 */
const TIGHT_GAP_RATIO = 0.4;

/** 拉丁字母：两个相邻词若都以拉丁字母相接，即使是小间隙也不合并（否则 `hello world` 会粘连）。仅限字母，数字与标点应合并 */
const LATIN_WORD_END = /[A-Za-z]$/;
const LATIN_WORD_START = /^[A-Za-z]/;

/** 取中位数（原地不改入参） */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 词中心 y */
function centerY(word: OcrWord): number {
  return word.y + word.h / 2;
}

/** 中位字高：聚类容差与列间距都以它为基准 */
export function medianWordHeight(words: OcrWord[]): number {
  return median(words.filter((w) => w.h > 0).map((w) => w.h));
}

/**
 * 按 y 中心聚类重建视觉行（D3）。
 *
 * 算法：词按 y 中心升序，逐个与「当前最后一行」的中心比较，落在容差内则并入并滚动更新
 * 中心均值，否则新起一行。单遍滚动均值与「迭代收敛」在本场景等价，且不会把后续词
 * 吸进已封闭的行（排序保证单调），实测 45 → 23 行无错并。
 *
 * @param gapRatio 列间距比例；用于生成行文本里的 ` | ` 分隔符
 */
export function buildVisualLines(words: OcrWord[], gapRatio = COL_GAP_RATIO): VisualLine[] {
  const usable = words.filter((w) => typeof w.t === 'string' && w.t.trim() !== '');
  if (usable.length === 0) return [];

  const medH = medianWordHeight(usable);
  // max(3, …)：超小图（字高 4px）时 0.6 倍会退化成 0 容差，退化为「一词一行」
  const tolY = Math.max(3, medH * TOL_RATIO);
  const gapThreshold = Math.max(6, medH * gapRatio);
  const tightThreshold = medH * TIGHT_GAP_RATIO;

  const sorted = [...usable].sort((a, b) => centerY(a) - centerY(b));
  const buckets: { words: OcrWord[]; centerY: number }[] = [];
  for (const word of sorted) {
    const cy = centerY(word);
    const last = buckets[buckets.length - 1];
    if (last && Math.abs(cy - last.centerY) <= tolY) {
      last.words.push(word);
      const sum = last.words.reduce((acc, w) => acc + centerY(w), 0);
      last.centerY = sum / last.words.length;
    } else {
      buckets.push({ words: [word], centerY: cy });
    }
  }

  return buckets.map((bucket) => {
    const inLine = [...bucket.words].sort((a, b) => a.x - b.x);
    return {
      words: inLine,
      centerY: bucket.centerY,
      text: joinWords(inLine, gapThreshold, tightThreshold),
    };
  });
}

/** 两个相邻词之间应插入的分隔：`''`（紧邻）/ `' '`（词间）/ `' | '`（列间） */
function separatorFor(prev: OcrWord, next: OcrWord, gap: number, tightThreshold: number, gapThreshold: number): string {
  if (gap > gapThreshold) return ' | ';
  // 小间隙：若不是「拉丁字母 + 拉丁字母」相接，则视为同一 token 被引擎切开，不插空格
  if (gap < tightThreshold) {
    const latinBoundary = LATIN_WORD_END.test(prev.t) && LATIN_WORD_START.test(next.t);
    return latinBoundary ? ' ' : '';
  }
  return ' ';
}

/**
 * 行内词拼接（三档分隔）。
 *
 * 为什么需要「紧邻不插空格」这一档：WinRT 会把 `2026/11/12` 拆成多个独立词（实测
 * 字距 1–6px），只用单空格拼接会得到 `2026 / 1 1 / 1 2`，日期无法阅读。低于紧邻阈值
 * 的间隙直接相连，才能还原 `2026/11/12`；而日期与时间之间的真实空格（约 8px）保留。
 * 列间（大于列阈值）仍用 ` | ` 标记，便于人眼与模型辨认表格列。
 */
function joinWords(words: OcrWord[], gapThreshold: number, tightThreshold: number): string {
  let out = words[0].t;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const gap = words[i].x - (prev.x + prev.w);
    out += separatorFor(prev, words[i], gap, tightThreshold, gapThreshold) + words[i].t;
  }
  return out;
}

/** 一维区间跨度 */
interface Span {
  left: number;
  right: number;
}

/**
 * x 投影列聚类（D4）。
 *
 * 为什么不用「词起点一维聚类」：日期内部也有空格（`2026` `/` `11` `/` `12`），
 * 起点聚类会切出 7 个碎簇。投影法看的是**整列空白**——日期内部的空格在别的行被
 * 数字覆盖，因此不会成为列边界，这才是表格识别的正确判据。
 */
export function clusterColumns(words: OcrWord[], minGap: number): Span[] {
  const spans: Span[] = words
    .filter((w) => w.w > 0)
    .map((w) => ({ left: w.x, right: w.x + w.w }))
    .sort((a, b) => a.left - b.left);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.left - last.right < minGap) {
      last.right = Math.max(last.right, span.right);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** 把词落到列：取列区间包含词中心者，否则取水平距离最近的列 */
function columnIndexOf(word: OcrWord, spans: Span[]): number {
  const center = word.x + word.w / 2;
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (center >= span.left && center <= span.right) return i;
    const dist = center < span.left ? span.left - center : center - span.right;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** markdown 单元格：`|` 转义、CJK 字间空格合并（D13，否则格内是「小 智 前 后 台」） */
function markdownCell(text: string): string {
  return mergeCjkSpaces(text).replace(/\|/g, '\\|').trim();
}

/**
 * 渲染 `layout=table`（D4/D13）。
 * 门槛：列数 ≥2 且视觉行数 ≥3，否则回落 text 并给 warning——正文段落/多栏排版
 * 在这一步很容易被误判成表格，宁可不给表格也不给错表格。
 */
function renderTable(
  lines: VisualLine[],
  medH: number,
): { text: string; columns: number } | null {
  if (lines.length < 3) return null;
  const allWords = lines.flatMap((l) => l.words);
  const spans = clusterColumns(allWords, Math.max(8, medH * COL_GAP_RATIO));
  if (spans.length < 2) return null;

  const rows: string[][] = lines.map((line) => {
    const cells: OcrWord[][] = spans.map(() => []);
    for (const word of line.words) {
      cells[columnIndexOf(word, spans)].push(word);
    }
    return cells.map((parts) => {
      // 单元格内同样是三档分隔：紧邻（同 token 被引擎切开）不插空格，避免 `2026 / 11 / 12`
      const raw = parts.length === 0 ? '' : parts.reduce((acc, cur, i) => {
        if (i === 0) return cur.t;
        const prev = parts[i - 1];
        const gap = cur.x - (prev.x + prev.w);
        return acc + separatorFor(prev, cur, gap, medH * TIGHT_GAP_RATIO, Infinity) + cur.t;
      }, '');
      return markdownCell(raw);
    });
  });

  const header = rows[0];
  const body = rows.slice(1);
  const out: string[] = [];
  out.push(`| ${header.map((c) => c || ' ').join(' | ')} |`);
  out.push(`| ${spans.map(() => '---').join(' | ')} |`);
  for (const row of body) out.push(`| ${row.map((c) => c || '').join(' | ')} |`);
  return { text: out.join('\n'), columns: spans.length };
}

/** 渲染 `layout=words`：`x\ty\tw\th\ttext` 逐词一行（D5，坐标不归一化，省得模型做除法） */
function renderWords(lines: VisualLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    for (const word of line.words) {
      out.push(`${word.x}\t${word.y}\t${word.w}\t${word.h}\t${word.t}`);
    }
  }
  return out.join('\n');
}

/**
 * 统一版面渲染入口。
 *
 * @param rawLines 引擎原始行（粒度更细）
 * @param layout   目标形态
 * @returns 渲染结果；`applied` 可能因数据不足而回落为 'text'
 */
export function renderLayout(rawLines: OcrLine[], layout: OcrLayout): LayoutRenderResult {
  const words = rawLines.flatMap((l) => l.words ?? []);
  const lines = buildVisualLines(words);
  const medH = medianWordHeight(words);
  const base = { lineCount: lines.length, wordCount: words.length };

  if (lines.length === 0) {
    return { text: '', applied: 'text', ...base, warning: '引擎未返回带坐标的词，已按纯文本输出' };
  }

  if (layout === 'words') {
    return { text: renderWords(lines), applied: 'words', ...base };
  }

  if (layout === 'table') {
    const table = renderTable(lines, medH);
    if (table) {
      return { text: table.text, applied: 'table', ...base, columns: table.columns };
    }
    return {
      text: lines.map((l) => l.text).join('\n'),
      applied: 'text',
      ...base,
      warning: '未检测到稳定的多列结构（需列数≥2 且行数≥3），已按纯文本输出',
    };
  }

  return { text: lines.map((l) => l.text).join('\n'), applied: 'text', ...base };
}

/** 引擎输入位图尺寸的展示文本（无坐标引擎返回空串） */
export function describeImageSize(size?: OcrImageSize): string {
  return size && size.width > 0 && size.height > 0 ? `${size.width}×${size.height}` : '';
}
