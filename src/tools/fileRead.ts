// 文件读取工具：全文读取或按行范围部分读取（20261021-007：默认行数/字节上限，防大文件撑爆上下文与内存）
// 20261106-001：超限完整输出落临时文件 + 告知路径（方案 B：文件内治理，边扫描边写）
// 20261111-003：删除 offset/limit 别名参数（行范围只保留 startLine/endLine），并精简工具描述
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import {
  TmpFileWriter,
  buildFullOutputNotice,
  buildTmpFilePath,
  summarizeParam,
} from './output-governor.js';
import { detectDocumentKind } from '../documents/detect.js';
import { extractDocument } from '../documents/extract.js';
import { readDocumentImages } from '../documents/images.js';
import type { DocumentKind } from '../documents/types.js';
import { resolveOcrConfig } from '../ocr/index.js';
import { configLoader } from '../config/index.js';
import { buildDocumentImageDescriber } from './vision/describe-document-image.js';

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
/** 文档解析的源文件大小上限（与文本文件 16MB 全文上限分开：docx/pdf 需整体解析） */
const MAX_DOC_SOURCE_BYTES = 50 * 1024 * 1024;
/** 单文档解析时间预算（毫秒，远小于 runner 默认 30s，保证超时前返回） */
const DOC_TIME_BUDGET_MS = 15_000;
/** 支持 pages 参数的分页文档类型（xlsx 的 page = 工作表序号） */
const PAGEABLE_DOCUMENT_KINDS = new Set<DocumentKind>(['pdf', 'pptx', 'xlsx']);
/** 文档内图片取文块的分隔行（并入提取文本后仍可被 startLine/grep 定位） */
const DOC_IMAGE_BLOCK_HEADER = '=== 文档内图片文本 ===';

export const fileRead: Tool = {
  name: 'fileRead',
  description:
    '读取文本或文档（doc/docx/pdf/xlsx/pptx/rtf/odt），默认每行带行号。大文件用 startLine/endLine 分段；分页文档可传 pages；扫描件/加密件会提示。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      startLine: {
        type: 'number',
        description: '起始行号（1-based，含该行）；与 endLine 成对使用',
      },
      endLine: {
        type: 'number',
        description: '结束行号（含该行）',
      },
      pages: {
        type: 'string',
        description: '分页文档页码（PDF/PPTX/XLSX）：3 / 3-7 / 3- / 1,4,9；与 startLine/endLine 互斥',
      },
      maxBytes: {
        type: 'number',
        description: '返回字节上限（全文默认 256KB，行范围默认不限）',
      },
      encoding: { type: 'string', description: '编码（默认 utf-8）' },
      lineNumbers: {
        type: 'boolean',
        description: '是否加行号前缀（默认 true）',
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
    const pagesArg = args.pages != null ? String(args.pages).trim() : null;

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
    if (maxBytes !== null && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
      throw new Error('maxBytes 必须是 >= 1 的整数');
    }
    // 需求 20261112-001：pages 只用于分页文档，且与行区间互斥
    if (pagesArg !== null && pagesArg !== '' && startArg !== null) {
      throw new Error('pages 与 startLine/endLine 互斥，请二选一');
    }
    const pageSelection = pagesArg ? parsePageSelection(pagesArg) : null;

    // 需求 20261111-003（C 档）：删除 offset/limit 别名参数，行范围只保留 startLine/endLine 一套语义
    const explicit = startArg !== null;
    const start = startArg ?? 1;
    const end = endArg;

    const st = await stat(path);
    if (st.isDirectory()) throw new Error(`是目录不是文件: ${path}`);

    const fh = await open(path, 'r');
    try {
      // 需求 20261112-001：先识别文档格式，再决定走纯文本管线还是文档提取管线。
      // 文件头只读一次，与二进制 NUL 嗅探共用同一缓冲（文本路径零额外 I/O）。
      const head = await readHead(fh, st.size);
      const detected = detectDocumentKind(path, head);
      if (detected.kind !== 'text') {
        if (pageSelection && !PAGEABLE_DOCUMENT_KINDS.has(detected.kind)) {
          throw new Error('pages 仅对 PDF/PPTX/XLSX 文档生效');
        }
        return await readDocument(
          path,
          detected.kind,
          detected.warning,
          encoding,
          lineNumbers,
          explicit ? start : null,
          explicit ? end : null,
          maxBytes,
          pageSelection,
          ctx,
        );
      }

      if (pageSelection) throw new Error('pages 仅对 PDF/PPTX/XLSX 文档生效');
      assertTextFile(head, path);
      return explicit
        ? await readRange(fh, path, st.size, encoding, lineNumbers, start, end, maxBytes)
        : await readFull(fh, path, st.size, encoding, lineNumbers, maxBytes, ctx);
    } finally {
      await fh.close();
    }
  },
};

