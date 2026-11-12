// 文档内图片收集与 OCR 块拼装（需求 20261112-002 / 任务 04）
//
// 职责边界：
// - 本文件只做「从 OOXML 压缩包收集图片」+「按三重预算做 OCR 并拼成文本块」；
// - 不触碰行号/截断/落盘——块文本追加到提取文本尾部后，由工具层既有管线统一处理；
// - 引擎不可用（非 Windows / 缺语言包 / ocr.enabled=false）时整块降级为空串，
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
