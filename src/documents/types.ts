// 文档层类型（需求 20261112-001 / 任务 01）
// 职责边界：只描述「识别结果 + 提取结果」，行号/截断/落盘由工具层处理。

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

/** 提取结果 */
export interface ExtractResult {
  kind: DocumentKind;
  /** 规范化后的提取文本（LF 换行） */
  text: string;
  pages?: PageRange[];
  pageCount?: number;
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
