// 文件读取工具：支持全文读取或按行范围部分读取（20261021-007：默认行数/字节上限，防大文件撑爆上下文与内存）
// 20261106-001：超限完整输出落临时文件 + 告知路径（方案 B：文件内治理，边扫描边写）
import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import {
  TmpFileWriter,
  buildFullOutputNotice,
  summarizeParam,
} from './output-governor.js';

/** 全文读取默认行数上限（超出只返回前 N 行并附截断提示） */
const DEFAULT_MAX_LINES = 2000;
/** 全文读取默认字节上限（256KB）；显式行范围时仅在传 maxBytes 后生效 */
const DEFAULT_MAX_BYTES = 256 * 1024;
/** 全文读取硬上限：超过直接拒绝，要求显式分段（避免整文件入内存） */
const MAX_FULL_READ_BYTES = 16 * 1024 * 1024;
/** 单行字符上限（minified 等超长单行按字符截断） */
const MAX_LINE_CHARS = 8 * 1024;
/** 二进制探测字节数（与 src/api/handlers/fs.ts 的 BINARY_SNIFF_BYTES 一致） */
const BINARY_SNIFF_BYTES = 8000;
/** 流式扫描块大小（内存只保留当前行，不整文件入内存） */
const CHUNK_BYTES = 64 * 1024;

export const fileRead: Tool = {
  name: 'fileRead',
  description:
    '读取文件内容，支持全文读取或按行范围部分读取。默认在每行前加 "行号: " 前缀以便定位与引用；如需原始内容（如读-改-写）可设置 lineNumbers=false。默认有读取上限：全文最多 2000 行 / 256KB，单行超过 8192 字符会截断，超出时末尾附截断提示；大文件请用 startLine/endLine 或 offset/limit 分段读取，或先用 grep 定位。二进制文件会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径或相对路径' },
      startLine: {
        type: 'number',
        description: '起始行号（从 1 开始，可选）。需与 endLine 一起使用；不传则读全文',
      },
      endLine: {
        type: 'number',
        description: '结束行号（包含，可选）。需与 startLine 一起使用',
      },
      offset: {
        type: 'number',
        description: '起始行号（从 1 开始，可选，与 startLine 等价）；可与 limit 搭配使用',
      },
      limit: {
        type: 'number',
        description: '读取行数（可选，从 offset 起算）；不传则读到文件末尾',
      },
      maxBytes: {
        type: 'number',
        description: '返回内容的字节上限（可选）。全文读取默认 256KB；显式行范围时默认不限',
      },
      encoding: { type: 'string', description: '编码，默认 utf-8' },
      lineNumbers: {
        type: 'boolean',
        description: '是否在每行前加 "行号: " 前缀，默认 true；设为 false 返回原始内容',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx?: ToolContext) {
    // 相对路径按空间根解析（D3/D20）；绝对路径原样
    const path = resolveToolPath(toolWorkspaceRoot(ctx), String(args.path));
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';
    const lineNumbers = args.lineNumbers !== false; // 默认 true
    const maxBytes = args.maxBytes != null ? Number(args.maxBytes) : null;
    const startArg = args.startLine != null ? Number(args.startLine) : null;
    const endArg = args.endLine != null ? Number(args.endLine) : null;
    const offsetArg = args.offset != null ? Number(args.offset) : null;
    const limitArg = args.limit != null ? Number(args.limit) : null;

    // 行范围两套参数互斥（startLine/endLine 与 offset/limit）
    if ((startArg !== null || endArg !== null) && (offsetArg !== null || limitArg !== null)) {
      throw new Error('startLine/endLine 与 offset/limit 不能同时使用');
    }
    // 保持原语义：startLine 与 endLine 必须成对
    if ((startArg === null) !== (endArg === null)) {
      throw new Error('startLine 与 endLine 必须同时指定，或都不指定');
    }
    if (startArg !== null && endArg !== null) {
      if (!Number.isInteger(startArg) || !Number.isInteger(endArg)) {
        throw new Error('startLine/endLine 必须为整数');
      }
      if (startArg < 1 || endArg < startArg) {
        throw new Error('行号非法：startLine >= 1 且 endLine >= startLine');
      }
    }
    if (offsetArg !== null && (!Number.isInteger(offsetArg) || offsetArg < 1)) {
      throw new Error('offset 必须是 >= 1 的整数（1-based 起始行号）');
    }
    if (limitArg !== null && (!Number.isInteger(limitArg) || limitArg < 1)) {
      throw new Error('limit 必须是 >= 1 的整数（读取行数）');
    }
    if (maxBytes !== null && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
      throw new Error('maxBytes 必须是 >= 1 的整数');
    }

    // offset/limit 统一为 1-based：offset 起始行，limit 行数
    const explicit = startArg !== null || offsetArg !== null || limitArg !== null;
    const start = startArg ?? offsetArg ?? 1;
    const end = endArg ?? (limitArg !== null ? start + limitArg - 1 : null);

    const st = await stat(path);
    if (st.isDirectory()) throw new Error(`是目录不是文件: ${path}`);

    const fh = await open(path, 'r');
    try {
      await assertTextFile(fh, path, st.size);
      return explicit
        ? await readRange(fh, path, st.size, encoding, lineNumbers, start, end, maxBytes)
        : await readFull(fh, path, st.size, encoding, lineNumbers, maxBytes, ctx);
    } finally {
      await fh.close();
    }
  },
};