/** 读取文件头（最多 BINARY_SNIFF_BYTES），供格式识别与 NUL 嗅探共用 */
async function readHead(fh: FileHandle, size: number): Promise<Buffer> {
  const len = Math.min(size, BINARY_SNIFF_BYTES);
  if (len === 0) return Buffer.alloc(0);
  const sniff = Buffer.alloc(len);
  await fh.read(sniff, 0, len, 0);
  return sniff;
}

/** 二进制探测：前 BINARY_SNIFF_BYTES 字节含 NUL 视为二进制并拒绝（避免裸数据进上下文） */
function assertTextFile(head: Buffer, path: string): void {
  if (head.includes(0)) {
    throw new Error(
      `二进制文件不支持读取: ${path}（前 ${BINARY_SNIFF_BYTES} 字节含 NUL）；当前支持文本与 doc/docx 文档，其他格式请先转换或改用 commandRun`,
    );
  }
}

interface PageSelectionRange {
  start: number;
  /** 省略表示到文档末页 */
  end?: number;
}
type PageSelection = PageSelectionRange[];

/** 解析 pages 参数：支持 3 / 3-7 / 3- / 1,4,9 */
function parsePageSelection(raw: string): PageSelection {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 50) {
    throw new Error(`页码格式非法: ${raw}（示例：3 / 3-7 / 3- / 1,4,9）`);
  }
  const out: PageSelection = [];
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (!m) throw new Error(`页码格式非法: ${raw}（示例：3 / 3-7 / 3- / 1,4,9）`);
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : m[2] === '' ? undefined : Number(m[2]);
    if (!Number.isInteger(start) || start < 1) {
      throw new Error(`页码必须 >= 1: ${part}`);
    }
    if (end !== undefined && (!Number.isInteger(end) || end < start)) {
      throw new Error(`页码范围非法: ${part}`);
    }
    out.push({ start, end });
  }
  return out;
}

/** 页码选择的可读描述（用于输出首行；xlsx 的 page 是工作表序号） */
function describePageSelection(
  selection: PageSelection,
  pageCount: number,
  kind: DocumentKind,
): string {
  const parts = selection.map((r) => {
    const end = r.end ?? pageCount;
    return end > r.start ? `${r.start}-${end}` : `${r.start}`;
  });
  return `第 ${parts.join('、')}${kind === 'xlsx' ? ' 个工作表' : ' 页'}`;
}

/**
 * 文档截断时把「完整提取文本」落盘（非原始二进制），返回可追加的提示；失败返回空串。
 * 复用 output-governor 的路径与清理机制，文案通过 completeLabel 说明落盘内容类型。
 */
function spillExtractedText(path: string, text: string, lines: number, ctx?: ToolContext): string {
  try {
    const fullPath = buildTmpFilePath(ctx?.sessionId, 'fileRead', summarizeParam({ path }, 'fileRead'));
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, text, 'utf-8');
    return buildFullOutputNotice({
      path: fullPath,
      bytes: Buffer.byteLength(text, 'utf-8'),
      lines,
      complete: true,
      completeLabel: '该文件为提取出的全文文本，非原始二进制文档',
      suggestion: '建议: 用 fileRead 的 startLine/endLine 分段读取（提取文本行号），或用 grep 定位关键行',
    });
  } catch {
    return '';
  }
}

/**
 * 文档读取（需求 20261112-001）：提取为纯文本后复用既有行号/区间/截断语义。
 * 与文本路径的差异：encoding 参数无效（文档统一输出 UTF-8），并在首行声明行号口径。
 */
