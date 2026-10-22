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
