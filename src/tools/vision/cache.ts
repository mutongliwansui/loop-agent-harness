// 视觉结果缓存（Task-20261010-001 P1）：LRU 上限 20 条 + TTL
// 目标：同一张图多轮追问（describe → ask → ask）不重复计费；
// 本地文件用 mtime+size 指纹做 key，文件内容变了缓存自动失效。
import { createHash } from 'node:crypto';

/** LRU 最大条目数 */
const MAX_ENTRIES = 20;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * 视觉结果缓存
 * key = sha1(channel | model | kind | 归一化参数 | 图片uri或fileFingerprint)
 *
 * 需求 20261112-002 §4.4：cache key 带 `channel`（'vision' | 'ocr'），
 * 防止视觉结果与本地 OCR 降级结果在同一张图上互相命中。
 */
export class VisionResultCache {
  private entries = new Map<string, CacheEntry>();

  /**
   * 构建缓存 key（归一化：参数按位置拼接，调用方保证同类工具参数顺序稳定）
   * @param model 视觉模型名（换模型即换 key）；OCR 通道传引擎 id
   * @param kind 工具种类（describe/ask/extract/ocr）
   * @param params 归一化参数片段（ask 为 [question]，extract 为 fields 逐项，describe/ocr 为空）
   * @param imageIdentity 图片标识：本地文件用 fileFingerprint(size-mtime)，URL/data 用 uri 本身
   * @param channel 结果来源通道，默认 'vision'（保持既有调用点行为不变）
   */
  buildKey(
    model: string,
    kind: string,
    params: string[],
    imageIdentity: string,
    channel: 'vision' | 'ocr' = 'vision',
  ): string {
    return createHash('sha1')
      .update([channel, model, kind, ...params, imageIdentity].join('|'))
      .digest('hex');
  }

  /** 查缓存：命中返回结果，未命中或已过期返回 null */
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

  /** 写缓存：超限淘汰最旧（队首），TTL 由调用方按当前配置传入 */
  set(key: string, value: string, ttlMs: number): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** 当前缓存条数（/vision status 展示） */
  size(): number {
    return this.entries.size;
  }

  /** 清空缓存（不清统计） */
  clear(): void {
    this.entries.clear();
  }
}

/** 全局视觉缓存实例 */
export const visionCache = new VisionResultCache();
