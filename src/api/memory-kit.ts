// 记忆子系统组装工厂（Task-20261016-002 §3.7）
//
// API 无共享 agent（001 D5）→ /memory 组端点不能复用 agent 内的记忆实例，
// 需独立组装一套与 ReactAgent.initMemory 同口径的记忆子系统。
// 与 initMemory 的唯一差异：不含旧版 {cwd}/memory 目录迁移——启动期一次性逻辑归 agent 所有。
// D8：opts 支持注入目录（单测隔离，避免污染真实 ~/.loop-agent）。

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ConfigLoader } from '../config/loader.js';
import { configLoader } from '../config/loader.js';
import { createLLMAdapter } from '../agent/react-agent.js';
import { dedupeCuratedFile } from '../memory/curated-dedupe.js';
import { CuratedMemory, DreamingPipeline, EpisodicMemory, PromotionGate } from '../memory/index.js';
import type { ILLMClient } from '../memory/index.js';
import type { ChatMessage } from '../types.js';
import { workspaceId } from '../session/store.js';

/** /memory 端点所需的记忆子系统集合（与 ReactAgent 私有字段同口径） */
export interface MemoryKit {
  episodic: EpisodicMemory;
  curated: CuratedMemory;
  gate: PromotionGate;
  dream: DreamingPipeline;
}

/** 目录注入项（缺省用真实用户目录；单测传临时目录隔离） */
export interface MemoryKitOptions {
  /** 覆盖 L2 episodic 根目录（默认 ~/.loop-agent/memory；memory.episodic.dir 绝对路径配置仍优先） */
  memoryRoot?: string;
  /** 覆盖全局 Curated 目录（默认 ~/.loop-agent/curated） */
  globalCuratedDir?: string;
}

/**
 * 组装记忆子系统（与 ReactAgent.initMemory 完全同口径）。
 * 工厂内已完成各层 init/loadState，返回即可用。
 */
export async function createMemoryKit(
  cwd: string,
  loader: ConfigLoader,
  opts: MemoryKitOptions = {},
): Promise<MemoryKit> {
  const { config: cfg } = loader.load();

  // L2 目录：显式绝对路径配置 → 尊重配置；默认相对路径 → {memoryRoot}/{workspaceId}
  const baseDir = opts.memoryRoot ?? join(homedir(), '.loop-agent', 'memory');
  const configEpisodicDir = cfg.memory.episodic.dir;
  const episodicDir = configEpisodicDir && isAbsolute(configEpisodicDir)
    ? configEpisodicDir
    : join(baseDir, workspaceId(cwd));

  // 全局 Curated 目录：SOUL/USER 存用户目录，MEMORY.md 留项目目录
  const globalCuratedDir = opts.globalCuratedDir ?? join(homedir(), '.loop-agent', 'curated');

  const episodic = new EpisodicMemory(episodicDir, cfg.memory.episodic.vectorSearch);
  await episodic.init();

  // L3 Curated（行数超限时自动 LLM 精简；压缩回调每次重读配置）
  const curated = new CuratedMemory(
    cwd,
    {
      maxLines: cfg.memory.curated.maxLines,
      compress: async (content, key) => {
        void key;
        const { config: curCfg } = loader.load();
        if (!curCfg.memory.curated.dedupe.enabled) return null;
        const adapter = createLLMAdapter(curCfg.model.name, curCfg.model.temperature);
        return dedupeCuratedFile(adapter, content);
      },
    },
    globalCuratedDir,
  );
  await curated.init();

  // Promotion Gate（恢复持久化状态）
  const gate = new PromotionGate();
  await gate.loadState(cwd);

  // 动态 adapter：每次调用重读配置（/model use 切换主模型后 Dreaming 跟随新模型）
  const llmAdapter: ILLMClient = {
    async chat(messages: ChatMessage[]) {
      const { config: curCfg } = loader.load();
      return createLLMAdapter(curCfg.model.name, curCfg.model.temperature).chat(messages);
    },
  };
  const dream = new DreamingPipeline(episodic, gate, curated, llmAdapter);

  return { episodic, curated, gate, dream };
}

let cachedKit: Promise<MemoryKit> | null = null;

/** 默认工厂：真实单例组装（进程内 memoized——记忆目录与状态文件只需初始化一次） */
export function defaultMemoryKitFactory(): Promise<MemoryKit> {
  cachedKit ??= createMemoryKit(process.cwd(), configLoader);
  return cachedKit;
}
