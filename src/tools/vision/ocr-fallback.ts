// analyzeImage 视觉失败 → 本地 OCR 降级（需求 20261112-002 / 任务 03 / D2）
//
// 判定顺序（设计 §4.4）：
//   vision.enabled=false  → 若 ocr.enabled 可用 → runOcr（标注降级）
//   chatVision 抛错        → 记录错误摘要 → 若 ocr.fallbackFromVision → runOcr（标注降级 + 错误摘要）
//   OCR 也失败             → 抛原始视觉错误 + OCR 失败原因（两条信息都保留）
//
// 三条硬约束：
//   1. `extract` 分支不降级——OCR 产不出结构化字段，降级会给出误导性的「非法 JSON」；
//      改为明确提示「改用 ocrImage 取文字后自行解析」。
//   2. 降级结果必须显式标注来源与能力边界，绝不静默降级（否则用户会误以为是视觉判断）。
//   3. 降级结果走 visionCache 的 `ocr` 通道，与视觉结果互不命中（D2 缓存隔离）。
import type { OcrConfig } from '../../config/schema.js';
import { buildOcrResultText, runOcrOnSource } from '../../ocr/index.js';
import { visionCache } from './cache.js';
import { visionStats } from './stats.js';

/** 视觉分支种类（与 tools.ts 的 VisionKind 一致，此处只关心是否为 extract） */
export type FallbackKind = 'describe' | 'ask' | 'extract';

/** 降级尝试的结果：三种状态由调用方决定是返回文本还是抛错 */
export type OcrFallbackOutcome =
  | { status: 'ok'; text: string }
  | { status: 'failed'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface OcrFallbackInput {
  /** 视觉分支种类 */
  kind: FallbackKind;
  /** 图片原始来源（路径 / dataURI / file:// / http(s)） */
  imageSource: string;
  /** 视觉不可用的原因摘要（会写进结果标注，供模型与用户判断可信度） */
  reason: string;
  /** OCR 配置；未传入视为未启用 */
  ocr?: OcrConfig;
  /** 归一化参数片段（ask 为 [question]，其余为空），参与缓存 key */
  params?: string[];
}

/**
 * 降级结果的固定尾部说明：点明 OCR 能力边界，防过度解读。
 * 需求 20261112-004：文档图片取文（documents 层）持有一份同文案常量，
 * 单测断言二者一致；改动时两处必须同步。
 */
export const CAPABILITY_NOTE =
  '说明：本地 OCR 只提供图片中的文字，无法回答颜色、布局、图标、数量等视觉类问题。';

/**
 * 压缩视觉异常为一句话摘要：取首个非空行并截断。
 * 目的是让结果标注里能看出「视觉为什么失败」，而不是只写「失败」。
 */
export function summarizeVisionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const firstLine = raw.split(/[\r\n]+/).map((s) => s.trim()).find((s) => s !== '') ?? '';
  const s = firstLine || '未知错误';
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 降级结果的最终文本形态（§4.6）：降级标注头 + 标准 OCR 标注 + 能力边界说明 */
function buildFallbackText(input: OcrFallbackInput, engine: string, ocrText: string): string {
  return [
    `[视觉不可用：${input.reason}；已降级为本地 OCR（${engine}）]`,
    ocrText,
    '',
    CAPABILITY_NOTE,
  ].join('\n');
}

/**
 * 尝试走本地 OCR。永不抛错：失败信息以 `status` 返回，由调用方与原始视觉错误一起呈现。
 */
export async function runOcrFallback(input: OcrFallbackInput): Promise<OcrFallbackOutcome> {
  if (input.kind === 'extract') {
    return {
      status: 'unavailable',
      reason: 'extract 分支不降级到 OCR（OCR 无法产出结构化字段），可改用 ocrImage 取文字后自行解析',
    };
  }
  const ocr = input.ocr;
  if (!ocr || ocr.enabled !== true) {
    return { status: 'unavailable', reason: '本地 OCR 未启用（ocr.enabled=false）' };
  }

  // 通道隔离的错误分片：固定 modelKey='local-ocr'——OCR 结果与视觉模型无关，
  // 换视觉模型不应导致 OCR 缓存失效。
  const cacheKey = visionCache.buildKey(
    'local-ocr',
    input.kind,
    input.params ?? [],
    input.imageSource,
    'ocr',
  );
  if (ocr.cacheEnabled) {
    const hit = visionCache.get(cacheKey);
    if (hit !== null) {
      visionStats.recordOcrFallback();
      return { status: 'ok', text: hit };
    }
  }

  try {
    const result = await runOcrOnSource(input.imageSource, { config: ocr });
    const text = buildFallbackText(input, result.engine, buildOcrResultText(result));
    if (ocr.cacheEnabled) visionCache.set(cacheKey, text, ocr.cacheTtlMs);
    visionStats.recordOcrFallback();
    return { status: 'ok', text };
  } catch (err) {
    return { status: 'failed', reason: summarizeVisionError(err) };
  }
}

/**
 * 组装「视觉不可用 + OCR 也不可用」时的最终错误文案。
 * 原则：原始视觉错误放首位（那是根因），OCR 侧信息作为补充，两条都不能丢。
 */
export function composeFallbackError(
  visionErr: unknown,
  outcome: OcrFallbackOutcome,
  opts: { visionDisabled?: boolean } = {},
): string {
  const base = opts.visionDisabled
    ? '视觉功能未启用，请先 /config set vision.enabled true 并配置 vision.model'
    : (visionErr instanceof Error ? visionErr.message : String(visionErr));
  if (outcome.status === 'ok') return base; // 调用方不应走到这里
  const tail =
    outcome.status === 'failed'
      ? `本地 OCR 降级也失败：${outcome.reason}`
      : outcome.reason;
  return `${base}\n（${tail}）`;
}
