// Phase 5：Embedding 客户端（OpenAI 兼容 /v1/embeddings）
//
// 设计原则：
// - 运行时检测：构造时不做任何网络调用，isConfigured() 判断是否具备调用条件
// - 可选即降级：未配置 / 调用失败 / 超时 → 抛错，由上层降级为 BM25/文件检索
// - 配置动态读取：由调用方在运行时传入 VectorSearchConfig
import type { VectorSearchConfig } from './types.js';

export class EmbeddingClient {
  private config: VectorSearchConfig;

  constructor(config: VectorSearchConfig) {
    this.config = config;
  }

  /** 是否具备调用条件（enabled 且 endpoint/model 非空） */
  isConfigured(): boolean {
    return this.config.enabled && !!this.config.endpoint && !!this.config.model;
  }

  /** 批量文本向量化，返回与输入一一对应的向量数组 */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.isConfigured()) throw new Error('embedding 未配置（enabled/endpoint/model）');
    if (texts.length === 0) return [];

    const batchSize = this.config.batchSize || 16;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vecs = await this.embedBatch(batch);
      for (const v of vecs) {
        if (v.length !== this.config.dimension) {
          throw new Error(`embedding 维度不匹配：期望 ${this.config.dimension}，实际 ${v.length}`);
        }
      }
      results.push(...vecs);
    }
    return results;
  }

  /** 单次 HTTP 调用（带超时） */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

      const resp = await fetch(this.config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`embedding HTTP ${resp.status} ${resp.statusText}`);
      const json = (await resp.json()) as {
        data?: Array<{ embedding: number[]; index: number }>;
      };
      const data = (json.data ?? []).sort((a, b) => a.index - b.index);
      if (data.length !== texts.length) {
        throw new Error(`embedding 返回条数不匹配：期望 ${texts.length}，实际 ${data.length}`);
      }
      return data.map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }
}
