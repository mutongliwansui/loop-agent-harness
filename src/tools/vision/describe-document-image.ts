// 文档内图片的视觉取文适配器（需求 20261112-004 / 任务 02 / D2）
//
// 角色：把 documents 层的 `DocumentImage`（原始字节，无路径）适配成一次视觉调用，
// 并把「视觉优先 → OCR 兜底」的顺序决策留在 documents 层（`readDocumentImages()`）。
// 本文件只负责「怎么调视觉」，不负责降级——降级由调用方依据抛错来做。
//
// 四个硬约束：
//   1. `vision.enabled !== true` 时返回 undefined（调用方据此走纯 OCR，行为等同旧版）；
//   2. 图片超过 `vision.maxImageBytes` 直接抛错，不浪费一次请求（上层会降级 OCR）；
//   3. 缓存走 visionCache 的 'vision' 通道 + 独立 kind 'describe_doc_image'，
//      与 analyzeImage 的 describe、与本地 OCR 的 'ocr' 通道都互不命中；
//   4. 单图超时不超过调用方给的剩余总预算，超时按抛错处理（上层降级）。
import { createHash } from 'node:crypto';
import type { ModelConfig, VisionConfig } from '../../config/schema.js';
import type { ImageDescriber } from '../../documents/images.js';
import type { DocumentImage } from '../../documents/types.js';
import { llm } from '../../llm/client.js';
import type { VisionContentPart, VisionMessage } from '../../types.js';
import { debug } from '../../debug.js';
import { sniffImageFormat } from '../../ocr/index.js';
import { visionCache } from './cache.js';
import { visionStats } from './stats.js';
import { resolveVisionTargets } from './tools.js';

/** 缓存 kind（与 analyzeImage 的 describe 区分，避免同图串味） */
const CACHE_KIND = 'describe_doc_image';

/**
 * 文档图片取文的固定提示词：要正文、要结构、不许臆测。
 * 与 analyzeImage 的 describe（「客观详尽描述」）不同，这里目标是**取文 + 结构还原**。
 */
const DOC_IMAGE_PROMPT = [
  '请读取这张文档图片，按人类阅读顺序输出其中的全部文字内容（保留段落与分行的自然顺序）。',
  '若图中存在表格，请用 markdown 表格还原行列；若存在印章、手写签名、勾选项、页码或页眉页脚，请单独用一行说明它们的位置与内容。',
  '看不清或无法确认的内容写「（不清晰）」，不要猜测或补全。',
  '只输出图片内容本身，不要额外解释。',
].join('\n');

const VISION_SYSTEM_PROMPT = '你是一个专业的文档图像转写助手。只输出被要求的内容，不要输出多余解释。';

/** 构建依赖（由 fileRead 传入；解析后的视觉三元组与配置） */
export interface DocumentImageDescriberOptions {
  vision: VisionConfig;
  model: ModelConfig;
}

/** 图片 MIME（未知格式按 PNG 处理：OCR 侧收图也是这条口径） */
function mimeOf(img: DocumentImage): string {
  const fmt = sniffImageFormat(img.data);
  switch (fmt) {
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/** 文档图片没有路径，用内容哈希做缓存标识（同图不同文档也能命中） */
function contentIdentity(img: DocumentImage): string {
  return `docimg:${createHash('sha256').update(img.data).digest('hex').slice(0, 32)}`;
}

/** 给 Promise 套一层超时（视觉客户端本身不接受 signal/timeout 选项） */
function withTimeout<T>(p: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 构建文档图片视觉取文器。
 * `vision.enabled !== true` 时返回 undefined —— 调用方（fileRead）据此保持纯 OCR 行为。
 */
export function buildDocumentImageDescriber(
  opts: DocumentImageDescriberOptions,
): ImageDescriber | undefined {
  const vision = opts.vision;
  if (vision.enabled !== true) return undefined;
  const targets = resolveVisionTargets(vision, opts.model);

  return async (img: DocumentImage, timeoutMs: number): Promise<{ text: string; model: string }> => {
    // 大小门禁：超上限直接抛错（不浪费一次请求），由上层降级 OCR
    if (vision.maxImageBytes > 0 && img.data.length > vision.maxImageBytes) {
      throw new Error(
        `图片 ${(img.data.length / 1024 / 1024).toFixed(1)}MB 超过视觉大小上限 ${(
          vision.maxImageBytes / 1024 / 1024
        ).toFixed(1)}MB（可调 vision.maxImageBytes）`,
      );
    }

    const dataUri = `data:${mimeOf(img)};base64,${img.data.toString('base64')}`;
    const cacheKey = visionCache.buildKey(
      targets.model,
      CACHE_KIND,
      [],
      contentIdentity(img),
      'vision',
    );
    if (vision.cacheEnabled) {
      const hit = visionCache.get(cacheKey);
      if (hit !== null) {
        debug.log('[vision] 文档图片缓存命中');
        visionStats.recordCacheHit();
        return { text: hit, model: targets.model };
      }
    }

    const parts: VisionContentPart[] = [
      { type: 'text', text: DOC_IMAGE_PROMPT },
      { type: 'image_url', image_url: { url: dataUri } },
    ];
    const messages: VisionMessage[] = [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: parts },
    ];

    const limit = vision.timeoutMs > 0 ? Math.min(vision.timeoutMs, timeoutMs) : timeoutMs;
    let content: string;
    try {
      const result = await withTimeout(
        llm.chatVision(messages, {
          ...targets,
          temperature: vision.temperature,
          maxTokens: vision.maxTokens,
        }),
        limit,
        () => new Error(`视觉调用超时（${Math.round(limit / 1000)}s）`),
      );
      visionStats.recordSuccess(result.usage, result.elapsedMs);
      content = result.content;
    } catch (err) {
      visionStats.recordError();
      throw err;
    }

    visionStats.recordDocImageDescribe();
    if (vision.cacheEnabled) visionCache.set(cacheKey, content, vision.cacheTtlMs);
    return { text: content, model: targets.model };
  };
}
