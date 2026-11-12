// 文档提取调度与文本规范化（需求 20261112-001 / 任务 01）
//
// 本任务实现 doc/docx；pdf/rtf/odt/xlsx/pptx 由任务 02/03 接入。
// 提取结果统一经 normalizeText()，保证工具层行号、grep 匹配与截断口径一致。

import { stat } from 'node:fs/promises';
import {
  DocumentExtractError,
  type DocumentImage,
  type DocumentKind,
  type ExtractOptions,
  type ExtractResult,
} from './types.js';
import { collectZipImages } from './images.js';
import { extractWordBody } from './word.js';
import { docxBodyFromZip } from './docx.js';
import { readOfficeZip } from './zip-text.js';
import { extractPdf } from './pdf.js';
import { extractXlsx } from './xlsx.js';
import { extractPptx } from './pptx.js';
import { extractRtf } from './rtf.js';
import { extractOdt } from './odt.js';
import { normalizeText } from './text.js';

export { normalizeText };

/** 当前已实现的格式（用于错误提示） */
const SUPPORTED_NOW = 'doc、docx、pdf、xlsx、pptx、rtf、odt';

/** 字节数可读化（错误提示用） */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** .doc（OLE）提取错误映射（底层消息附加在末尾，便于排查） */
async function extractDocSafely(absPath: string): Promise<string> {
  try {
    return await extractWordBody(absPath);
  } catch (e) {
    // 超时已是可纠正的明确语义（需求 20261112-005），不再包装成「文件损坏」
    if (e instanceof DocumentExtractError) throw e;
    const detail = e instanceof Error ? e.message : String(e);
    throw new DocumentExtractError(
      'corrupt',
      `Word 97-2003（.doc）文档解析失败（文件损坏或格式不符）: ${detail}`,
    );
  }
}

/**
 * docx 走零依赖 zip 解析（需求 20261112-005）。
 * 统一在此补「解析失败」语义：底层 zip 校验抛出的 corrupt 消息只说明「不是合法 zip」，
 * 直接透出会让上层（fileRead）出现与 .doc 不一致的措辞；同时保留 too_large / timeout 原语义。
 */
async function withDocxCorruptContext<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DocumentExtractError) {
      if (e.code !== 'corrupt') throw e;
      throw new DocumentExtractError(
        'corrupt',
        `Word（.docx）文档解析失败（文件损坏或格式不符）: ${e.message}`,
      );
    }
    const detail = e instanceof Error ? e.message : String(e);
    throw new DocumentExtractError(
      'corrupt',
      `Word（.docx）文档解析失败（文件损坏或格式不符）: ${detail}`,
    );
  }
}

/**
 * 提取文档文本。
 * @param absPath 文件绝对路径
 * @param kind detectDocumentKind() 的识别结果
 * @param opts 大小上限与时间预算
 */
export async function extractDocument(
  absPath: string,
  kind: DocumentKind,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  let size: number;
  try {
    const st = await stat(absPath);
    if (st.isDirectory()) {
      throw new DocumentExtractError('corrupt', `是目录不是文件: ${absPath}`);
    }
    size = st.size;
  } catch (e) {
    if (e instanceof DocumentExtractError) throw e;
    throw new DocumentExtractError('corrupt', `文件不存在或不可读: ${absPath}`);
  }

  if (size > opts.maxBytes) {
    throw new DocumentExtractError(
      'too_large',
      `文档过大（${formatBytes(size)}），解析上限为 ${formatBytes(opts.maxBytes)}`,
    );
  }

  const startedAt = Date.now();

  // PDF 自带页映射与规范化，直接返回；其余格式走「提取原文 → 统一规范化」
  if (kind === 'pdf') {
    return extractPdf(absPath, {
      maxBytes: opts.maxBytes,
      timeBudgetMs: opts.timeBudgetMs,
      signal: opts.signal,
      pdfOcrAllPages: opts.pdfOcrAllPages,
      pdfImageOcr: opts.pdfImageOcr,
      pdfRasterizer: opts.pdfRasterizer,
      pdfRasterEngine: opts.pdfRasterEngine,
    });
  }

  let raw: string;
  let images: DocumentImage[] | undefined;
  switch (kind) {
    case 'doc':
      raw = await extractDocSafely(absPath);
      break;
    case 'docx': {
      // 需求 20261112-005：docx 走零依赖 zip 解析（正文与图片共用一次解包），
      // 彻底绕开 word-extractor(yauzl) 在「条目压缩后 ≥16384」时永不 settle 的挂起。
      raw = await withDocxCorruptContext(async () => {
        const zip = await readOfficeZip(absPath);
        // 任务 04：docx 的媒体文件与正文同在一个 zip 包内，单独收集（失败不影响正文）
        images = collectZipImages(zip);
        return docxBodyFromZip(zip);
      });
      break;
    }
    case 'xlsx':
      return extractXlsx(absPath, opts);
    case 'pptx':
      return extractPptx(absPath, opts);
    case 'rtf':
      return extractRtf(absPath, opts);
    case 'odt':
      return extractOdt(absPath, opts);
    case 'xls':
    case 'ppt':
      throw new DocumentExtractError(
        'unsupported',
        `暂不支持旧版 .${kind}，请另存为 .${kind === 'xls' ? 'xlsx' : 'pptx'} 或 PDF；当前已支持 ${SUPPORTED_NOW}`,
      );
  }

  const text = normalizeText(raw);
  const warnings: string[] = [];
  if (!text.trim()) {
    // 纯图片 docx（如扫描件直接插入 Word）没有正文，但收集到图片时仍交回工具层决定是否 OCR
    if (!images || images.length === 0) {
      throw new DocumentExtractError('empty', `文档没有可提取的文本: ${absPath}`);
    }
    warnings.push(`文档没有可提取的正文，仅收集到 ${images.length} 张图片`);
  }

  const elapsed = Date.now() - startedAt;
  if (opts.timeBudgetMs && elapsed > opts.timeBudgetMs) {
    warnings.push(
      `解析耗时 ${(elapsed / 1000).toFixed(1)}s，超过 ${(opts.timeBudgetMs / 1000).toFixed(0)}s 预算`,
    );
  }

  return { kind, text, images, warnings, truncated: false };
}
