// 本地 OCR 类型（需求 20261112-002 / 任务 01）
//
// 职责边界：只描述「引擎能力 + 识别结果 + 错误分类」。
// 引擎抽象 OcrEngine 是演进项的接口位——补齐 macOS/Linux 实现时只需新增一个引擎文件，
// run-ocr.ts 及以上任何调用方都不需要改动（设计方案 §4.9-A）。

/** OCR 错误码：工具层与 documents 层据此给出可纠正提示 */
export type OcrErrorCode =
  /** 本机没有可用引擎（Windows 缺语言包 / 非 Windows 且无 http 端点） */
  | 'engine_missing'
  /** 平台不支持（非 Windows 且未配置 http 端点，属演进项） */
  | 'platform_unsupported'
  /** 指定语言在引擎中不可用 */
  | 'lang_unsupported'
  /** 图片超过大小上限 */
  | 'image_too_large'
  /** 图片格式不受支持（按魔数判定） */
  | 'unsupported_format'
  /** 引擎超时 */
  | 'timeout'
  /** 引擎成功但识别为空 */
  | 'empty'
  /** 引擎调用失败（脚本报错、进程非零退出等） */
  | 'engine_failed'
  /** 输入参数不合法（空、不支持的来源类型等） */
  | 'bad_input';

/** OCR 调用错误：code 供调用方分支，message 已是面向用户的中文提示 */
export class OcrError extends Error {
  constructor(
    readonly code: OcrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OcrError';
  }
}

/** 引擎调用选项 */
export interface OcrOptions {
  /** 语言标签；省略用 ocr.lang（'auto' 取引擎首选） */
  lang?: string;
  /** 单次超时（毫秒） */
  timeoutMs?: number;
  /** 结果字符上限（超出截断并追加说明） */
  maxChars?: number;
}

/** 识别结果 */
export interface OcrResult {
  /** 已后处理（D4：CJK 空格合并、空行收敛）的文本 */
  text: string;
  /** 引擎标识：'winrt-ocr' | 'http' */
  engine: string;
  /** 实际使用的语言标签 */
  lang: string;
  /** 端到端耗时（毫秒） */
  elapsedMs: number;
  /** 引擎不提供则为 undefined，不臆造（WinRT 不返回置信度） */
  confidence?: number;
  /** 非致命告警（语言回退、结果截断、缓存命中等） */
  warnings: string[];
}

/**
 * 引擎接口（演进项接口位）。
 * `isAvailable()` 必须是「探测 + 进程内缓存」语义：调用方可能在每次工具执行时问它。
 */
export interface OcrEngine {
  /** 引擎标识，同时作为缓存 key 与结果标注的一部分 */
  readonly id: string;
  /** 支持语言标签（探测结果；未探测时为空数组） */
  readonly langs: string[];
  isAvailable(): Promise<boolean>;
  /** 识别图片；失败抛 OcrError */
  recognize(image: Buffer, opts: OcrOptions): Promise<OcrResult>;
}

/** 由魔数判定的图片格式（供引擎选择临时文件扩展名） */
export type ImageFormat = 'png' | 'jpeg' | 'bmp' | 'gif' | 'webp' | 'tiff';

/**
 * 按魔数识别图片格式（不信任扩展名：文档内图片常有无扩展名或错误扩展名的情况）。
 * 返回 null 表示不受支持的格式。
 */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return 'tiff';
  return null;
}

/** 格式 → 临时文件扩展名（WinRT BitmapDecoder 靠内容而非扩展名，扩展名只为人可读） */
export const IMAGE_EXT_BY_FORMAT: Record<ImageFormat, string> = {
  png: '.png',
  jpeg: '.jpg',
  bmp: '.bmp',
  gif: '.gif',
  webp: '.webp',
  tiff: '.tif',
};


/** 引擎输出结果的内部形态（未经后处理） */
export interface RawOcrOutput {
  text: string;
  lang: string;
  elapsedMs: number;
  warnings: string[];
}
