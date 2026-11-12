// 工具系统聚合入口：统一导出 Registry、Runner、内置工具与 MCP 接入
export { ToolRegistry, registry } from './registry.js';
export { ToolRunner, runner } from './runner.js';
export type { RunOptions } from './runner.js';

// 内置工具
export { commandRun } from './commandRun.js';
// 后台任务管理三工具（Task-20261022-002）
export { commandStatus, commandLogs, commandStop } from './command-status.js';
export { fileRead } from './fileRead.js';
export { fileWrite } from './fileWrite.js';
export { editFile } from './editFile.js';
export { grep } from './grep.js';
export { activateSkill } from './activateSkill.js';
// 子 Agent 委托（需求 20261107-001）
export { delegate } from './delegate.js';

// 视觉工具（按 vision.enabled 条件注册；需求 20261111-004 四合一为 analyzeImage）
export { visionTools, analyzeImage } from './vision/tools.js';

// MCP 接入
export { MCPClient, normalizeMcpTransportType } from './mcp/client.js';
export type {
  MCPServerConfig,
  StdioConfig,
  SSEConfig,
  StreamableHttpConfig,
} from './mcp/client.js';
export { adaptMCPTool, buildToolName } from './mcp/adapter.js';
export {
  MCPManager,
  mcpManager,
  getMCPManager,
} from '../config/mcp-manager.js';

import { registry } from './registry.js';
import { commandRun } from './commandRun.js';
import { commandStatus, commandLogs, commandStop } from './command-status.js';
import { fileRead } from './fileRead.js';
import { fileWrite } from './fileWrite.js';
import { editFile } from './editFile.js';
import { grep } from './grep.js';
import { activateSkill } from './activateSkill.js';
import { delegate } from './delegate.js';
import { visionTools } from './vision/tools.js';
import type { ToolsConfig, VisionConfig } from '../config/schema.js';

/**
 * 注册所有内置工具到全局 registry
 * @param toolsConfig 可选的 tools 配置，根据 enabled/disabled 过滤
 * @param visionConfig 可选的 vision 配置，enabled 时才注册视觉工具（未启用时 tools 列表保持不变，保护前缀缓存）
 * @returns 已注册的工具名数组
 */
export function registerBuiltinTools(toolsConfig?: ToolsConfig, visionConfig?: VisionConfig): string[] {
  const visionEnabled = visionConfig?.enabled === true;
  const allTools = [
    commandRun, commandStatus, commandLogs, commandStop,
    fileRead, fileWrite, editFile, grep, activateSkill,
    // 需求 20261107-001：子 Agent 委托（子 Agent run 时由 excludeTools 排除，防无限递归）
    delegate,
    ...(visionEnabled ? visionTools : []),
  ];

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