/** 二进制探测：前 BINARY_SNIFF_BYTES 字节含 NUL 视为二进制并拒绝（避免裸数据进上下文） */
async function assertTextFile(fh: FileHandle, path: string, size: number): Promise<void> {
  const len = Math.min(size, BINARY_SNIFF_BYTES);
  if (len === 0) return;
  const sniff = Buffer.alloc(len);
  await fh.read(sniff, 0, len, 0);
  if (sniff.includes(0)) {
    throw new Error(
      `二进制文件不支持读取: ${path}（前 ${BINARY_SNIFF_BYTES} 字节含 NUL）；如需处理请改用 commandRun 等工具`,
    );
  }
}

/**
 * 全文读取：默认只返回前 2000 行 / 256KB，超出时末尾追加截断提示。
 * 文件超过硬上限（16MB）直接拒绝，要求显式分段，避免大文件整体进入上下文。
 *
 * 20261106-001 新增：超限完整输出落临时文件 + 告知路径。
 * 边扫描边同时做两件事：截断片段进 shown 数组（进上下文）、
 * 完整原始内容（所有行）流式写临时文件（TmpFileWriter 自身按阈值判断是否真正创建 WriteStream，
 * 小输出零磁盘开销）。
 */
async function readFull(
  fh: FileHandle,
  path: string,
  size: number,
  encoding: BufferEncoding,
  lineNumbers: boolean,
  maxBytes: number | null,
  ctx?: ToolContext,
): Promise<string> {
  if (size > MAX_FULL_READ_BYTES) {
    throw new Error(
      `文件过大（${fmtSize(size)}），全文读取上限为 ${fmtSize(MAX_FULL_READ_BYTES)}；` +
        '请改用 startLine/endLine 或 offset/limit 分段读取，或先用 grep 定位关键行',
    );
  }

  const byteCap = maxBytes ?? DEFAULT_MAX_BYTES;
  const shown: string[] = [];
  let used = 0;
  let byteCut = false;
  let lineCut = false;
  let lineClipped = false;

  // 需求 20261106-001：超限治理（边扫描边完整落临时文件）
  // 只有当文件 size 明显可能触发截断时才创建 TmpFileWriter，避免小输出走落盘逻辑
  const willProbablyTruncate = size > byteCap || size > DEFAULT_MAX_LINES * 200;
  let tmpWriter: TmpFileWriter | null = null;
  // 需求 20261106-001：不再要求 ctx.sessionId —— buildTmpFilePath 支持 nosess_ 目录，
  // 无会话场景（CLI 首轮 / 单测）同样应保证「完整内容落盘」，否则大文件截断后无处可查
  if (willProbablyTruncate) {
    tmpWriter = new TmpFileWriter({
      sessionId: ctx?.sessionId,
      toolName: 'fileRead',
      paramDigest: summarizeParam({ path }, 'fileRead'),
      thresholds: { triggerMultiplier: 1 }, // fileRead 已知完整 size，直接按 preserveKb 触发落盘
    });
  }

  // 扫描到文件末尾（提前停止时总行数不准，这里不提前停）
  const scan = await scanLines(fh, size, encoding, (line) => {
    if (byteCut || lineCut) return;
    if (shown.length >= DEFAULT_MAX_LINES) {
      lineCut = true;
      return;
    }
    const text = clipLine(line);
    if (text !== line) lineClipped = true;
    const len = Buffer.byteLength(text, encoding) + 1; // +1 为换行
    if (used + len > byteCap) {
      byteCut = true;
      return;
    }
    used += len;
    shown.push(text);
  });

  // finalize TmpFileWriter
  // 需求 20261106-001：改为**流式复制原始字节**，而不是逐行重建后回写。
  // 逐行重建（line + '\n'）会规范化行尾（CRLF→LF）、给无换行结尾的文件补 '\n'、
  // 并按 MAX_LINE_CHARS 截断超长行，导致落盘文件与原文件字节数不一致
  // （实测 780000 字节文件落成 780001 字节）。直接复制字节才能保证「完整原始内容」。
  let fullInfo: Awaited<ReturnType<TmpFileWriter['finalize']>> | undefined;
  if (tmpWriter) {
    const w = tmpWriter;
    await new Promise<void>((resolve) => {
      const rs = createReadStream(path, { highWaterMark: CHUNK_BYTES });
      rs.on('data', (chunk: Buffer | string) => {
        w.onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      });
      rs.on('end', () => resolve());
      rs.on('error', () => resolve()); // 复制失败不阻塞主流程（提示会因 fullInfo 缺失而省略）
    });
    fullInfo = await w.finalize();
  }

  const body = lineNumbers ? withLineNumbers(shown, 1) : shown.join('\n');
  if (!byteCut && !lineCut && !lineClipped) {
    // 没超限：如果 tmpWriter 没真正创建 WriteStream，就原样返回 body（零磁盘开销）
    // 如果 tmpWriter 创建了但其实没截断（size 预判超阈值但实际没超），fullInfo 会是 undefined
    return body;
  }

  const notes = [
    `[已截断] 文件 ${path} 共 ${scan.totalLines} 行、${fmtSize(size)}，本次返回前 ${shown.length} 行。`,
  ];
  if (byteCut) notes.push(`内容已达到 ${fmtSize(byteCap)} 字节上限（可用 maxBytes 调整）。`);
  if (lineClipped) notes.push(`部分超长行按 ${MAX_LINE_CHARS} 字符截断。`);
  notes.push('继续读取请用 startLine/endLine 或 offset/limit 分段，或先用 grep 定位关键行。');

  // 需求 20261106-001：完整内容已落临时文件，追加结构化路径提示
  // bytes 取文件真实大小（旧实现报的是"收到的字节数"，与文件实际不符）
  if (fullInfo) {
    const nextStart = shown.length + 1;
    const suggestion =
      `建议: 该文件是原始内容全文，可用 fileRead 的 startLine/endLine 分段读取，` +
      `如 startLine: ${nextStart}, endLine: ${Math.min(nextStart + 200, scan.totalLines)}`;
    notes.push(buildFullOutputNotice({
      path: fullInfo.path,
      bytes: fullInfo.bytes,
      lines: fullInfo.lines, // 文件实际换行数（与文件大小同源），不再用 scan.totalLines
      complete: fullInfo.complete,
      incompleteReason: fullInfo.errorMessage
        ? `写入错误: ${fullInfo.errorMessage}`
        : `背压丢弃 ${fullInfo.contentBytes - fullInfo.bytes} 字节`,
      suggestion,
    }));
  }

  return `${body}\n\n${notes.join('\n')}`;
}

