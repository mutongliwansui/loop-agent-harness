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
  /**
   * Task-17：压缩提取（pre-compaction flush）失败时的兜底策略
   * 'skip'    （默认）跳过压缩，保留全部历史（宁可超上下文不丢信息）
   * 'archive' 把原始对话降级写入 L2（tag=compaction_fallback）后仍压缩
   */
  flushFailure: 'skip' | 'archive';
}

export const DEFAULT_WORKING_CONFIG: WorkingMemoryConfig = {
  maxTokens: 102400,
  compactionThreshold: 0.8,
  keepRecentTurns: 3,
  flushFailure: 'skip',
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
    /** Task-19：BM25/匹配分数最低阈值，低于此值的结果不注入上下文（0=禁用过滤） */
    searchMinScore: number;
    /** Task-19：查询增强轮数，拼接最近 N 轮对话作为搜索词（0=禁用，仅用当前消息） */
    queryEnhanceRounds: number;
    /** Task-19：短查询最小长度，低于此长度跳过 L2 检索 */
    shortQueryMinLength: number;
    /** Task-19：自定义停用词，追加到内置列表 */
    stopwords: string[];
    /** Task-19 方案 3：时间衰减半衰期（天，0=禁用），每经过 N 天分数减半，默认 7 */
    recencyHalfLifeDays: number;
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
    /**
     * 进程关停时是否执行 Dreaming（默认 true）。
     * 语义演进（Task-20261026-002 D10）：原名「CLI 退出时晋升」，现扩展为
     * 「任何宿主进程关停时晋升」——CLI 的 readline close 与 serve 的 SIGINT/SIGTERM/SIGBREAK 共用此开关。
     */
    onExit: boolean;
    /** Task-16：按天分批提取（默认 true；false 恢复一次性合并所有天） */
    batchByDay: boolean;
    /** Task-16：增量处理，跳过上次已处理的天（默认 true；依赖 .dreaming-state.json） */
    incremental: boolean;
    /** Task-20261026-002 D2/D10：serve 模式定时自动晋升（CLI 不参与） */
    schedule: {
      /** 是否启用定时轮（默认 true）；关停兜底由顶层 onExit 独立控制 */
      enabled: boolean;
      /** 定时轮间隔小时数（默认 24；当天内容本就留到次日整理，更短间隔只会空跑） */
      intervalHours: number;
      /** 启动后延迟多少分钟开始首轮（默认 5，避开启动期初始化与首个对话） */
      startupDelayMin: number;
    };
    /** Task-20261026-002 D4：关停兜底的总时间预算（毫秒，默认 30000；超时后打印警告并继续关停） */
    shutdownBudgetMs: number;
    /**
     * Task-20261026-002 D3：读取窗口放大上限（天，默认 30）。
     * 触发时按「距上次处理的天数 +1」放大 daysBack，避免停机多日后中间的天永久读不到；
     * 上限用于防止一次性灌爆上下文。
     */
    maxDaysBack: number;
  };
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  working: {
    maxTokens: 102400,
    compactionThreshold: 0.8,
    keepRecentTurns: 3,
    flushFailure: 'skip',
  },
  episodic: {
    dir: 'memory',
    searchTopK: 3,
    searchTimeoutMs: 500,
    searchMinScore: 0.3,
    queryEnhanceRounds: 3,
    shortQueryMinLength: 4,
    stopwords: [],
    recencyHalfLifeDays: 7,
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
    schedule: {
      enabled: true,
      intervalHours: 24,
      startupDelayMin: 5,
    },
    shutdownBudgetMs: 30000,
    maxDaysBack: 30,
  },
};

// 预留给记忆模块使用的 LLM 客户端接口
export interface ILLMClient {
  chat(messages: ChatMessage[], options?: Record<string, unknown>): Promise<{ content: string | null }>;
  /**
   * 流式调用并聚合完整内容（可选）。压缩提取等场景优先使用：
   * 长非流式连接在部分后端/代理下易被中途截断，流式逐 chunk 累积更健壮。
   * 未实现时调用方回退 chat()。
   */
  chatViaStream?(messages: ChatMessage[]): Promise<{ content: string | null }>;
}