async function readDocument(
  path: string,
  kind: DocumentKind,
  warning: string | undefined,
  encoding: BufferEncoding,
  lineNumbers: boolean,
  start: number | null,
  end: number | null,
  maxBytes: number | null,
  pageSelection: PageSelection | null,
  ctx?: ToolContext,
): Promise<string> {
  // 需求 20261112-002 / 任务 04：文档内图片 OCR 配置在此解析一次，
  // 既决定 PDF 是否光栅化（避免 OCR 关闭时白白 spawn 外部工具），也决定图片块是否产出。
  // 需求 20261112-004 / 任务 02：视觉取文能力（视觉优先 → OCR 兜底）由本层以回调注入，
  // documents 层不反向依赖 tools/vision。
  const ocrCfg = resolveOcrConfig();
  const docOcrOn = ocrCfg.enabled && ocrCfg.doc.enabled;

  const result = await extractDocument(path, kind, {
    maxBytes: MAX_DOC_SOURCE_BYTES,
    timeBudgetMs: DOC_TIME_BUDGET_MS,
    pdfImageOcr: docOcrOn,
    pdfOcrAllPages: ocrCfg.doc.pdfScannedPagesOnly === false,
    pdfRasterizer: ocrCfg.pdfRasterizer,
    pdfRasterEngine: ocrCfg.pdfRasterEngine,
  });

  // 块文本并入提取文本尾部，行号/截断/落盘/按页回读全部复用既有管线，不新增渲染分支。
  let docText = result.text;
  let imageWarnings: string[] = [];
  if (result.images && result.images.length > 0) {
    // vision.enabled=false（默认）或视觉三元组缺失时 buildDocumentImageDescriber 返回 undefined，
    // readDocumentImages 直接委托纯 OCR —— 行为与升级前逐字节一致。
    const cfg = configLoader.load().config;
    const describe = buildDocumentImageDescriber({
      vision: cfg.vision,
      model: cfg.model,
    });
    const outcome = await readDocumentImages(result.images, ocrCfg, { describe });
    imageWarnings = outcome.warnings;
    if (outcome.text) {
      const sep = docText === '' || docText.endsWith('\n') ? '' : '\n';
      docText = `${docText}${sep}${DOC_IMAGE_BLOCK_HEADER}\n${outcome.text}`;
    }
  }
  const docWarnings = [...result.warnings, ...imageWarnings];

  const lines = docText.split('\n');
  const totalLines = lines.length;
  const pageCount = result.pageCount ?? result.pages?.length ?? null;
  const pageUnit = kind === 'xlsx' ? ' 个工作表' : ' 页';
  const headerParts = [
    `${kind} 文档，已提取为文本，共 ${totalLines} 行${pageCount ? `（${pageCount}${pageUnit}）` : ''}`,
    '行号为提取文本行号',
  ];
  if (warning) headerParts.push(warning);
  // 文档内图片：在 header 里点名，让模型知道末尾有图片取文块可直接读到
  if (result.images && result.images.length > 0 && docText.includes(DOC_IMAGE_BLOCK_HEADER)) {
    headerParts.push(
      `末尾附 ${result.images.length} 张文档内图片的取文结果（块头 ${DOC_IMAGE_BLOCK_HEADER}）`,
    );
  }
  // 文档统一输出 UTF-8：encoding 传 utf-8/utf8 视为默认，其他值给出忽略说明
  if (encoding !== 'utf-8' && encoding !== 'utf8') {
    headerParts.push(`已忽略 encoding=${encoding}`);
  }
  const warningBlock = docWarnings.length
    ? `\n${docWarnings.map((w) => `[提示] ${w}`).join('\n')}`
    : '';

  // 按页读取（仅 PDF；execute 已校验）
  if (pageSelection) {
    if (!result.pages || !pageCount) {
      throw new Error('该文档未提供页映射，无法按页读取');
    }
    for (const range of pageSelection) {
      if (range.start > pageCount) {
        throw new Error(`页码 ${range.start} 超出文档总页数 ${pageCount}`);
      }
      if (range.end !== undefined && range.end > pageCount) {
        throw new Error(`页码 ${range.end} 超出文档总页数 ${pageCount}`);
      }
    }
    headerParts.push(`本次返回${describePageSelection(pageSelection, pageCount, kind)}`);
    const header = `[${headerParts.join('；')}]`;

    const selectedPages = result.pages.filter((pr) =>
      pageSelection.some(
        (range) => pr.page >= range.start && pr.page <= (range.end ?? pageCount),
      ),
    );
    if (selectedPages.length === 0) {
      throw new Error(`所选页码没有可返回的文本: ${describePageSelection(pageSelection, pageCount, kind)}`);
    }

    const byteCap = maxBytes ?? DEFAULT_MAX_BYTES;
    const selectedLines: Array<{ no: number; text: string }> = [];
    let used = 0;
    let byteCut = false;
    let lineCut = false;
    let lineClipped = false;

    outer: for (const page of selectedPages) {
      for (let no = page.startLine; no <= page.endLine; no++) {
        if (selectedLines.length >= DEFAULT_MAX_LINES) {
          lineCut = true;
          break outer;
        }
        const raw = lines[no - 1] ?? '';
        const text = clipLine(raw);
        if (text !== raw) lineClipped = true;
        const len = Buffer.byteLength(text, 'utf-8') + 1;
        if (used + len > byteCap) {
          byteCut = true;
          break outer;
        }
        used += len;
        selectedLines.push({ no, text });
      }
    }

    const body = lineNumbers
      ? selectedLines.map((l) => `${l.no}: ${l.text}`).join('\n')
      : selectedLines.map((l) => l.text).join('\n');
    if (!byteCut && !lineCut && !lineClipped) {
      return `${header}\n${body}${warningBlock}`;
    }

    const notes = [
      `[已截断] 本次返回 ${selectedLines.length} 行（所选页未全部返回），文档共 ${totalLines} 行。`,
    ];
    if (byteCut) notes.push(`内容已达到 ${fmtSize(byteCap)} 字节上限（可用 maxBytes 调整）。`);
    if (lineClipped) notes.push(`部分超长行按 ${MAX_LINE_CHARS} 字符截断。`);
    notes.push('继续读取请用 startLine/endLine（提取文本行号），或缩小 pages 范围。');
    const spill = spillExtractedText(path, docText, totalLines, ctx);
    return `${header}\n${body}\n\n${notes.join('\n')}${spill ? `\n${spill}` : ''}${warningBlock}`;
  }

  const header = `[${headerParts.join('；')}]`;

  // 全文模式
  if (start === null || end === null) {
    const byteCap = maxBytes ?? DEFAULT_MAX_BYTES;
    const shown: string[] = [];
    let used = 0;
    let byteCut = false;
    let lineCut = false;
    let lineClipped = false;

    for (const line of lines) {
      if (shown.length >= DEFAULT_MAX_LINES) {
        lineCut = true;
        break;
      }
      const text = clipLine(line);
      if (text !== line) lineClipped = true;
      const len = Buffer.byteLength(text, 'utf-8') + 1;
      if (used + len > byteCap) {
        byteCut = true;
        break;
      }
      used += len;
      shown.push(text);
    }

    const body = lineNumbers ? withLineNumbers(shown, 1) : shown.join('\n');
    if (!byteCut && !lineCut && !lineClipped) {
      return `${header}\n${body}${warningBlock}`;
    }

    const notes = [
      `[已截断] 文档 ${path}（${kind}）共 ${totalLines} 行，本次返回前 ${shown.length} 行。`,
    ];
    if (byteCut) notes.push(`内容已达到 ${fmtSize(byteCap)} 字节上限（可用 maxBytes 调整）。`);
    if (lineClipped) notes.push(`部分超长行按 ${MAX_LINE_CHARS} 字符截断。`);
    notes.push('继续读取请用 startLine/endLine（提取文本行号）。');
    const spill = spillExtractedText(path, docText, totalLines, ctx);
    return `${header}\n${body}\n\n${notes.join('\n')}${spill ? `\n${spill}` : ''}${warningBlock}`;
  }

  // 区间模式：start/end 均非空（execute 已保证成对）
  if (start > totalLines) {
    throw new Error(`起始行号 ${start} 超出文档总行数 ${totalLines}`);
  }
  const slice = lines.slice(start - 1, end);
  const shown: string[] = [];
  let used = 0;
  let byteCut = false;
  let lineClipped = false;
  let lastNo = start - 1;

  for (let i = 0; i < slice.length; i++) {
    const raw = slice[i];
    const no = start + i;
    const text = clipLine(raw);
    if (text !== raw) lineClipped = true;
    if (maxBytes !== null) {
      const len = Buffer.byteLength(text, 'utf-8') + 1;
      if (used + len > maxBytes) {
        byteCut = true;
        break;
      }
      used += len;
    }
    shown.push(text);
    lastNo = no;
  }

  const headerEnd = Math.min(end, totalLines);
  const body = lineNumbers ? withLineNumbers(shown, start) : shown.join('\n');
  let out = `文件 ${path}（${kind} 文档，共 ${totalLines} 行，已提取为文本）第 ${start}-${headerEnd} 行:\n${body}`;
  if (byteCut) {
    out += `\n\n[已截断] 已达到 maxBytes=${maxBytes} 上限（读到第 ${lastNo} 行）；继续读取请用 startLine=${lastNo + 1}。`;
    const spill = spillExtractedText(path, docText, totalLines, ctx);
    if (spill) out += `\n${spill}`;
  }
  if (lineClipped) {
    out += `\n[已截断] 部分超长行按 ${MAX_LINE_CHARS} 字符截断。`;
  }
  return `${out}${warningBlock}`;
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
        '请改用 startLine/endLine 分段读取，或先用 grep 定位关键行',
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
  notes.push('继续读取请用 startLine/endLine 分段，或先用 grep 定位关键行。');

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
    out += `\n\n[已截断] 已达到 maxBytes=${maxBytes} 上限（读到第 ${lastNo} 行）；继续读取请用 startLine=${lastNo + 1}。`;
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
