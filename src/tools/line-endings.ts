// 行尾工具（Task-20261023-001）：检测/适配/归一化匹配与替换
// 目标：oldText（模型产出，通常 LF，因 fileRead 按行输出不显示 \r）可匹配 CRLF/混合行尾文件；
// 写回仅改动目标段，未触及区域字节级保留，替换段适配文件主导行尾。
// 借鉴：Claude Code #164/#27718（归一化匹配）、#13456（匹配与写回必须成对）、
// #62713（不得统一全文行尾）、OpenCode fix-line-endings（主导行尾判定矩阵）。
import { lockKey } from './file-lock.js';

export type Eol = '\n' | '\r\n';

/**
 * 检测内容主导行尾：CRLF 出现次数 > 单独 LF 次数 → CRLF，否则 LF。
 * 裸 \r（旧 Mac 风格）不计数也不处理（与 OpenCode 矩阵一致：仅纯 CR 文件保留）。
 * 无换行内容返回 '\n'（安全默认）。
 */
export function detectEol(content: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '\n') continue;
    if (i > 0 && content[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** 归一化：\r\n → \n（仅用于匹配；裸 \r 不动） */
export function normalizeEol(text: string): string {
  return text.includes('\r\n') ? text.split('\r\n').join('\n') : text;
}

/** 将文本中的换行统一为指定行尾（\r\n 与 \n 均视为换行；裸 \r 保留） */
export function adaptEol(text: string, eol: Eol): string {
  if (!text.includes('\n')) return text;
  const normalized = normalizeEol(text);
  if (eol === '\n') return normalized;
  return normalized.split('\n').join('\r\n');
}

export interface FirstDiff {
  /** 1-based 行号（基于归一化内容） */
  line: number;
  /** oldText 侧该行内容（截断 120 字符） */
  expected: string;
  /** 文件侧该行内容（截断 120 字符） */
  actual: string;
}

/** 最长公共前缀定位首个差异行（输入须为归一化后内容）；完全一致返回 null */
export function firstDiffLine(contentNorm: string, oldNorm: string): FirstDiff | null {
  if (contentNorm === oldNorm) return null;
  const max = Math.min(contentNorm.length, oldNorm.length);
  let i = 0;
  while (i < max && contentNorm[i] === oldNorm[i]) i++;
  let line = 1;
  for (let j = 0; j < i; j++) {
    if (contentNorm[j] === '\n') line++;
  }
  const lineAt = (s: string, ln: number): string =>
    (s.split('\n')[ln - 1] ?? '').replace(/\r$/, '').slice(0, 120);
  return { line, expected: lineAt(oldNorm, line), actual: lineAt(contentNorm, line) };
}

/**
 * 近似候选（D6）：oldText 首行（trim 后 ≥8 字符）在归一化内容中的命中行 ±contextLines 行上下文。
 * 最多 maxHits 处；无命中或首行过短返回空数组。
 */
export function similarCandidates(
  contentNorm: string,
  oldNorm: string,
  contextLines = 2,
  maxHits = 3,
): string[] {
  const firstLine = (oldNorm.split('\n')[0] ?? '').trim();
  if (firstLine.length < 8) return [];
  // 近似判定：与期望首行的公共前缀 ≥ max(8, 首行长一半)。
  // 覆盖两类场景：「行内小差异（typo）」与「整行一致但后续行不同」；exact 命中亦计入。
  const minPrefix = Math.max(8, Math.floor(firstLine.length / 2));
  const lines = contentNorm.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const line = lines[i].trim();
    let common = 0;
    const max = Math.min(line.length, firstLine.length);
    while (common < max && line[common] === firstLine[common]) common++;
    if (common >= minPrefix) hits.push(i);
  }
  if (hits.length === 0) return [];
  const out: string[] = [];
  for (const h of hits) {
    const from = Math.max(0, h - contextLines);
    const to = Math.min(lines.length - 1, h + contextLines);
    const snippet = lines
      .slice(from, to + 1)
      .map((l, k) => `${from + k + 1}: ${l.replace(/\r$/, '')}`)
      .join('\n');
    out.push(`第 ${h + 1} 行附近：\n${snippet}`);
  }
  return out;
}

export interface LineDiffRow {
  /** oldText 侧行号（1-based） */
  line: number;
  /** oldText 侧该行（截断 120 字符） */
  expected: string;
  /** 文件侧该行（截断 120 字符） */
  actual: string;
  /** 是否纯空白差异（trim 后一致、首尾空白不同，如缩进 tab↔空格、行尾空格） */
  whitespaceOnly: boolean;
}

export interface AnchoredLineDiff {
  /** 锚点在文件中的行号（1-based，即 oldText 首行命中的文件行） */
  anchor: number;
  /** 不一致行列表（按 oldText 行号升序） */
  diffs: LineDiffRow[];
  /** 与文件逐字符一致的 oldText 行数 */
  exactLines: number;
  /** oldText 总行数 */
  totalLines: number;
}

/**
 * 锚定式逐行比对（fix/0.1.1 失配诊断增强）：
 * 多行 oldText 失配的真实主因是「个别行凭记忆写错、其余行正确」——先按 oldText 首行
 * 在文件中锚定候选位置（trim 全等优先，退化为公共前缀阈值，与 similarCandidates 同款），
 * 再把 oldText 与锚点窗口逐行比对，精确指出哪几行不一致、哪几行一致。
 * 与 firstDiffLine（从文件头锚定）的区别：命中锚点时信息指向 oldText 实际所在区域，
 * 不再产生「期望与实际来自不同区域」的噪音。
 * 空白差异单独分级：行 trim 后一致但逐字符不同（缩进 tab↔空格、行尾空格）标记
 * whitespaceOnly，渲染时可提示「仅空白不一致」。
 * 首行过短（<8 字符）或无锚点命中返回 null，由调用方回退 firstDiffLine。
 * 多个锚点取不一致行最少的（并列取靠前）。
 */
export function anchoredLineDiff(contentNorm: string, oldNorm: string): AnchoredLineDiff | null {
  const oldLines = oldNorm.split('\n');
  const first = (oldLines[0] ?? '').trim();
  if (first.length < 8) return null;
  const contentLines = contentNorm.split('\n');
  // 全等锚点（trim 全等，覆盖首行缩进差异场景）优先；无则用前缀阈值锚点（≥ max(8, 首行长一半)）
  const exact: number[] = [];
  const fuzzy: number[] = [];
  const minPrefix = Math.max(8, Math.floor(first.length / 2));
  for (let i = 0; i < contentLines.length; i++) {
    const t = contentLines[i].trim();
    if (t === first) exact.push(i);
    else {
      let common = 0;
      const max = Math.min(t.length, first.length);
      while (common < max && t[common] === first[common]) common++;
      if (common >= minPrefix) fuzzy.push(i);
    }
  }
  const clip = (s: string): string => s.replace(/\r$/, '').slice(0, 120);
  const diffAt = (anchor: number): LineDiffRow[] => {
    const rows: LineDiffRow[] = [];
    for (let i = 0; i < oldLines.length; i++) {
      const fileLine = contentLines[anchor + i];
      if (fileLine === undefined) break; // 窗口超出文件尾，只比对可得部分
      if (oldLines[i] === fileLine) continue; // 完全一致
      rows.push({
        line: i + 1,
        expected: clip(oldLines[i]),
        actual: clip(fileLine),
        whitespaceOnly: oldLines[i].trim() === fileLine.trim(),
      });
    }
    return rows;
  };
  const candidates = exact.length > 0 ? exact : fuzzy;
  if (candidates.length === 0) return null;
  let best: AnchoredLineDiff | null = null;
  for (const anchor of candidates) {
    const diffs = diffAt(anchor);
    if (!best || diffs.length < best.diffs.length) {
      best = { anchor: anchor + 1, diffs, exactLines: oldLines.length - diffs.length, totalLines: oldLines.length };
    }
  }
  return best;
}

export interface NormalizedReplaceResult {
  /** 替换后的完整内容（replaceAll=false 且多处匹配时不落盘，仅用于参考） */
  updated: string;
  /** 归一化内容中的匹配总数 */
  count: number;
  /** 是否多处匹配 */
  multiple: boolean;
  /** 文件主导行尾（写回适配用） */
  eol: Eol;
}

/**
 * 行尾归一化的字面量替换（D2 偏移映射写回）：
 * 1) 归一化副本（\r\n→\n）上收集全部匹配区间；
 * 2) 通过「norm→raw 偏移数组」（O(n) 单遍扫描原始内容构建）映射回原始内容；
 * 3) 一次前向拼装——未触及区域字节级保留，替换段写入 adaptEol(newText, 主导行尾)。
 * 未匹配返回 null；调用方据 count/multiple 决定报错或落盘。
 */
export function replaceNormalized(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): NormalizedReplaceResult | null {
  if (oldText.length === 0) return null;
  const eol = detectEol(content);
  const contentNorm = normalizeEol(content);
  const oldNorm = normalizeEol(oldText);

  // 归一化内容中收集全部匹配区间（无论 replaceAll 与否都全量收集，
  // 非 replaceAll 时由调用方据 count>1 报「多处匹配」错误）
  const ranges: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (;;) {
    const idx = contentNorm.indexOf(oldNorm, pos);
    if (idx === -1) break;
    ranges.push({ start: idx, end: idx + oldNorm.length });
    pos = idx + oldNorm.length;
  }
  if (ranges.length === 0) return null;

  // norm→raw 偏移数组：raw = normIndex + extra[normIndex]（extra = 该位置前已删除的 \r 数）
  const extra = new Int32Array(contentNorm.length + 1);
  let ni = 0;
  let removed = 0;
  for (let ri = 0; ri < content.length; ri++) {
    if (content[ri] === '\r' && ri + 1 < content.length && content[ri + 1] === '\n') {
      removed++;
      continue;
    }
    extra[ni] = removed;
    ni++;
  }
  extra[contentNorm.length] = removed;

  const replacement = adaptEol(newText, eol);
  const applied = replaceAll ? ranges : ranges.slice(0, 1);
  let out = '';
  let rawPrev = 0;
  for (const r of applied) {
    const rawStart = r.start + extra[r.start];
    // 闭区间右端：按「最后一个匹配字符」的 raw 位置 +1 推导（end + extra[end - 1]），
    // 而非 end + extra[end]——后者会把「匹配边界后紧跟的 CRLF 的 \r」误算进替换区（吞行尾 bug）
    const rawEnd = r.end > 0 ? r.end + extra[r.end - 1] : r.start + extra[r.start];
    out += content.slice(rawPrev, rawStart);
    out += replacement;
    rawPrev = rawEnd;
  }
  out += content.slice(rawPrev);

  return { updated: out, count: ranges.length, multiple: ranges.length > 1, eol };
}

// ---- mtime 写入登记（D5 失配诊断用）：仅记录本进程经工具写过的文件 ----

const mtimeRegistry = new Map<string, number>();

/** 写成功后登记当前 mtime（内部已按文件锁同款规则规范化 key） */
export function recordWriteMtime(absPath: string, mtimeMs: number): void {
  mtimeRegistry.set(lockKey(absPath), mtimeMs);
}

/** 读取本进程上次写登记的 mtime；未登记返回 undefined */
export function getRecordedMtime(absPath: string): number | undefined {
  return mtimeRegistry.get(lockKey(absPath));
}

/** 判断当前 mtime 是否与登记值不一致（1ms 容差，吸收浮点/文件系统精度差） */
export function isMtimeChanged(absPath: string, currentMtimeMs: number): boolean {
  const recorded = mtimeRegistry.get(lockKey(absPath));
  return recorded !== undefined && Math.abs(currentMtimeMs - recorded) > 1;
}

/**
 * 正则锚定提示（fix/0.1.1）：正则失配且 pattern 含 ^ 或 $ 锚点、flags 缺 m 时，
 * 提示「^$ 锚定整条文本而非行首行尾」——这是锚点正则失配的最高频原因
 * （取证：sess_522b6010_20261114_203126 案例 1，加 m 标志一轮即恢复）。
 */
export function multilineAnchorHint(pattern: string, flags: string): string | null {
  if (flags.includes('m')) return null;
  if (!/[\^$]/.test(pattern)) return null;
  return '检测到正则含 ^ 或 $ 锚点但未启用 m 标志：此时 ^/$ 锚定的是整条文本的开头/结尾而非每行的行首/行尾，'
    + '跨行匹配请加 m 标志（如 flags: "gm"），或改用不含行锚点的 pattern';
}

// ---- 空白容错匹配（fix/0.1.1 第二级匹配，仅精确匹配失败后调用）----

export interface ToleratedHitRows {
  /** 命中处序号（1-based） */
  hit: number;
  /** 该处被容错吸收的行（oldText 侧行号，1-based：trim 全等但逐字符不同） */
  absorbed: number[];
}

export interface ToleratedReplaceResult {
  /** 替换后的完整内容（multiple=true 且未 replaceAll 时不落盘） */
  updated: string;
  /** 容错命中总数 */
  count: number;
  /** 是否多处命中 */
  multiple: boolean;
  /** 文件主导行尾 */
  eol: Eol;
  /** 各命中处吸收的空白差异行摘要（multiple 时不填） */
  toleratedRows: ToleratedHitRows[];
}

/**
 * 空白容错匹配替换（Aider 式 SEARCH/REPLACE 的安全版）：
 * 判据：oldText 与文件窗口**逐行 trim 全等**（仅吸收首尾空白差异——缩进错位、行尾空格；
 * 任一行 trim 后内容不同即整窗不命中，绝不「猜」内容级差异）。
 * 安全约束（Aider 曾静默损坏文件的教训）：
 * 1) 替换写回时 newText 逐行做缩进传导——保持 newText 相对 oldText 的缩进关系，
 *    套上文件窗口的实际前导空白；tab/空格结构冲突或差量为负时整体放弃（返回 null 回落诊断）；
 * 2) 多处命中与精确匹配同语义：未 replaceAll 即报 multiple，不静默选第一处；
 * 3) 重叠窗口跳过（与 indexOf 推进语义一致）；
 * 4) 全空白 oldText 不容错（无锚定意义）。
 * 命中原因通过 toleratedRows 显式返回，由调用方写入结果消息，不做静默纠正。
 */
export function tolerateReplace(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): ToleratedReplaceResult | null {
  if (oldText.trim().length === 0) return null;
  const eol = detectEol(content);
  const contentNorm = normalizeEol(content);
  const oldNorm = normalizeEol(oldText);
  const cn = contentNorm.split('\n');
  const on = oldNorm.split('\n');
  if (on.length > cn.length) return null;
  const newLines = normalizeEol(newText).split('\n');

  const lead = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';
  const stripLead = (line: string): string => line.slice(lead(line).length);

  // 候选窗口起点：首行 trim 全等
  const firstTrim = on[0].trim();
  if (firstTrim.length === 0) return null;
  const hits: Array<{ start: number; absorbed: number[] }> = [];
  let prevEnd = -1;
  for (let s = 0; s + on.length <= cn.length; s++) {
    if (s < prevEnd) continue; // 重叠窗口跳过
    if (cn[s].trim() !== firstTrim) continue;
    let ok = true;
    const absorbed: number[] = [];
    for (let j = 0; j < on.length; j++) {
      if (on[j].trim() !== cn[s + j].trim()) {
        ok = false;
        break;
      }
      if (on[j] !== cn[s + j]) absorbed.push(j + 1);
    }
    if (ok) {
      hits.push({ start: s, absorbed });
      prevEnd = s + on.length;
    }
  }
  if (hits.length === 0) return null;
  const multiple = hits.length > 1;
  if (multiple && !replaceAll) {
    return { updated: content, count: hits.length, multiple: true, eol, toleratedRows: [] };
  }

  /** newText 行 j 的缩进传导：保持相对 oldText 行的缩进差，套到文件窗口行上；不可映射返回 null */
  const mapIndent = (start: number, j: number): string | null => {
    const oi = j < on.length ? j : on.length - 1; // 多出的行映射到 oldText 末行
    const wsOld = lead(on[oi]);
    const wsFile = lead(cn[start + oi]);
    const wsNew = lead(newLines[j]);
    if (wsNew.startsWith(wsOld)) return wsFile + wsNew.slice(wsOld.length);
    if (wsOld.endsWith(wsNew)) {
      // newText 相对减缩进：把缩减量作用到文件侧缩进，文件侧不足时钳到空串
      // （该差量本就是容错吸收的范围，仅空白无内容风险；如 oldText 多缩进、newText 按无缩进写）
      const cut = wsOld.length - wsNew.length;
      return wsFile.length >= cut ? wsFile.slice(0, wsFile.length - cut) : '';
    }
    return null; // 前导空白结构不同（如 tab vs 空格）：放弃容错
  };

  const buildReplacement = (start: number): string | null => {
    const out: string[] = [];
    for (let j = 0; j < newLines.length; j++) {
      const ws = mapIndent(start, j);
      if (ws === null) return null;
      out.push(ws + stripLead(newLines[j]));
    }
    return out.join('\n');
  };

  // norm→raw 偏移映射：容错窗口按「整行区间」写回（首行行首、末行行尾空白与结构换行均属窗口），
  // 窗口末尾的换行由写回侧补齐，避免吞掉结构换行或残留行尾空白
  const extra = new Int32Array(contentNorm.length + 1);
  let ni = 0;
  let removed = 0;
  for (let ri = 0; ri < content.length; ri++) {
    if (content[ri] === '\r' && ri + 1 < content.length && content[ri + 1] === '\n') {
      removed++;
      continue;
    }
    extra[ni] = removed;
    ni++;
  }
  extra[contentNorm.length] = removed;
  const lineStartNorm = new Array<number>(cn.length + 1);
  let acc = 0;
  for (let i = 0; i < cn.length; i++) {
    lineStartNorm[i] = acc;
    acc += cn[i].length + 1;
  }
  lineStartNorm[cn.length] = acc;
  const rawLineStart = (li: number): number => {
    const n = Math.min(lineStartNorm[li], contentNorm.length);
    return n + extra[n];
  };

  const applied = replaceAll ? hits : hits.slice(0, 1);
  const replacements: string[] = [];
  for (const h of applied) {
    const rep = buildReplacement(h.start);
    if (rep === null) return null; // 缩进不可映射：整体放弃，回落精确诊断
    replacements.push(adaptEol(rep, eol));
  }

  let out = '';
  let prev = 0;
  const toleratedRows: ToleratedHitRows[] = [];
  for (let k = 0; k < applied.length; k++) {
    const { start, absorbed } = applied[k];
    const rawStart = rawLineStart(start);
    const rawEnd = rawLineStart(start + on.length);
    const origWindow = content.slice(rawStart, rawEnd);
    out += content.slice(prev, rawStart);
    out += replacements[k];
    // 窗口末尾的结构换行：原窗口以换行结尾而替换文本没有时补主导行尾（互斥判断，不重复补）
    if (origWindow.endsWith('\n') && !replacements[k].endsWith('\n')) {
      out += adaptEol('\n', eol);
    }
    prev = rawEnd;
    if (absorbed.length > 0) toleratedRows.push({ hit: k + 1, absorbed });
  }
  out += content.slice(prev);

  return { updated: out, count: applied.length, multiple: false, eol, toleratedRows };
}
