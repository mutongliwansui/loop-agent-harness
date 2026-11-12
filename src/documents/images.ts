// 文档内图片收集与取文块拼装（需求 20261112-002 / 任务 04；需求 20261112-004 / 任务 02 视觉优先）
//
// 职责边界：
// - 本文件只做「从 OOXML 压缩包收集图片」+「按三重预算取文并拼成文本块」；
// - 不触碰行号/截断/落盘——块文本追加到提取文本尾部后，由工具层既有管线统一处理；
// - 取文策略两层：
//   ① `readDocumentImages()`（新）：视觉优先 → 本地 OCR 兜底，与 `analyzeImage` 语义一致；
//      视觉能力由 tools 层以回调注入（`deps.describe`），本层不反向 import tools/vision；
//   ② `ocrDocumentImages()`（旧）：纯 OCR，保留原样，`readDocumentImages()` 在无视觉能力时直接委托它；
// - 引擎不可用（非 Windows / 缺语言包 / ocr.enabled=false）且无视觉能力时整块降级为空串，
//   保证「非 Windows 平台零影响」（D1）。

import type { OcrConfig } from '../config/schema.js';
import { OcrError, runOcr, truncateOcrText, sniffImageFormat } from '../ocr/index.js';
import type { DocumentImage } from './types.js';
import { readOfficeZip } from './zip-text.js';

/** OOXML 图片所在目录（word/media、ppt/media、xl/media） */
const OOXML_MEDIA_DIR = /(^|\/)(word|ppt|xl)\/media\//i;

/** 图片文件名常见扩展名（仅作为预筛，最终以魔数为准） */
const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|tiff?|webp)$/i;

/**
 * 从已解压的 OOXML 压缩包收集图片。
 * 按 zip 内路径自然序排序（image1、image2、image10 而非字典序），并赋 1-based 序号。
 * 只保留能被魔数识别的图片（emf/wmf 等矢量图与损坏条目直接跳过，不产生噪声）。
 */
export function collectZipImages(zip: Map<string, Buffer>): DocumentImage[] {
  const picked: Array<{ name: string; data: Buffer }> = [];
  for (const [name, data] of zip) {
    if (!OOXML_MEDIA_DIR.test(name)) continue;
    if (!IMAGE_EXT.test(name)) continue;
    if (!sniffImageFormat(data)) continue;
    picked.push({ name, data });
  }
  picked.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return picked.map((p, i) => ({
    name: p.name,
    data: p.data,
    index: i + 1,
    source: 'embedded' as const,
  }));
}

/** 引擎整体不可用的错误码：出现即整块降级，不再逐张产出失败块 */
function isEngineUnavailable(code: string): boolean {
  return code === 'engine_missing' || code === 'platform_unsupported';
}

/**
 * 从 OOXML 文件直接收集图片（docx 用；pptx/xlsx 内部已有 zip，直接调 collectZipImages）。
 * 读包失败不影响文本提取结果：返回空数组，让调用方按「无图片」处理。
 */
export async function collectDocxImages(absPath: string): Promise<DocumentImage[]> {
  try {
    return collectZipImages(await readOfficeZip(absPath));
  } catch {
    return [];
  }
}

/** 图片块的可读标签：PDF 页用页码，OOXML 用 zip 内路径 */
export function imageLabel(img: DocumentImage): string {
  return img.source === 'pdf-page' ? `第 ${img.page ?? img.index} 页` : img.name;
}

/** 文档内图片 OCR 结果 */
export interface DocImageOcrOutcome {
  /** 追加到提取文本尾部的块文本；空串表示不产出任何块（含整块降级） */
  text: string;
  /** 汇总告警（进 ExtractResult.warnings 同款文案，由工具层统一加 [提示] 前缀） */
  warnings: string[];
  /** 实际完成 OCR 的图片数 */
  ocrDone: number;
  /** 未产出识别文本的图片数（超上限 / 超预算 / 单张失败） */
  skipped: number;
  /** 是否因引擎不可用整体降级 */
  engineUnavailable: boolean;
}

const EMPTY_OUTCOME: DocImageOcrOutcome = {
  text: '',
  warnings: [],
  ocrDone: 0,
  skipped: 0,
  engineUnavailable: false,
};

/**
 * 对文档内图片按三重预算做 OCR 并拼成文本块（D3）。
 *
 * 预算口径：
 * - 张数：`ocr.doc.maxImages`，超出的图片只留一行「未 OCR（超上限）」；
 * - 时间：`ocr.doc.timeBudgetMs` 为整篇总预算，单张超时取剩余预算与 `ocr.timeoutMs` 的较小值，
 *   保证不会因单张超时击穿文档级预算；
 * - 字符：`ocr.doc.maxCharsPerImage` 单张截断，截断处显式标注。
 *
 * 块格式（§5）：`[图片 3（word/media/image2.png）：OCR 文本]` … `[/图片 3]`；
 * 单张失败为单行 `[图片 3（…）：OCR 失败（code）：message]`；引擎不可用时整块不产出。
 */
