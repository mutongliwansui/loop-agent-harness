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

/** 版面输出形态（需求 20261112-003 / D2） */
export type OcrLayout =
  /** 视觉行文本（默认）：按 y 中心聚类重建人眼所见行，列间用 ` | ` 标记 */
  | 'text'
  /** markdown 表格：在 text 基础上做 x 投影列聚类 */
  | 'table'
  /** 词级坐标 TSV：`x\ty\tw\th\ttext`，供精确几何推理 */
  | 'words';

/** 词级识别结果（坐标为引擎输入位图的像素，scale/crop 后） */
export interface OcrWord {
  /** 词文本 */
  t: string;
  /** 左边界 x */
  x: number;
  /** 上边界 y */
  y: number;
  /** 宽 */
  w: number;
  /** 高 */
  h: number;
}

/**
 * 引擎给出的原始行。
 * 注意：引擎的「行」粒度比人眼所见更细（同一视觉行里的名称与日期会被切成两个 Line），
 * 因此上层必须用 `buildVisualLines()` 按 y 中心再聚类（需求 20261112-003 / D3）。
 */
export interface OcrLine {
  text: string;
  words: OcrWord[];
}

/** 引擎输入位图的像素尺寸（scale/crop 之后） */
export interface OcrImageSize {
  width: number;
  height: number;
}

/** 引擎调用选项 */
export interface OcrOptions {
  /** 语言标签；省略用 ocr.lang（'auto' 取引擎首选） */
  lang?: string;
  /** 单次超时（毫秒） */
  timeoutMs?: number;
  /** 结果字符上限（超出截断并追加说明） */
  maxChars?: number;
  /** 版面输出形态；省略用 ocr.layout（默认 'text'） */
  layout?: OcrLayout;
  /** 整数放大倍数 1–4（默认 1）；小字误识时用 2（D6） */
  scale?: number;
  /** 裁剪区域 [x, y, w, h]（原图像素，默认整图）（D6） */
  crop?: [number, number, number, number];
}

/** 识别结果 */
export interface OcrResult {
  /** 已后处理（D4：CJK 空格合并、空行收敛）的文本 */
  text: string;
  /** 引擎标识：'winrt-ocr' | 'http' */
  engine: string;
  /** 实际使用的语言标签 */
  lang: string;
  /** 端到端耗时（毫秒，含进程启动与解码；D8 起如实反映体感） */
  elapsedMs: number;
  /** 纯识别耗时（毫秒）；与 elapsedMs 之差即进程启动+解码+预处理的固定开销（D8） */
  recognizeMs?: number;
  /** 引擎不提供则为 undefined，不臆造（WinRT 不返回置信度） */
  confidence?: number;
  /** 非致命告警（语言回退、结果截断、缓存命中等） */
  warnings: string[];
  /** 结构化行（仅提供坐标的引擎才有；供表格/坐标输出与行数统计） */
  lines?: OcrLine[];
  /** 引擎输入位图尺寸（无坐标引擎为 undefined） */
  imageSize?: OcrImageSize;
  /** 实际使用的版面形态（省略视为 'text'） */
  layout?: OcrLayout;
  /** 视觉行数（y 聚类后的行数，仅坐标引擎有） */
  lineCount?: number;
  /** 词数（仅坐标引擎有） */
  wordCount?: number;
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

/**
 * 裁剪参数 → 脚本参数串 `x,y,w,h`（空串表示整图）。
 *
 * 放在 types.ts 而不是 engine-winrt.ts：它同时被 run-ocr（缓存 key）与 engine-winrt
 * （脚本入参）使用，单测会用 mock 整体替换 engine-winrt 模块，从中取纯函数会踩空。
 */
export function formatCropArg(crop?: [number, number, number, number]): string {
  if (!crop || crop.length !== 4) return '';
  return crop.map((n) => Math.max(0, Math.round(n))).join(',');
}


/** 引擎输出结果的内部形态（未经后处理） */
export interface RawOcrOutput {
  text: string;
  lang: string;
  elapsedMs: number;
  warnings: string[];
  /** 结构化行（无坐标引擎省略） */
  lines?: OcrLine[];
  /** 引擎输入位图尺寸（无坐标引擎省略） */
  imageSize?: OcrImageSize;
}
