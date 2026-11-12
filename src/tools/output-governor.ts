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
import { loopAgentHome } from '../user-home.js';
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
export function configureOutputGovernor(opts: Partial<PreserveThresholds> | undefined): void {
  // 容错：旧配置文件 / 精简测试配置可能没有 outputGovernor 段。
  // 若这里抛 TypeError，init.ts 的 try/catch 会连带跳过其后的
  // configureBackgroundNotify 与 pruneRuns（同一 try 块），造成难以定位的副作用。
  const o = opts ?? {};
  thresholds = {
    preserveKb: Math.max(1, o.preserveKb ?? thresholds.preserveKb),
    preserveLines: Math.max(1, o.preserveLines ?? thresholds.preserveLines),
    triggerMultiplier: Math.max(1, o.triggerMultiplier ?? thresholds.triggerMultiplier),
    tmpTtlDays: Math.max(0, o.tmpTtlDays ?? thresholds.tmpTtlDays),
    tmpMaxTotalMb: Math.max(0, o.tmpMaxTotalMb ?? thresholds.tmpMaxTotalMb),
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
  return tmpDirOverride ?? join(loopAgentHome(), 'tmp');
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
  /** 文件真实字节数（statSync 口径，不是命令输出总量） */
  bytes: number;
  lines?: number;
  /** 建议的再读提示（如 "建议: 用 fileRead 的 startLine/endLine 分段读取，如 startLine: 1000, endLine: 1500"） */
  suggestion: string;
  /** false 表示落盘不完整（背压丢弃 / 写入出错），提示里会显式声明，避免 LLM 把它当完整输出 */
  complete?: boolean;
  /** complete=true 时的说明文案（默认「该文件即工具原始输出全文」；文档提取场景需说明非原始字节） */
  completeLabel?: string;
  /** 不完整原因（complete=false 时展示） */
  incompleteReason?: string;
}

/**
 * 拼接完整的 observation 末尾提示。
 *
 * 语义契约（需求 20261106-001）：`bytes`/`lines` 必须是**文件真实值**，
 * 且完整时与命令原始输出一致——历史上这里报的是"收到的全部字节"，
 * 而文件只有后半段，导致提示说谎。
 */
export function buildFullOutputNotice(notice: FullOutputNotice): string {
  const lines: string[] = [];
  lines.push(`路径: ${notice.path}`);
  lines.push(`文件大小: ${formatSize(notice.bytes)}`);
  if (notice.lines != null) lines.push(`文件行数: ${notice.lines}`);
  if (notice.complete === false) {
    lines.push(`完整性: ⚠ 不完整（${notice.incompleteReason ?? '写入过程有丢弃'}），不可当作完整原始输出`);
  } else {
    lines.push(`完整性: 完整（${notice.completeLabel ?? '该文件即工具原始输出全文'}）`);
  }
  lines.push(notice.suggestion);
  return `${NOTICE_BOUNDARY}${lines.join('\n')}\n`;
}

/* ========================================================================
 * TmpFileWriter（流式完整落盘）
 * ======================================================================== */

/** WriteStream 内部排队上限：超过说明磁盘跟不上，继续 write 会把内存吃满 */
const MAX_STREAM_BUFFER_BYTES = 64 * 1024 * 1024;

/** 统计 Buffer 中换行符个数（行数计量口径：\n 计数，末尾无换行时少 1） */
function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

/** 落盘结果（bytes/lines 为文件真实值；contentXxx 为工具实际输出量） */
export interface TmpFileInfo {
  path: string;
  /** 真正写入文件的字节数 */
  bytes: number;
  /** 真正写入文件的换行符个数 */
  lines: number;
  /** 工具实际输出的字节数（无丢弃时 === bytes） */
  contentBytes: number;
  /** 工具实际输出的换行符个数 */
  contentLines: number;
  /** true = 文件即工具原始输出全文（无背压丢弃、无写入错误） */
  complete: boolean;
  /** 写入过程中的错误信息（complete=false 时可能有值） */
  errorMessage?: string;
}

/**
 * 流式完整输出临时文件写入器（commandRun / fileRead 共用）。
 *
 * 需求 20261106-001 修复（原实现 4 个缺陷）：
 *
 * 1. **头部回填（核心）**：旧实现在累计未达触发阈值前直接 `return` 丢弃 chunk，
 *    导致落盘文件只剩"越过阈值之后"的部分——10 万行命令输出 500KB，
 *    文件只有 368.9KB，缺开头 128KB，却对外宣称"完整输出已保存"。
 *    现改为：未达阈值前 chunk 先进**有界内存缓冲**（上限 = 触发阈值），
 *    越过阈值时把缓冲整体回填后再直写后续 chunk，文件与命令输出字节级一致。
 *    小输出（< 阈值）依旧不创建文件，保留零磁盘开销语义。
 * 2. **错误不杀进程**：WriteStream 必须挂 `error` 监听器，否则磁盘满 / 权限变更等
 *    异步错误会变成未捕获异常直接终止进程（外层 try/catch 只能抓同步 throw）。
 * 3. **背压保护**：`write()` 返回 false 后数据在流内部队列堆积，超 `MAX_STREAM_BUFFER_BYTES`
 *    即丢弃并计入 droppedBytes（complete=false，如实声明不完整），不做静默截断。
 * 4. **准确计量**：writtenBytes/writtenLines（文件真实值）与 contentBytes/contentLines
 *    （工具真实输出量）分离，让提示能报「文件大小」而非「收到的字节数」。
 */
export class TmpFileWriter {
  private writer: WriteStream | null = null;
  /** 触发阈值前的暂存（越过阈值时整体回填，保证文件包含工具输出开头） */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** 工具真实输出量（不含任何内部标记） */
  private contentBytes = 0;
  private contentLines = 0;
  /** 真正写入文件的量 */
  private writtenBytes = 0;
  private writtenLines = 0;
  /** 因背压上限丢弃的字节（>0 ⇒ 文件不完整） */
  private droppedBytes = 0;
  private finalized = false;
  private path: string | null = null;
  private enabled = true;
  private errorMessage: string | undefined;

  constructor(private readonly config: {
    sessionId: string | undefined;
    toolName: string;
    paramDigest: string;
    thresholds?: Partial<PreserveThresholds>;
  }) {}

  /** 触发落盘的累计字节阈值（preserveKb × triggerMultiplier） */
  private triggerBytes(): number {
    const effective = { ...thresholds, ...(this.config.thresholds ?? {}) };
    return Math.max(1024, effective.preserveKb * 1024 * effective.triggerMultiplier);
  }

  /** 每次收到流式 chunk 时调用；幂等——finalize 之后不再做事 */
  onChunk(chunk: Buffer): void {
    if (!this.enabled || this.finalized || !chunk || chunk.length === 0) return;

    this.contentBytes += chunk.length;
    this.contentLines += countNewlines(chunk);

    // 已打开文件：直写
    if (this.writer) {
      this.writeChunk(chunk);
      return;
    }

    // 尚未打开：先暂存（不再丢弃，否则文件缺头）
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes < this.triggerBytes()) return;

    // 越过阈值：创建文件并回填全部暂存内容
    if (!this.openWriter()) return;
    const buffered = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const buf of buffered) this.writeChunk(buf);
  }

  /** 惰性创建 WriteStream；失败则禁用（降级为「仅上下文可见」） */
  private openWriter(): boolean {
    if (this.writer) return true;
    const path = buildTmpFilePath(this.config.sessionId, this.config.toolName, this.config.paramDigest);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const ws = createWriteStream(path, { flags: 'w' });
      // 关键：无 error 监听器时异步写入错误会冒泡为未捕获异常，直接杀进程
      ws.on('error', (e: Error) => {
        this.errorMessage = e.message;
        this.enabled = false;
        debug.log(`TmpFileWriter 写入错误 ${path}: ${e.message}`);
      });
      this.writer = ws;
      this.path = path;
      return true;
    } catch (e) {
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.enabled = false;
      this.pending = [];
      this.pendingBytes = 0;
      debug.log(`TmpFileWriter 创建失败: ${this.errorMessage}`);
      return false;
    }
  }

  /** 写入一个 chunk（含背压保护与计量） */
  private writeChunk(chunk: Buffer): void {
    if (!this.enabled || !this.writer) return;
    // 背压：内部队列已超上限说明磁盘跟不上，丢弃并计数（不静默）
    if (this.writer.writableLength > MAX_STREAM_BUFFER_BYTES) {
      this.droppedBytes += chunk.length;
      return;
    }
    try {
      this.writer.write(chunk);
      this.writtenBytes += chunk.length;
      this.writtenLines += countNewlines(chunk);
    } catch (e) {
      this.errorMessage = e instanceof Error ? e.message : String(e);
      this.enabled = false;
    }
  }

  /** 关闭 WriteStream 并等待落盘完成；从未落盘（小输出）返回 undefined */
  async finalize(): Promise<TmpFileInfo | undefined> {
    if (this.finalized) return this.result();
    this.finalized = true;

    // 全程未越阈值：不落盘（小输出零磁盘开销），暂存直接释放
    if (!this.writer) {
      this.pending = [];
      this.pendingBytes = 0;
      return undefined;
    }

    const ws = this.writer;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      ws.once('close', finish);
      ws.once('error', finish);
      try {
        ws.end(finish);
      } catch {
        finish();
      }
      // 兜底：3s 未关闭也返回，不让工具输出被 I/O 拖死
      const timer = setTimeout(finish, 3000);
      timer.unref?.();
    });

    return this.result();
  }

  private result(): TmpFileInfo | undefined {
    if (!this.path) return undefined;
    return {
      path: this.path,
      bytes: this.writtenBytes,
      lines: this.writtenLines,
      contentBytes: this.contentBytes,
      contentLines: this.contentLines,
      complete: this.droppedBytes === 0 && this.errorMessage === undefined,
      errorMessage: this.errorMessage,
    };
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

  // 截断策略：按字节截断（byteCap 是字节口径；旧实现用 result.slice(0, byteCap)
  // 按字符切，中文场景会截出 3 倍于上限的内容），并丢弃截断处的半个多字节字符
  const buf = Buffer.from(result, 'utf-8');
  let cutText = buf.subarray(0, byteCap).toString('utf-8');
  if (cutText.endsWith('\uFFFD')) cutText = cutText.slice(0, -1);
  const lines = result.split('\n').length;

  let text = cutText;
  if (written) {
    const suggestion = toolName === 'grep' || toolName === 'fileSearch'
      ? `建议: 缩小搜索范围或先用 grep 定位关键行`
      : `建议: 用 fileRead 的 startLine/endLine 分段读取`;
    text += buildFullOutputNotice({
      path,
      bytes: len,
      lines,
      complete: true, // writeFileSync 一次性写全量，成功即完整
      suggestion,
    });
  } else {
    text += `\n\n[完整输出保存失败: 输出已截断为前 ${byteCap} 字节，落盘遇到错误]`;
  }
  return { text, fullOutputPath: written ? path : undefined, fullOutputBytes: len, fullOutputLines: lines, truncated: true };
}

// writeFileSync 从 node:fs 引入（只在 governOneShot 用）
import { writeFileSync } from 'node:fs';