/**
 * 部分读取：显式行范围内不做默认截断，仅在传 maxBytes 时按字节截断。
 * 行号仍为文件真实行号（1-based）；超出 endLine 即停止扫描。
 */
async function readRange(
  fh: FileHandle,
  path: string,
  size: number,
  encoding: BufferEncoding,
  lineNumbers: boolean,
  start: number,
  end: number | null,
  maxBytes: number | null,
): Promise<string> {
  const shown: string[] = [];
  let used = 0;
  let byteCut = false;
  let lineClipped = false;
  let lastNo = start - 1;

  const scan = await scanLines(fh, size, encoding, (line, no) => {
    if (no < start) return;
    // 已取到目标区间：小文件继续扫描以统计总行数，大文件提前停止避免多余 I/O
    if (end !== null && no > end) return size > MAX_FULL_READ_BYTES ? false : undefined;
    if (byteCut) return;
    const text = clipLine(line);
    if (text !== line) lineClipped = true;
    if (maxBytes !== null) {
      const len = Buffer.byteLength(text, encoding) + 1;
      if (used + len > maxBytes) {
        byteCut = true;
        return false; // 达到字节上限：不再继续扫描，总行数标记为未统计
      }
      used += len;
    }
    shown.push(text);
    lastNo = no;
  });

  const headerEnd = end ?? (scan.complete ? scan.totalLines : Math.max(start, lastNo));
  const totalPart = scan.complete ? `共 ${scan.totalLines} 行` : '总行数未统计';
  const body = lineNumbers ? withLineNumbers(shown, start) : shown.join('\n');
  let out = `文件 ${path} 第 ${start}-${headerEnd} 行（${totalPart}）:\n${body}`;

  if (byteCut) {
    out += `\n\n[已截断] 已达到 maxBytes=${maxBytes} 上限（读到第 ${lastNo} 行）；继续读取请用 offset=${lastNo + 1}。`;
  }
  if (lineClipped) {
    out += `\n[已截断] 部分超长行按 ${MAX_LINE_CHARS} 字符截断。`;
  }
  return out;
}

