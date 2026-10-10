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
  vision: VisionConfig;
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
  /** 是否记录每次模型调用的输入参数与响应到独立日志文件（~/.loop-agent/logs/llm-*.log） */
  llmLogEnabled: boolean;
  /** Task-20260930-001：是否显示等待 loading 指示器（默认 true；非 TTY 环境始终禁用） */
  loading: boolean;
}

/**
 * 视觉模型配置（Task-20261010-001）
 *
 * 设计要点：
 * - enabled 默认 false：关闭时不注册视觉工具，主模型 tools 列表与现状字节一致（保住前缀缓存）
 * - baseUrl/apiKey/model 为空时回退主模型 model.* 三元组（同一服务商多模型零重复配置）
 */
export interface VisionConfig {
  /** 是否启用视觉工具（关闭时不注册 describe_image/ask_image/extract_json/ocr_image） */
  enabled: boolean;
  /** 视觉服务 baseUrl，空则回退 model.baseUrl */
  baseUrl: string;
  /** 视觉服务 apiKey，空则回退 model.apiKey */
  apiKey: string;
  /** 视觉模型名，空则回退 model.name（主模型需具备视觉能力） */
  model: string;
  /** 采样温度（默认 0，输出稳定） */
  temperature: number;
  /** 单次输出上限（视觉描述可能较长） */
  maxTokens: number;
  /** 单次视觉调用超时毫秒（传入 Tool.timeoutMs） */
  timeoutMs: number;
  /** 图片大小上限（字节） */
  maxImageBytes: number;
  /** 工具结果最大字符数（超出截断，防上下文膨胀） */
  maxResultChars: number;
  /** 是否启用结果缓存（P1 生效） */
  cacheEnabled: boolean;
  /** 缓存 TTL 毫秒（P1 生效） */
  cacheTtlMs: number;
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
  vision?: Partial<VisionConfig>;
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
    llmLogEnabled: true,
    loading: true,
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
  vision: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: 60000,
    maxImageBytes: 10 * 1024 * 1024,
    maxResultChars: 8000,
    cacheEnabled: true,
    cacheTtlMs: 600000,
  },
};