export async function ocrDocumentImages(
  images: DocumentImage[],
  cfg: OcrConfig,
): Promise<DocImageOcrOutcome> {
  if (images.length === 0) return { ...EMPTY_OUTCOME };
  if (!cfg.enabled || !cfg.doc.enabled) return { ...EMPTY_OUTCOME };

  const maxImages = cfg.doc.maxImages > 0 ? cfg.doc.maxImages : images.length;
  const budgetMs = cfg.doc.timeBudgetMs > 0 ? cfg.doc.timeBudgetMs : 0;
  const startedAt = Date.now();
  // 预算文案：小于 1s 时用毫秒，避免出现「超过 0s 时间预算」这种读不懂的提示
  const budgetLabel = budgetMs >= 1000 ? `${(budgetMs / 1000).toFixed(0)}s` : `${budgetMs}ms`;

  const blocks: string[] = [];
  const warnings: string[] = [];
  let ocrDone = 0;
  let skipped = 0;
  let overLimit = 0;
  let overBudget = 0;
  let failed = 0;
  let engineUnavailable = false;

  for (const img of images) {
    const label = imageLabel(img);
    if (img.index > maxImages) {
      overLimit++;
      skipped++;
      blocks.push(`[图片 ${img.index}（${label}）：未 OCR（超过单文档 ${maxImages} 张上限）]`);
      continue;
    }
    const elapsed = Date.now() - startedAt;
    if (budgetMs > 0 && elapsed >= budgetMs) {
      overBudget++;
      skipped++;
      blocks.push(
        `[图片 ${img.index}（${label}）：未 OCR（超过 ${budgetLabel} 时间预算）]`,
      );
      continue;
    }

    const remaining = budgetMs > 0 ? budgetMs - elapsed : cfg.timeoutMs;
    const perImageTimeout = Math.max(1000, Math.min(cfg.timeoutMs, remaining));

    try {
      const result = await runOcr(img.data, { config: cfg, timeoutMs: perImageTimeout });
      const clipped = truncateOcrText(result.text, cfg.doc.maxCharsPerImage);
      const body = clipped.text.trim() ? clipped.text.trim() : '（未识别到文字）';
      const note = clipped.truncated ? `（已截断至 ${cfg.doc.maxCharsPerImage} 字符）` : '';
      blocks.push(`[图片 ${img.index}（${label}）：OCR 文本]\n${body}${note}\n[/图片 ${img.index}]`);
      ocrDone++;
    } catch (e) {
      const code = e instanceof OcrError ? e.code : 'engine_failed';
      const message = e instanceof Error ? e.message : String(e);
      if (isEngineUnavailable(code)) {
        engineUnavailable = true;
        // 尚未成功识别过任何图片：整块降级，不留半截提示（非 Windows 零影响）
        if (ocrDone === 0) blocks.length = 0;
        break;
      }
      failed++;
      skipped++;
      blocks.push(`[图片 ${img.index}（${label}）：OCR 失败（${code}）：${message}]`);
    }
  }

  if (engineUnavailable && ocrDone === 0) {
    return {
      text: '',
      warnings: [`文档内图片 OCR 不可用，已跳过 ${images.length} 张图片（${
        cfg.http?.endpoint ? '见 ocr 配置' : 'Windows 需安装 OCR 语言包'
      }）`],
      ocrDone: 0,
      skipped: images.length,
      engineUnavailable: true,
    };
  }

  if (ocrDone > 0) {
    warnings.push(`文档内共 ${images.length} 张图片，已 OCR ${ocrDone} 张并附在正文之后`);
  }
  if (overLimit > 0) {
    warnings.push(`${overLimit} 张图片超过单文档 ${maxImages} 张上限未 OCR（可用 ocr.doc.maxImages 调整）`);
  }
  if (overBudget > 0) {
    warnings.push(
      `${overBudget} 张图片超过 ${budgetLabel} 时间预算未 OCR（可用 ocr.doc.timeBudgetMs 调整）`,
    );
  }
  if (failed > 0) {
    warnings.push(`${failed} 张图片 OCR 失败（详见正文图片块）`);
  }

  return {
    text: blocks.join('\n'),
    warnings,
    ocrDone,
    skipped,
    engineUnavailable: false,
  };
}

// ---------------------------------------------------------------------------
// 视觉优先取文（需求 20261112-004 / 任务 02）
// ---------------------------------------------------------------------------