interface ScanResult {
  /** 扫描到的行数（提前停止时只含已扫描部分） */
  totalLines: number;
  /** 是否扫描到文件末尾（false 表示被 onLine 提前终止，totalLines 不完整） */
  complete: boolean;
}

/**
 * 流式逐行扫描（内存只保留当前行，超长行只留前缀），行号与 split('\n') 语义一致。
 * onLine 返回 false 时提前停止扫描（用于「取到目标区间即停」）。
 */
async function scanLines(
  fh: FileHandle,
  size: number,
  encoding: BufferEncoding,
  onLine: (line: string, lineNo: number) => boolean | void,
): Promise<ScanResult> {
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let pending: Buffer = Buffer.alloc(0); // 当前未完结行（跨块拼接）
  let overflowed = false; // 当前行已被判为超长，仅保留前缀
  let clipped = '';
  let lineNo = 0;
  let pos = 0;
  let lastByte = -1;
  let stopped = false;

  /** 输出一行；返回 false 表示调用方要求停止 */
  const emit = (tail: Buffer): boolean => {
    const text = overflowed ? clipped : tail.toString(encoding);
    overflowed = false;
    clipped = '';
    lineNo += 1;
    if (onLine(text, lineNo) === false) {
      stopped = true;
      return false;
    }
    return true;
  };

  while (!stopped && pos < size) {
    const want = Math.min(CHUNK_BYTES, size - pos);
    const { bytesRead } = await fh.read(chunk, 0, want, pos);
    if (!bytesRead) break;
    pos += bytesRead;
    lastByte = chunk[bytesRead - 1];
    let buf = chunk.subarray(0, bytesRead);
    let idx: number;
    while (!stopped && (idx = buf.indexOf(0x0a)) >= 0) {
      const ok = overflowed
        ? emit(Buffer.alloc(0))
        : emit(pending.length ? Buffer.concat([pending, buf.subarray(0, idx)]) : buf.subarray(0, idx));
      pending = Buffer.alloc(0);
      if (!ok) break;
      buf = buf.subarray(idx + 1);
    }
    if (stopped || !buf.length) continue;
    if (!overflowed) {
      // 复制出块缓冲（下一轮 fh.read 会覆写 chunk）
      pending = pending.length ? Buffer.concat([pending, buf]) : Buffer.from(buf);
      if (pending.length > MAX_LINE_CHARS * 4) {
        const head = pending.subarray(0, MAX_LINE_CHARS * 4).toString(encoding).slice(0, MAX_LINE_CHARS);
        clipped = `${head}…（本行过长已截断）`;
        overflowed = true;
        pending = Buffer.alloc(0);
      }
    }
  }

  if (!stopped) {
    if (overflowed || pending.length > 0) emit(pending);
    // 与 split('\n') 一致：空文件、或以换行结尾时补一个空行
    else if (size === 0 || lastByte === 0x0a) emit(Buffer.alloc(0));
  }
  return { totalLines: lineNo, complete: !stopped };
}

/** 单行超长时按字符截断并标注原长（防止 minified 单行撑爆上下文） */
function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}…（本行过长已截断，原长 ${line.length} 字符）`;
}

/** 字节数可读化（截断提示用） */
function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * 为行数组添加 "行号: 内容" 前缀
 * @param lines 行数组
 * @param startNumber 首行对应的真实行号（从 1 开始）
 */
function withLineNumbers(lines: string[], startNumber: number): string {
  return lines.map((line, i) => `${startNumber + i}: ${line}`).join('\n');
}
