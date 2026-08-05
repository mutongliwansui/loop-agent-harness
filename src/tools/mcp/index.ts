// MCP 模块聚合入口
// Note: loader.ts 在 Task-10 中移除，MCP 配置统一通过 MCPManager 管理
export { MCPClient } from './client.js';
export type { MCPServerConfig, StdioConfig, SSEConfig } from './client.js';
export { adaptMCPTool, buildToolName } from './adapter.js';