/**
 * 单图视觉取文能力（由 tools 层注入）。
 * 抛错即视为该图视觉失败（上层据此降级本地 OCR 并把错误摘要写进块内）。
 *
 * @param img 文档内图片（原始字节，不落盘）
 * @param timeoutMs 本次调用的时间上限（已按文档总预算剩余量收敛）
 */
export type ImageDescriber = (
  img: DocumentImage,
  timeoutMs: number,
) => Promise<{ text: string; model: string }>;

/** 取文策略依赖 */
export interface ReadDocumentImagesDeps {
  /** 视觉取文能力；缺省或返回 undefined 时退化为纯 OCR（行为等同旧版） */
  describe?: ImageDescriber;
}

/** 视觉优先取文结果（在纯 OCR 结果上补两个计数） */
export interface DocImageReadOutcome extends DocImageOcrOutcome {
  /** 视觉模型成功描述的图片数 */
  visionDone: number;
  /** 视觉失败后由本地 OCR 兜底的图片数 */
  degraded: number;
}

/**
 * OCR 降级的固定尾部说明（与 `tools/vision/ocr-fallback.ts` 的 CAPABILITY_NOTE 同文案）。
 * documents 层不能反向 import tools/vision，故此处自持一份；
 * `tests/doc-images-vision.test.ts` 断言二者一致，防止文案漂移。
 */
export const OCR_CAPABILITY_NOTE =
  '说明：本地 OCR 只提供图片中的文字，无法回答颜色、布局、图标、数量等视觉类问题。';

/** 视觉错误摘要：取首个非空行并截断（与 tools/vision 的 summarizeVisionError 同口径） */
function summarizeVisionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const firstLine = raw.split(/[\r\n]+/).map((s) => s.trim()).find((s) => s !== '') ?? '';
  const s = firstLine || '未知错误';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 把单图取文结果拼成块（块头格式 `[图片 N（标签）：<kind>]` … `[/图片 N]`） */
function buildImageBlock(label: string, kind: string, body: string, index: number): string {
  return `[图片 ${index}（${label}）：${kind}]\n${body}\n[/图片 ${index}]`;
}

/**
 * 文档内图片取文：视觉优先 → 本地 OCR 兜底（D1/D4/D5）。
 *
 * 判定顺序：
 * 1. 无 `deps.describe`，或 `ocr.doc.preferVision === false` → 直接委托 `ocrDocumentImages()`
 *    （纯 OCR，零行为变化）；
 * 2. 视觉可用 → 逐图调 `describe`：成功写「视觉描述」块，抛错则摘要后降级 OCR；
 * 3. OCR 也失败 → 块内保留两条原因；视觉侧从未成功、OCR 又整引擎不可用 → 整块降级（D6）。
 *
 * 预算口径与 `ocrDocumentImages()` 完全一致：张数、总时间、单图字符数三重约束都不放宽。
 */
