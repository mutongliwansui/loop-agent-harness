// 配置 Schema 定义与类型
import type { MCPServerConfig } from '../tools/mcp/client.js';
import type { SessionConfig } from '../session/types.js';
import type { SkillConfig } from '../skill/types.js';
import type { MemoryConfig } from '../memory/types.js';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Agent 完整配置结构 */
export interface AgentConfig {
  model: ModelConfig;
  tools: ToolsConfig;
  agent: AgentBehaviorConfig;
  session: SessionConfig;
  skill: SkillConfig;
  memory: MemoryConfig;
}

export interface ModelConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxIterations: number;
}

export interface ToolsConfig {
  enabled: string[];
  disabled: string[];
  mcpServers: Record<string, MCPServerConfig>;
}

export interface AgentBehaviorConfig {
  verbose: boolean;
  debug: boolean;
  systemPrompt: string | null;
  /** Task-15：是否打印每轮 token/缓存/上下文统计（默认 true，独立于 verbose） */
  showTokenStats: boolean;
}

/** 配置来源标记 */
export type ConfigSource = 'cli' | 'workspace' | 'global' | 'env' | 'default';

/** 合并后的配置结果 */
export interface ResolvedConfig {
  config: AgentConfig;
  sources: Record<string, ConfigSource>;
}

/** 部分配置（用于 CLI override、部分写入等） */
export type PartialAgentConfig = {
  model?: Partial<ModelConfig>;
  tools?: Partial<ToolsConfig>;
  agent?: Partial<AgentBehaviorConfig>;
  session?: Partial<SessionConfig>;
  skill?: Partial<SkillConfig>;
  memory?: Partial<MemoryConfig>;
};

/** 默认配置值 */
export const DEFAULT_CONFIG: AgentConfig = {
  model: {
    name: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    temperature: 0,
    maxIterations: 10,
  },
  tools: {
    enabled: [],
    disabled: [],
    mcpServers: {},
  },
  agent: {
    verbose: true,
    debug: false,
    systemPrompt: null,
    showTokenStats: true,
  },
  session: {
    autoSave: true,
    autoRestore: true,
    encryptionEnabled: true,
  },
  skill: {
    enabled: true,
    globalDir: join(homedir(), '.loop-agent', 'skills'),
    workspaceDir: '.loop-agent/skills',
    autoLoad: true,
  },
  memory: {
    ...DEFAULT_MEMORY_CONFIG,
  },
};
