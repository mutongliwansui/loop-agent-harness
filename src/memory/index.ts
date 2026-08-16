// 记忆管理模块聚合入口（Phase 1-5 已实现）
export { WorkingMemory } from './working.js';
export { EpisodicMemory } from './episodic.js';
export { CuratedMemory } from './curated.js';
export { ContextAssembler, repairMessageSequence } from './context.js';
export { ToolMemoryCallback } from './callback.js';
export { PromotionGate } from './gate.js';
export { DreamingPipeline } from './dreaming.js';
export { MemoryIndex, tokenizeForFts, tokenizeQuery } from './fts.js';
export { EmbeddingClient } from './embedding.js';
export { VectorMemory, cosine } from './vector.js';
export { rrfMerge } from './hybrid.js';
export type { IndexedEntry } from './fts.js';
export type { VectorEntry } from './vector.js';
export type {
  WorkingMemoryConfig,
  MemorySearchResult,
  CuratedFileKey,
  CuratedFiles,
  Provenance,
  PendingFact,
  DreamingResult,
  MemoryConfig,
  VectorSearchConfig,
  ILLMClient,
} from './types.js';
export {
  DEFAULT_WORKING_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_VECTOR_CONFIG,
} from './types.js';