export async function readDocumentImages(
  images: DocumentImage[],
  cfg: OcrConfig,
  deps?: ReadDocumentImagesDeps,
): Promise<DocImageReadOutcome> {
  const describe = deps?.describe;
  // 分闸（D3）：preferVision 显式为 false 时回到纯 OCR；容错上只有严格的 false 才关。
  if (!describe || cfg.doc.preferVision === false) {
    const legacy = await ocrDocumentImages(images, cfg);
    return { ...legacy, visionDone: 0, degraded: 0 };
  }
  if (images.length === 0) {
    return { ...EMPTY_OUTCOME, visionDone: 0, degraded: 0 };
  }
  if (!cfg.enabled || !cfg.doc.enabled) {
    return { ...EMPTY_OUTCOME, visionDone: 0, degraded: 0 };
  }

  const maxImages = cfg.doc.maxImages > 0 ? cfg.doc.maxImages : images.length;
  const budgetMs = cfg.doc.timeBudgetMs > 0 ? cfg.doc.timeBudgetMs : 0;
  const startedAt = Date.now();
  const budgetLabel = budgetMs >= 1000 ? `${(budgetMs / 1000).toFixed(0)}s` : `${budgetMs}ms`;

  const blocks: string[] = [];
  const warnings: string[] = [];
  let visionDone = 0;
  let ocrDone = 0;
  let degraded = 0;
  let skipped = 0;
  let overLimit = 0;
  let overBudget = 0;
  let failed = 0;
  let engineUnavailable = false;
  /** 首张图就撞上「OCR 引擎整体不可用」时用于整块降级判定 */
  let anyText = false;

  for (const img of images) {
    const label = imageLabel(img);
    if (img.index > maxImages) {
      overLimit++;
      skipped++;
      blocks.push(`[图片 ${img.index}（${label}）：未取文（超过单文档 ${maxImages} 张上限）]`);
      continue;
    }
    const elapsed = Date.now() - startedAt;
    if (budgetMs > 0 && elapsed >= budgetMs) {
      overBudget++;
      skipped++;
      blocks.push(`[图片 ${img.index}（${label}）：未取文（超过 ${budgetLabel} 时间预算）]`);
      continue;
    }
    const remaining = budgetMs > 0 ? budgetMs - elapsed : cfg.timeoutMs;

    // ① 视觉优先
    let visionErr: unknown;
    try {
      const r = await describe(img, Math.max(1000, remaining));
      const clipped = truncateOcrText(r.text, cfg.doc.maxCharsPerImage);
      const body = clipped.text.trim() ? clipped.text.trim() : '（未识别到文字）';
      const note = clipped.truncated ? `（已截断至 ${cfg.doc.maxCharsPerImage} 字符）` : '';
      blocks.push(buildImageBlock(label, '视觉描述', `${body}${note}`, img.index));
      visionDone++;
      anyText = true;
      continue;
    } catch (e) {
      visionErr = summarizeVisionError(e);
    }

    // ② 视觉失败 → 本地 OCR 兜底（降级必须显式标注，绝不静默）
    const perImageTimeout = Math.max(
      1000,
      Math.min(cfg.timeoutMs, budgetMs > 0 ? budgetMs - (Date.now() - startedAt) : cfg.timeoutMs),
    );
    try {
      const result = await runOcr(img.data, { config: cfg, timeoutMs: perImageTimeout });
      const clipped = truncateOcrText(result.text, cfg.doc.maxCharsPerImage);
      const body = clipped.text.trim() ? clipped.text.trim() : '（未识别到文字）';
      const note = clipped.truncated ? `（已截断至 ${cfg.doc.maxCharsPerImage} 字符）` : '';
      const head =
        `[图片 ${img.index}（${label}）：OCR 文本（视觉不可用：${visionErr as string}；` +
        `已降级为本地 OCR${result.engine ? `（${result.engine}）` : ''}）]`;
      blocks.push(`${head}\n${body}${note}\n\n${OCR_CAPABILITY_NOTE}\n[/图片 ${img.index}]`);
      ocrDone++;
      degraded++;
      anyText = true;
    } catch (e) {
      const code = e instanceof OcrError ? e.code : 'engine_failed';
      const message = e instanceof Error ? e.message : String(e);
      if (isEngineUnavailable(code) && !anyText) {
        engineUnavailable = true;
        // 一张都没产出：整块降级，不留半截提示（与纯 OCR 路径的语义一致）
        blocks.length = 0;
        break;
      }
      if (isEngineUnavailable(code)) engineUnavailable = true;
      failed++;
      skipped++;
      // 视觉与 OCR 双双失败：两条原因都保留，便于现场判断到底缺什么能力
      blocks.push(
        `[图片 ${img.index}（${label}）：取文失败（视觉：${visionErr as string}；OCR：${code}）：${message}]`,
      );
    }
  }

  if (engineUnavailable && !anyText) {
    return {
      text: '',
      warnings: [
        `文档内图片取文不可用，已跳过 ${images.length} 张图片（${
          cfg.http?.endpoint ? '见 ocr 配置' : '视觉未启用且本机无可用 OCR 引擎'
        }）`,
      ],
      ocrDone: 0,
      skipped: images.length,
      engineUnavailable: true,
      visionDone: 0,
      degraded: 0,
    };
  }

  if (visionDone > 0 || ocrDone > 0) {
    const parts = [
      `文档内共 ${images.length} 张图片，已取文 ${visionDone + ocrDone} 张并附在正文之后`,
      `视觉模型 ${visionDone} 张、本地 OCR ${ocrDone} 张`,
    ];
    if (degraded > 0) parts.push(`其中 ${degraded} 张为视觉失败降级`);
    warnings.push(parts.join('，'));
  }
  if (overLimit > 0) {
    warnings.push(`${overLimit} 张图片超过单文档 ${maxImages} 张上限未取文（可用 ocr.doc.maxImages 调整）`);
  }
  if (overBudget > 0) {
    warnings.push(
      `${overBudget} 张图片超过 ${budgetLabel} 时间预算未取文（可用 ocr.doc.timeBudgetMs 调整）`,
    );
  }
  if (failed > 0) {
    warnings.push(`${failed} 张图片取文失败（详见正文图片块）`);
  }

  return {
    text: blocks.join('\n'),
    warnings,
    ocrDone,
    skipped,
    engineUnavailable: false,
    visionDone,
    degraded,
  };
}
