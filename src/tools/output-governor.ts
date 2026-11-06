// 工具输出超限治理器：截断进上下文 + 完整原始输出落临时文件 + 告知 LLM 路径
//
// 设计目标（任务 20261106-001，D1-D9）：
// - 不是替代现有截断机制，而是在它们之上补上完整结果落盘 + 告知路径
// - 流式工具（commandRun 前台）在 spawn pipe 处分两路：
//     一路 OutputAccumulator（头尾截断进上下文）
//     一路 TmpFileWriter（完整流式写临时文件，累计达阈值才创建，小输出零磁盘开销）
// - 一次性工具（fileRead / grep）在扫描过程中同时做截断+落盘（方案 B，文件内治理）
// - 临时文件 7 天自动清理（复用 background-tasks 清理框架）
// - 跨平台零新依赖（node:fs / node:path / node:os / node:crypto）

import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { WriteStream } from 'node:fs';
import { debug } from '../debug.js';

/* ========================================================================
 * 治理配置
 * ======================================================================== */

export interface PreserveThresholds {
  /** 进上下文的保留上限（KB），超此值触发落盘（commandRun 头尾各用） */
  preserveKb: number;
  /** 进上下文的保留行数上限（grep 默认） */
  preserveLines: number;
  /** commandRun 流式完整落盘的触发倍数：累计字节 > preserveKb * 1024 * 此值 才创建 WriteStream
   * 设成 2 给小输出留宽松缓冲（输出 < 128KB 时完全不落盘，零开销） */
  triggerMultiplier: number;
  /** 临时文件保留天数（默认 7，复用 backgroundLogPrune.retentionDays 口径） */
  tmpTtlDays: number;
  /** tmp 目录总量上限（MB，默认 200） */
  tmpMaxTotalMb: number;
}

const DEFAULT: PreserveThresholds = {
  preserveKb: 64,
  preserveLines: 200,
  triggerMultiplier: 2,
  tmpTtlDays: 7,
  tmpMaxTotalMb: 200,
};

let thresholds: PreserveThresholds = { ...DEFAULT };

/** 注入治理阈值（runtime init 调用；单测/未注入场景使用默认值） */
export function configureOutputGovernor(opts: Partial<PreserveThresholds>): void {
  thresholds = {
    preserveKb: Math.max(1, opts.preserveKb ?? thresholds.preserveKb),
    preserveLines: Math.max(1, opts.preserveLines ?? thresholds.preserveLines),
    triggerMultiplier: Math.max(1, opts.triggerMultiplier ?? thresholds.triggerMultiplier),
    tmpTtlDays: Math.max(0, opts.tmpTtlDays ?? thresholds.tmpTtlDays),
    tmpMaxTotalMb: Math.max(0, opts.tmpMaxTotalMb ?? thresholds.tmpMaxTotalMb),
  };
}

export function outputGovernorOptions(): PreserveThresholds {
  return { ...thresholds };
}

/* ========================================================================
 * 临时文件路径构造
 * ======================================================================== */

/** tmp 根目录：~/.loop-agent/tmp/（不进工作空间，避免污染 git） */
let tmpDirOverride: string | undefined;
/** 测试专用：覆盖 tmp 目录 */
export function setTmpDirForTest(dir: string | undefined): void {
  tmpDirOverride = dir;
}
export function tmpDir(): string {
  return tmpDirOverride ?? join(homedir(), '.loop-agent', 'tmp');
}

/**
 * 构造临时文件路径：
 *   ~/.loop-agent/tmp/<sessionId>/<tool>-<paramDigest>-<unixTs>.txt
 * 会话未建（CLI 首轮）时 sessionId 用 nosess_<ts>
 */
export function buildTmpFilePath(
  sessionId: string | undefined,
  toolName: string,
  paramDigest: string,
  unixTs: number = Math.floor(Date.now() / 1000),
): string {
  const sessionDir = sessionId ?? `nosess_${unixTs}`;
  const safeDigest = sanitizeParamDigest(paramDigest);
  const fileName = `${toolName}-${safeDigest}-${unixTs}.txt`;
  return join(tmpDir(), sessionDir, fileName);
}

