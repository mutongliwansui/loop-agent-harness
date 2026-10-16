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
  models: ModelsConfig;
  tools: ToolsConfig;
  agent: AgentBehaviorConfig;
  session: SessionConfig;
  skill: SkillConfig;
  memory: MemoryConfig;
  vision: VisionConfig;
  api: ApiConfig;
}

export interface ModelConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxIterations: number;
}

/**
 * 单个已接入模型的登记信息（Task-20261011-002 多模型接入与切换）
 */
export interface ModelProfile {
  /** 模型名（如 deepseek-chat） */
  name: string;
  /** 服务地址（OpenAI 兼容协议） */
  baseUrl: string;
  /** API Key（展示时遮蔽，仅尾 4 位） */
  apiKey: string;
  /** 采样温度（可选；未设置时切换不覆盖 model.temperature 现值） */
  temperature?: number;
}

/**
 * 多模型接入配置（Task-20261011-002）
 *
 * 设计要点：
 * - profiles 用 Record（别名 → 配置）而非数组：deepMerge 对对象递归合并，
 *   global 与 workspace 的登记簿可跨层叠加；数组会被整体替换互相覆盖
 * - model.* 是"当前生效"快照（运行时唯一读取点），models 是"登记簿 + 激活指针"，
 *   /model use 切换时同步写两者
 * - active 为空串 = 未纳入多模型管理（兼容存量单模型配置用户）
 */
export interface ModelsConfig {
  /** 当前激活的 profile 别名；空串 = 未纳入多模型管理 */
  active: string;
  /** 模型登记簿：别名 → 三元组 */
  profiles: Record<string, ModelProfile>;
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

/**
 * HTTP API 服务配置（Task-20261016-001 自定义 REST API 服务）
 *
 * 设计要点：
 * - 仅在 `--serve` 启动模式下生效（REPL 模式完全忽略本段）
 * - host 绑定非回环地址且 token 为空时拒绝启动（防裸奔暴露局域网，D6）
 * - token 为空时仅接受本机请求；非空时所有请求强制 Bearer 校验
 */
export interface ApiConfig {
  /** 监听端口 */
  port: number;
  /** 监听地址；非回环地址必须配置 token */
  host: string;
  /** Bearer Token；为空时仅接受本机请求（展示时遮蔽，仅尾 4 位） */
  token: string;
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
  models?: Partial<ModelsConfig>;
  tools?: Partial<ToolsConfig>;
  agent?: Partial<AgentBehaviorConfig>;
  session?: Partial<SessionConfig>;
  skill?: Partial<SkillConfig>;
  memory?: Partial<MemoryConfig>;
  vision?: Partial<VisionConfig>;
  api?: Partial<ApiConfig>;
};

/**
 * 漂移检测（Task-20261011-002 D4）：激活 profile 与生效快照的结构字段不一致时返回提示。
 * 只比 name+baseUrl（apiKey 轮换属正常维护，不算漂移）；
 * 放在 schema 层供 /model 命令与 Banner 渲染共用（纯函数、无依赖）
 */
export function detectDrift(cfg: AgentConfig): string | null {
  const alias = cfg.models.active;
  if (!alias) return null;
  const p = cfg.models.profiles[alias];
  if (!p) return `激活项「${alias}」在登记簿中不存在（可能被手动删除）`;
  if (p.name !== cfg.model.name || p.baseUrl !== cfg.model.baseUrl) {
    return `当前生效快照（${cfg.model.name} @ ${cfg.model.baseUrl}）与激活 profile「${alias}」不一致，可执行 /model use ${alias} 重新同步`;
  }
  return null;
}

/** 默认配置值 */
export const DEFAULT_CONFIG: AgentConfig = {
  model: {
    name: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    temperature: 0,
    maxIterations: 10,
  },
  models: {
    active: '',
    profiles: {},
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
  api: {
    port: 3000,
    host: '127.0.0.1',
    token: '',
  },
};
