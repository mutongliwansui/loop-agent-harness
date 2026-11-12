// 文档层类型（需求 20261112-001 / 任务 01）
// 职责边界：只描述「识别结果 + 提取结果」，行号/截断/落盘由工具层处理。

import type { PdfRasterEngine } from '../config/schema.js';

/** 受支持的文档种类；xls/ppt 仅用于识别后给出「另存为」提示 */
export type DocumentKind =
  | 'doc'
  | 'docx'
  | 'pdf'
  | 'rtf'
  | 'odt'
  | 'xlsx'
  | 'pptx'
  | 'xls'
  | 'ppt';

/** 格式识别结果：text 表示继续走现有纯文本路径 */
export interface DetectResult {
  kind: DocumentKind | 'text';
  /** 扩展名与实际魔数不符时的说明（例如 .doc 实际是 PDF） */
  warning?: string;
}

/** 提取选项 */
export interface ExtractOptions {
  /** 源文件大小上限（字节） */
  maxBytes: number;
  /** 单文档时间预算（毫秒）；超预算不中断已完成结果，只追加告警 */
  timeBudgetMs?: number;
  /** run 级取消信号（预留给耗时提取器） */
  signal?: AbortSignal;
  /**
   * 任务 04：PDF 的 OCR 目标页范围。
   * false/省略 = 只光栅化「无文本层」页；true = 全部页都光栅化。
   * 由工具层按 `ocr.doc.pdfScannedPagesOnly` 取反传入——documents 层只接收策略，不读 OCR 配置。
   */
  pdfOcrAllPages?: boolean;
  /**
   * 任务 04：是否对 PDF 无文本层页做光栅化（供 OCR 使用）。
   * false/省略时完全不 spawn 光栅化工具，保证「OCR 关闭 / 非 Windows」零额外开销。
   */
  pdfImageOcr?: boolean;
  /** 任务 04：自定义 PDF 光栅化命令模板（`ocr.pdfRasterizer`） */
  pdfRasterizer?: string;
  /** 需求 20261112-004：PDF 渲染引擎策略（`ocr.pdfRasterEngine`），缺省 auto */
  pdfRasterEngine?: PdfRasterEngine;
}

/** 分页文档的页 ↔ 提取文本行映射（任务 02 起由 PDF/PPTX 提供） */
export interface PageRange {
  /** 1-based 页号 */
  page: number;
  /** 该页文本在整体提取文本中的起始行（1-based，含） */
  startLine: number;
  /** 结束行（1-based，含） */
  endLine: number;
}

/** 文档内嵌图片或 PDF 扫描页（需求 20261112-002 / 任务 04） */
export interface DocumentImage {
  /** 文档内标识：zip 路径（如 word/media/image1.png）或 PDF 页标识（如 pdf-page-3） */
  name: string;
  /** 图片原始字节 */
  data: Buffer;
  /** 在文档中的呈现顺序（1-based，用于块标注「图片 3」） */
  index: number;
  /** 来源：OOXML 内嵌图片 / PDF 扫描页光栅化产物 */
  source: 'embedded' | 'pdf-page';
  /** source='pdf-page' 时的 1-based 页号 */
  page?: number;
}

/** 提取结果 */
export interface ExtractResult {
  kind: DocumentKind;
  /** 规范化后的提取文本（LF 换行） */
  text: string;
  pages?: PageRange[];
  pageCount?: number;
  /**
   * 文档内图片（任务 04）。
   * 只做「收集」，OCR 与预算由工具层（fileRead）按 `ocr.doc.*` 决定，
   * 保证 documents 层不依赖 OCR 引擎、非 Windows 平台行为不变。
   */
  images?: DocumentImage[];
  /** 可读告警（不阻断结果） */
  warnings: string[];
  /** 是否因页数/字符数/时间预算提前结束 */
  truncated: boolean;
}

/** 提取错误码：工具层据此给可纠正提示 */
export type ExtractErrorCode =
  | 'unsupported'
  | 'corrupt'
  | 'encrypted'
  | 'too_large'
  | 'scanned'
  | 'timeout'
  | 'empty';

export class DocumentExtractError extends Error {
  constructor(
    readonly code: ExtractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentExtractError';
  }
}