/**
 * 参数摘要构造：
 * - commandRun: 命令去掉引号后的前 32 字符，空格换 _
 * - fileRead: 目标文件 basename
 * - grep: search 关键字前 32 字符
 */
export function summarizeParam(args: Record<string, unknown>, toolName: string): string {
  switch (toolName) {
    case 'commandRun': {
      const raw = String(args.command ?? 'cmd');
      // 去引号、折叠空白、截 32
      const cleaned = raw
        .replace(/["'`]/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 32);
      return cleaned || 'cmd';
    }
    case 'fileRead': {
      const p = String(args.path ?? 'file');
      const base = p.split(/[\\/]/).pop() ?? p;
      return sanitizeParamDigest(base).slice(0, 32) || 'file';
    }
    case 'grep': {
      const pat = String(args.pattern ?? 'search');
      return sanitizeParamDigest(pat).slice(0, 32) || 'search';
    }
    default:
      return toolName;
  }
}

/** 文件名安全化：过滤 Windows/macOS/Linux 均禁止的字符，空白→_，超 32 字符截断 */
export function sanitizeParamDigest(raw: string): string {
  return (raw ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'data';
}

/** 人类可读大小（4.2 MB / 356 KB / 12 B） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ========================================================================
 * 超限提示文本（追加到 observation 末尾，供 LLM 抽取路径后再读）
 * ======================================================================== */

const NOTICE_BOUNDARY = '\n── 完整输出已保存 ──\n';

export interface FullOutputNotice {
  path: string;
  bytes: number;
  lines?: number;
  /** 建议的再读提示（如 "建议: 用 fileRead 的 startLine/endLine 分段读取，如 startLine: 1000, endLine: 1500"） */
  suggestion: string;
}

/** 拼接完整的 observation 末尾提示 */
export function buildFullOutputNotice(notice: FullOutputNotice): string {
  const lines: string[] = [];
  lines.push(`路径: ${notice.path}`);
  lines.push(`总大小: ${formatSize(notice.bytes)}`);
  if (notice.lines != null) lines.push(`总行数: ${notice.lines}`);
  lines.push(notice.suggestion);
  return `${NOTICE_BOUNDARY}${lines.join('\n')}\n`;
}

/* ========================================================================
 * TmpFileWriter（commandRun 流式专用）
 * ======================================================================== */

/**
 * 流式完整输出临时文件写入器（commandRun 前台分两路时用）：
 * - 累计字节首次 > preserveKb * 1024 * triggerMultiplier 时才真正创建 WriteStream
 * - 未超阈值的 chunk 直接丢弃：零磁盘 I/O、零 WriteStream 惰性打开
 * - 首次落盘前已丢弃的 chunk 无法补回（已知取舍：小输出根本不落盘；超阈值时 commandRun 头尾截断已保住命令开头）
 */
export class TmpFileWriter {
  private writer: WriteStream | null = null;
  private totalBytes = 0;
  private finalized = false;
  private flushPromise: Promise<void> | null = null;
  private lineCount = 0;
  private path: string | null = null;
  private enabled = true;

  constructor(private readonly config: {
    sessionId: string | undefined;
    toolName: string;
    paramDigest: string;
    thresholds?: Partial<PreserveThresholds>;
  }) {}

  /** 每次收到流式 chunk 时调用；幂等——finalize 之后不再做事 */
  onChunk(chunk: Buffer): void {
    if (!this.enabled || this.finalized || !chunk || chunk.length === 0) return;

    this.totalBytes += chunk.length;
    const effective = { ...thresholds, ...(this.config.thresholds ?? {}) };

    // 未达触发阈值：丢弃（零开销）
    if (this.writer === null && this.totalBytes < effective.preserveKb * 1024 * effective.triggerMultiplier) {
      return;
    }

    // 首次越过阈值：创建 WriteStream（在此之前 chunk 已被丢弃，无法补回）
    if (this.writer === null) {
      const path = buildTmpFilePath(this.config.sessionId, this.config.toolName, this.config.paramDigest);
      try {
        mkdirSync(dirname(path), { recursive: true });
        this.writer = createWriteStream(path, { flags: 'w' });
        this.path = path;
        // 统计换行数以支持总行数提示
        this.writer.on('data', () => {}); // 空监听防 backpressure？不，WriteStream 不会对 pipe 背压
        // 用 'drain' 或等 finish 事件，但 finalize 需要同步等待
      } catch (e) {
        debug.log(`TmpFileWriter 创建失败: ${e instanceof Error ? e.message : String(e)}`);
        this.enabled = false;
        return;
      }
    }

    // 统计 \n（临时快速估算：Buffer 里 \n 出现次数）
    let idx = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) this.lineCount++;
      idx++;
    }

    try {
      this.writer.write(chunk);
    } catch (e) {
      debug.log(`TmpFileWriter 写入失败: ${e instanceof Error ? e.message : String(e)}`);
      this.enabled = false;
    }
  }

  /** 关闭 WriteStream 并等待 drain，返回完整信息；未触发落盘返回 undefined */
  async finalize(): Promise<{ path: string; bytes: number; lines: number } | undefined> {
    if (this.finalized) {
      if (this.flushPromise) await this.flushPromise;
      return this.path ? { path: this.path, bytes: this.totalBytes, lines: this.lineCount } : undefined;
    }
    this.finalized = true;

    if (this.writer === null) return undefined;

    return new Promise((resolve) => {
      if (!this.writer) { resolve(undefined); return; }
      this.writer.end(() => {
        resolve({ path: this.path!, bytes: this.totalBytes, lines: this.lineCount });
      });
    });
  }

  /** 禁用（创建失败后） */
  disable(): void { this.enabled = false; }
}

/* ========================================================================
 * pruneTmp（复用 background-tasks 清理框架，但 tmp 目录结构不同）
 * ======================================================================== */

export interface TmpPruneResult {
  /** 删除的 .txt 文件数 */
  removedFiles: number;
  /** 释放字节数 */
  freedBytes: number;
  /** 清理后剩余 tmp 目录字节数（方便诊断） */
  remainingBytes: number;
}

/**
 * 清理 ~/.loop-agent/tmp/ 目录（需求 20261106-001 P1）：
 * - 按天数：临时文件 mtime > tmpTtlDays 天前删除
 * - 按大小：剩余 tmp 目录总量超过 tmpMaxTotalMb 时按 mtime 从旧删起
 * - 空会话目录一并删除
 *
 * 全程同步 I/O（与 background-tasks pruneRuns 同口径），失败仅 debug 不阻塞主流程。
 */
export function pruneTmp(override?: Partial<PreserveThresholds>): TmpPruneResult {
  const result: TmpPruneResult = { removedFiles: 0, freedBytes: 0, remainingBytes: 0 };
  const opts = { ...thresholds, ...(override ?? {}) };

  const root = tmpDir();
  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(root);
  } catch {
    return result; // 目录不存在（从未用过超限治理），静默
  }

  const now = Date.now();
  const cutoff = now - Math.max(0, opts.tmpTtlDays) * 24 * 60 * 60 * 1000;
  const maxTotalBytes = Math.max(0, opts.tmpMaxTotalMb) * 1024 * 1024;

  // 收集所有 .txt 文件元数据（path / size / mtime）
  interface TmpFile { path: string; size: number; mtime: number; session: string; }
  const allFiles: TmpFile[] = [];
  const dirEntries: Map<string, { path: string; mtime: number }> = new Map();

  for (const session of sessionDirs) {
    const sessionPath = join(root, session);
    let sessionChildren: string[];
    try {
      sessionChildren = readdirSync(sessionPath);
      dirEntries.set(session, { path: sessionPath, mtime: 0 });
    } catch { continue; }

    for (const child of sessionChildren) {
      const full = join(sessionPath, child);
      let st;
      try {
        st = statSync(full);
      } catch { continue; }
      // 只处理 .txt（当前治理器统一用 .txt；未来若扩展 jsonl 格式需同时覆盖）
      if (!child.endsWith('.txt')) continue;
      allFiles.push({ path: full, size: st.size, mtime: st.mtimeMs, session });
      // 用最旧子文件的 mtime 估算会话目录 mtime（stat 目录 mtime 会随里面文件变化，不够稳定）
      const cur = dirEntries.get(session)!;
      if (cur.mtime === 0 || st.mtimeMs < cur.mtime) cur.mtime = st.mtimeMs;
    }
  }

  // 1) 按天数删除超期文件
  const kept: TmpFile[] = [];
  for (const f of allFiles) {
    if (f.mtime < cutoff) {
      try {
        rmSync(f.path);
        result.removedFiles++;
        result.freedBytes += f.size;
      } catch { /* 并发删除，忽略 */ }
    } else {
      kept.push(f);
    }
  }

  // 2) 按大小：剩余总量超限则按 mtime 从最旧删起
  let total = kept.reduce((s, f) => s + f.size, 0);
  if (total > maxTotalBytes && maxTotalBytes > 0) {
    const sorted = [...kept].sort((a, b) => a.mtime - b.mtime);
    for (const f of sorted) {
      if (total <= maxTotalBytes) break;
      try {
        rmSync(f.path);
        result.removedFiles++;
        result.freedBytes += f.size;
        total -= f.size;
      } catch { /* 忽略 */ }
    }
  }

  // 3) 清理空会话目录
  for (const [session, info] of dirEntries) {
    let children: string[];
    try {
      children = readdirSync(info.path);
    } catch { continue; }
    // 过滤掉刚才已经被删掉的文件后检查是否还有残留（比如非 .txt 或 in-flight 正在写）
    const remaining = children.filter((c) => {
      const full = join(info.path, c);
      // kept 里剩余的文件集合
      return kept.some((k) => k.path === full);
    });
    if (children.length > 0 && remaining.length === 0) {
      // 目录里还有东西，但都是超期被删的 → 删目录
      try { rmSync(info.path, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  result.remainingBytes = total;
  if (result.removedFiles > 0) {
    debug.log(
      `临时输出清理: 删除 ${result.removedFiles} 个文件、释放 ${Math.round(result.freedBytes / 1024)}KB、剩余 ${Math.round(result.remainingBytes / 1024)}KB`,
    );
  }
  return result;
}

/* ========================================================================
 * 一次性工具治理（runner 层兜底；fileRead/grep 实际走文件内治理方案 B）
 * ======================================================================== */

export interface GovernedOutput {
  text: string;
  fullOutputPath?: string;
  fullOutputBytes?: number;
  fullOutputLines?: number;
  truncated: boolean;
}

/**
 * runner 层治理兜底：对未知工具或未走内部治理的一次性工具，
 * 结果字节数 > 阈值时落完整内容 + 返回截断片段。
 *
 * 注意：fileRead/grep 已走文件内治理（边扫描边落盘），runner 层不会再对它们调用此函数。
 * 此函数作为 MCP 等未知工具的兜底。
 */
export async function governOneShot(
  result: string,
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string | undefined,
  overrides?: Partial<PreserveThresholds>,
): Promise<GovernedOutput> {
  const effective = { ...thresholds, ...(overrides ?? {}) };
  const byteCap = effective.preserveKb * 1024;
  const len = Buffer.byteLength(result, 'utf-8');
  if (len <= byteCap) {
    return { text: result, truncated: false }; // 小输出原样返回
  }

  // 超限：完整内容落临时文件，返回截断片段 + 路径提示
  const digest = summarizeParam(args, toolName);
  const path = buildTmpFilePath(sessionId, toolName, digest);
  let written = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, result, 'utf-8');
    written = true;
  } catch (e) {
    debug.log(`governOneShot 落盘失败 ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 截断策略：按字符截断（简单）；复杂截断由具体工具内部治理
  const cutText = result.slice(0, byteCap);
  const lines = result.split('\n').length;

  let text = cutText;
  if (written) {
    const suggestion = toolName === 'grep' || toolName === 'fileSearch'
      ? `建议: 缩小搜索范围或先用 grep 定位关键行`
      : `建议: 用 fileRead 的 startLine/endLine 分段读取`;
    text += buildFullOutputNotice({ path, bytes: len, lines, suggestion });
  } else {
    text += `\n\n[完整输出保存失败: 输出已截断为前 ${byteCap} 字节，落盘遇到错误]`;
  }
  return { text, fullOutputPath: written ? path : undefined, fullOutputBytes: len, fullOutputLines: lines, truncated: true };
}

// writeFileSync 从 node:fs 引入（只在 governOneShot 用）
import { writeFileSync } from 'node:fs';
