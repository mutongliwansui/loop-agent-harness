// OCR 结果缓存（需求 20261112-002 / D5，20261112-003 / D9 升级）
//
// key = 后处理版本 | 引擎 | 语言 | 预处理（scale/crop）| 图片内容哈希
// 用**内容哈希**而不是 size-mtime：OCR 的输入是字节（文档内图片就是从 zip 解出来的 Buffer），
// 没有可靠文件指纹可用；且同一张图被复制改名后仍能命中。
//
// 缓存值是**引擎原始快照**（JSON 字符串：text + lines + imageSize），不是最终渲染文本：
// 这样同一张图在不同 layout 之间切换可复用同一份缓存，不必重跑 1s+ 的 OCR（D9）。
// scale/crop 会改变识别结果，必须进 key，否则放大前后会串味。
//
// 与视觉缓存（src/tools/vision/cache.ts）刻意分成两套实例：
// 两条通道的输出格式不同（视觉是模型描述，OCR 是识别文本），混用会互相污染（D2 通道隔离）。

import { createHash } from 'node:crypto';

/**
 * 缓存结构版本：改动 postprocess.ts 的合并规则、layout 渲染语义或快照结构时**必须**递增，
 * 否则会读到旧规则的结果（它是手工常量，没有自动探测）。
 */
export const OCR_CACHE_VERSION = 'v2';

/** 预处理参数（参与 key，避免放大/裁剪前后串味） */
export interface OcrCachePrep {
  scale?: number;
  /** 已规整的 `x,y,w,h` 串，空串表示整图 */
  crop?: string;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/** OCR 结果缓存（LRU + TTL） */
export class OcrResultCache {
  private entries = new Map<string, CacheEntry>();

  /** 图片字节的稳定哈希（sha1，取前 16 字节 hex 足够区分） */
  static imageHash(image: Buffer): string {
    return createHash('sha1').update(image).digest('hex').slice(0, 32);
  }

  /** 构建 key：引擎/语言/预处理任一变化都不复用 */
  buildKey(engine: string, lang: string, image: Buffer, prep: OcrCachePrep = {}): string {
    const scale = prep.scale ?? 1;
    const crop = prep.crop ?? '';
    return createHash('sha1')
      .update([OCR_CACHE_VERSION, engine, lang, `s${scale}`, `c${crop}`, OcrResultCache.imageHash(image)].join('|'))
      .digest('hex');
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    // LRU：命中后移到队尾（Map 迭代序 = 插入序）
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number, maxEntries = 64): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= Math.max(1, maxEntries)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 全局 OCR 缓存实例（进程生命周期） */
export const ocrCache = new OcrResultCache();
