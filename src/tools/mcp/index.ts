// MCP 模块聚合入口
export { MCPClient } from './client.js';
export type { MCPServerConfig, StdioConfig, SSEConfig } from './client.js';
export { adaptMCPTool, buildToolName } from './adapter.js';
export { loadMCPConfig, registerAllMCPServers } from './loader.js';
