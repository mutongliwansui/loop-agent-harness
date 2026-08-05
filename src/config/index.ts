// 配置系统入口：统一导出
export { configLoader, ConfigLoader } from './loader.js';
export {
  configWriter,
  ConfigWriter,
  type ConfigScope,
} from './writer.js';
export { deepMerge } from './merge.js';
export {
  DEFAULT_CONFIG,
  type AgentConfig,
  type ModelConfig,
  type ToolsConfig,
  type AgentBehaviorConfig,
  type ConfigSource,
  type ResolvedConfig,
  type PartialAgentConfig,
} from './schema.js';
export {
  mcpManager,
  getMCPManager,
  MCPManager,
  type LoadResult,
} from './mcp-manager.js';
