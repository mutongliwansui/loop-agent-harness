// 记忆管理模块聚合入口（Phase 1 最小闭环）
export { WorkingMemory } from './working.js';
export { EpisodicMemory } from './episodic.js';
export { CuratedMemory } from './curated.js';
export { ContextAssembler } from './context.js';
export { ToolMemoryCallback } from './callback.js';
export type {
  WorkingMemoryConfig,
  DEFAULT_WORKING_CONFIG,
  MemorySearchResult,
  CuratedFileKey,
  CuratedFiles,
  Provenance,
  PendingFact,
  DreamingResult,
  MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
  ILLMClient,
} from './types.js';

// Phase 4 将实现:
// export { PromotionGate } from './gate.js';
// export { DreamingPipeline } from './dreaming.js';