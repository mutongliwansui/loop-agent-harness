// 视觉会话用量累计（Task-20261010-001 P1）：/vision status 展示，进程生命周期内累计
// tokens 来自 chatVision 返回的 usage；缓存命中与失败单独计数，便于观察管道健康度。

/** token 用量（与 OpenAI usage 字段对齐） */
interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** 会话累计快照 */
export interface VisionUsageSnapshot {
  /** 实际发起的视觉 API 调用次数（不含缓存命中） */
  calls: number;
  /** 缓存命中次数 */
  cacheHits: number;
  /** 调用失败次数 */
  errors: number;
  /** 视觉不可用而改走本地 OCR 的降级次数（需求 20261112-002 §4.4） */
  ocrFallbacks: number;
  /** 文档内图片由视觉模型取文的次数（需求 20261112-004 / 任务 02） */
  docImageDescribes: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 累计耗时毫秒（仅实际调用） */
  elapsedMs: number;
}

export class VisionUsageStats {
  private usage: VisionUsageSnapshot = {
    calls: 0,
    cacheHits: 0,
    errors: 0,
    ocrFallbacks: 0,
    docImageDescribes: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    elapsedMs: 0,
  };

  /** 记录一次成功的视觉调用 */
  recordSuccess(usage?: TokenUsage, elapsedMs = 0): void {
    this.usage.calls++;
    this.usage.promptTokens += usage?.prompt_tokens ?? 0;
    this.usage.completionTokens += usage?.completion_tokens ?? 0;
    this.usage.totalTokens += usage?.total_tokens ?? 0;
    this.usage.elapsedMs += elapsedMs;
  }

  /** 记录一次缓存命中 */
  recordCacheHit(): void {
    this.usage.cacheHits++;
  }

  /** 记录一次调用失败 */
  recordError(): void {
    this.usage.errors++;
  }

  /** 记录一次「视觉不可用 → 本地 OCR」降级（需求 20261112-002） */
  recordOcrFallback(): void {
    this.usage.ocrFallbacks++;
  }

  /** 记录一次文档内图片视觉取文（需求 20261112-004：只计成功实调，缓存命中不计） */
  recordDocImageDescribe(): void {
    this.usage.docImageDescribes++;
  }

  /** 当前累计快照 */
  snapshot(): VisionUsageSnapshot {
    return { ...this.usage };
  }

  /** 清零（/reset 语义对齐时可用） */
  reset(): void {
    this.usage = {
      calls: 0,
      cacheHits: 0,
      errors: 0,
      ocrFallbacks: 0,
      docImageDescribes: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      elapsedMs: 0,
    };
  }
}

/** 全局视觉用量统计实例 */
export const visionStats = new VisionUsageStats();
