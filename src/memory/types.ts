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
  maxTokens: 8000,
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

export interface MemoryConfig {
  enabled: boolean;
  working: WorkingMemoryConfig;
  episodic: {
    dir: string;
    searchTopK: number;
    searchTimeoutMs: number;
  };
  curated: {
    files: string[];
  };
  dreaming: {
    enabled: boolean;
    daysBack: number;
    onExit: boolean;
  };
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  working: {
    maxTokens: 8000,
    compactionThreshold: 0.8,
    keepRecentTurns: 3,
  },
  episodic: {
    dir: 'memory',
    searchTopK: 3,
    searchTimeoutMs: 500,
  },
  curated: {
    files: ['SOUL.md', 'USER.md', 'MEMORY.md'],
  },
  dreaming: {
    enabled: true,
    daysBack: 3,
    onExit: true,
  },
};

// 预留给记忆模块使用的 LLM 客户端接口
export interface ILLMClient {
  chat(messages: ChatMessage[], options?: Record<string, unknown>): Promise<{ content: string | null }>;
}