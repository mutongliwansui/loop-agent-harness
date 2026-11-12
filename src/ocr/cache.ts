// OCR 结果缓存（需求 20261112-002 / D5）
//
// key = 图片内容哈希 | 引擎 | 语言 | 后处理版本
// 用**内容哈希**而不是 size-mtime：OCR 的输入是字节（文档内图片就是从 zip 解出来的 Buffer），
// 没有可靠文件指纹可用；且同一张图被复制改名后仍能命中。
//
// 与视觉缓存（src/tools/vision/cache.ts）刻意分成两套实例：
// 两条通道的输出格式不同（视觉是模型描述，OCR 是识别文本），混用会互相污染（D2 通道隔离）。

import { createHash } from 'node:crypto';

/** 后处理规则版本：改动 postprocess.ts 的合并规则时递增，自动失效旧缓存 */
export const OCR_CACHE_VERSION = 'v1';

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

  /** 构建 key：引擎/语言任一变化都不复用 */
  buildKey(engine: string, lang: string, image: Buffer): string {
    return createHash('sha1')
      .update([OCR_CACHE_VERSION, engine, lang, OcrResultCache.imageHash(image)].join('|'))
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
