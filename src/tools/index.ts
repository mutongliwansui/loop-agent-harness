// 工具系统聚合入口：统一导出 Registry、Runner、内置工具与 MCP 接入
export { ToolRegistry, registry } from './registry.js';
export { ToolRunner, runner } from './runner.js';
export type { RunOptions } from './runner.js';

// 内置工具
export { commandRun } from './commandRun.js';
export { fileRead } from './fileRead.js';
export { fileWrite } from './fileWrite.js';
export { editFile } from './editFile.js';
export { grep } from './grep.js';
export { activateSkill } from './activateSkill.js';

// MCP 接入
export { MCPClient } from './mcp/client.js';
export type { MCPServerConfig, StdioConfig, SSEConfig } from './mcp/client.js';
export { adaptMCPTool, buildToolName } from './mcp/adapter.js';
export {
  MCPManager,
  mcpManager,
  getMCPManager,
} from '../config/mcp-manager.js';

import { registry } from './registry.js';
import { commandRun } from './commandRun.js';
import { fileRead } from './fileRead.js';
import { fileWrite } from './fileWrite.js';
import { editFile } from './editFile.js';
import { grep } from './grep.js';
import { activateSkill } from './activateSkill.js';
import type { ToolsConfig } from '../config/schema.js';

/**
 * 注册所有内置工具到全局 registry
 * @param toolsConfig 可选的 tools 配置，根据 enabled/disabled 过滤
 * @returns 已注册的工具名数组
 */
export function registerBuiltinTools(toolsConfig?: ToolsConfig): string[] {
  const allTools = [commandRun, fileRead, fileWrite, editFile, grep, activateSkill];

  // 根据配置过滤
  let active = allTools;
  if (toolsConfig) {
    // enabled 非空时，白名单模式
    if (toolsConfig.enabled.length > 0) {
      active = allTools.filter((t) => toolsConfig.enabled.includes(t.name));
    }
    // disabled 排除
    if (toolsConfig.disabled.length > 0) {
      active = active.filter((t) => !toolsConfig.disabled.includes(t.name));
    }
  }

  for (const t of active) {
    if (!registry.has(t.name)) {
      registry.register(t);
    }
  }
  return active.map((t) => t.name);
}
