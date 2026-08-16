// 记忆管理模块类型定义

import type { ChatMessage } from '../types.js';

// ===== L1 Working Memory =====

export interface WorkingMemoryConfig {
  /** 最大 token 数（估算值） */
  maxTokens: number;
  /** 压缩阈值（0.8 = 80% 时触发） */
  compactionThreshold: number;
  /** 压缩后保留最近 N 轮对话（每轮 = user + assistant） */
  keepRecentTurns: number;
}

export const DEFAULT_WORKING_CONFIG: WorkingMemoryConfig = {
  maxTokens: 102400,
  compactionThreshold: 0.8,
  keepRecentTurns: 3,
};

// ===== L2 Episodic Memory =====

export interface MemorySearchResult {
  /** 日期文件名 */
  day: string;
  /** 匹配的段落内容 */
  content: string;
  /** 相关性分数 */
  score: number;
}

// ===== L3 Curated Memory =====

export type CuratedFileKey = 'soul' | 'user' | 'memory';

export interface CuratedFiles {
  soul: string;
  user: string;
  memory: string;
}

// ===== Promotion Gate =====

export type Provenance =
  | 'owner_direct'
  | 'owner_derived'
  | 'tool_output'
  | 'web_search'
  | 'agent_inferred'
  | 'system';

export interface PendingFact {
  fact: string;
  count: number;
  provenance: Provenance;
  firstSeen: string;
  category: 'preference' | 'fact' | 'rule' | 'skill';
  targetFile: 'USER.md' | 'MEMORY.md';
}

// ===== Dreaming =====

export interface DreamingResult {
  promoted: Array<{
    fact: string;
    confidence: number;
    category: string;
    targetFile: string;
    provenance: string;
  }>;
  skipped: Array<{
    fact: string;
    confidence: number;
    category: string;
    targetFile: string;
    provenance: string;
  }>;
  errors: string[];
}

// ===== Memory 配置 =====

/**
 * Phase 5 向量检索配置（可选）
 * 默认禁用：不配置（enabled=false 或 endpoint/model 为空）时完全不影响功能，
 * 检索走现有 BM25 → 文件关键词匹配；配置后 embedding 失败/超时也自动降级。
 */
export interface VectorSearchConfig {
  /** 是否启用向量检索（默认 false） */
  enabled: boolean;
  /** 服务类型：'openai-compatible'（OpenAI 兼容 /v1/embeddings） */
  provider: string;
  /** embedding 模型名（如 bge-large-zh-vllm） */
  model: string;
  /** 向量维度（bge-large-zh 为 1024） */
  dimension: number;
  /** OpenAI 兼容 embeddings 端点完整 URL（如 http://host:port/v1/embeddings） */
  endpoint: string;
  /** API Key（可选，vLLM 等本地服务通常无需） */
  apiKey: string;
  /** 单次 embedding 调用超时（毫秒） */
  timeoutMs: number;
  /** 单批 embedding 文本数 */
  batchSize: number;
}

export const DEFAULT_VECTOR_CONFIG: VectorSearchConfig = {
  enabled: false,
  provider: 'openai-compatible',
  model: '',
  dimension: 1024,
  endpoint: '',
  apiKey: '',
  timeoutMs: 10000,
  batchSize: 16,
};

export interface MemoryConfig {
  enabled: boolean;
  working: WorkingMemoryConfig;
  episodic: {
    dir: string;
    searchTopK: number;
    searchTimeoutMs: number;
    /** Phase 5：向量检索配置（可选，未配置则禁用向量检索） */
    vectorSearch?: VectorSearchConfig;
  };
  curated: {
    files: string[];
    /** 单文件行数上限，append 超限时自动触发 LLM 精简（0 表示不限制） */
    maxLines: number;
    /** LLM 写入前去重/归并（Dreaming 晋升时对候选事实与现有内容做语义合并） */
    dedupe: {
      enabled: boolean;
    };
  };
  dreaming: {
    enabled: boolean;
    daysBack: number;
    onExit: boolean;
    /** Task-16：按天分批提取（默认 true；false 恢复一次性合并所有天） */
    batchByDay: boolean;
    /** Task-16：增量处理，跳过上次已处理的天（默认 true；依赖 .dreaming-state.json） */
    incremental: boolean;
  };
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  working: {
    maxTokens: 102400,
    compactionThreshold: 0.8,
    keepRecentTurns: 3,
  },
  episodic: {
    dir: 'memory',
    searchTopK: 3,
    searchTimeoutMs: 500,
    vectorSearch: DEFAULT_VECTOR_CONFIG,
  },
  curated: {
    files: ['SOUL.md', 'USER.md', 'MEMORY.md'],
    maxLines: 100,
    dedupe: {
      enabled: true,
    },
  },
  dreaming: {
    enabled: true,
    daysBack: 3,
    onExit: true,
    batchByDay: true,
    incremental: true,
  },
};

// 预留给记忆模块使用的 LLM 客户端接口
export interface ILLMClient {
  chat(messages: ChatMessage[], options?: Record<string, unknown>): Promise<{ content: string | null }>;
}