// 工具系统聚合入口：统一导出 Registry、Runner、内置工具与 MCP 接入
export { ToolRegistry, registry } from './registry.js';
export { ToolRunner, runner } from './runner.js';
export type { RunOptions } from './runner.js';

// 内置工具
export { commandRun } from './commandRun.js';
export { fileRead } from './fileRead.js';
export { fileWrite } from './fileWrite.js';
export { grep } from './grep.js';

// MCP 接入
export { MCPClient } from './mcp/client.js';
export type { MCPServerConfig, StdioConfig, SSEConfig } from './mcp/client.js';
export { adaptMCPTool, buildToolName } from './mcp/adapter.js';
export { loadMCPConfig, registerAllMCPServers } from './mcp/loader.js';

import { registry } from './registry.js';
import { commandRun } from './commandRun.js';
import { fileRead } from './fileRead.js';
import { fileWrite } from './fileWrite.js';
import { grep } from './grep.js';

/**
 * 注册所有内置工具到全局 registry
 * @returns 已注册的工具名数组
 */
export function registerBuiltinTools(): string[] {
  const tools = [commandRun, fileRead, fileWrite, grep];
  for (const t of tools) {
    if (!registry.has(t.name)) {
      registry.register(t);
    }
  }
  return tools.map((t) => t.name);
}
