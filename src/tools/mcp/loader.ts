// MCP 配置加载器：从 .mcp.json 读取配置并批量注册 MCP server
import { readFile } from 'node:fs/promises';
import { registry } from '../registry.js';
import type { MCPServerConfig } from './client.js';

/** .mcp.json 配置文件格式 */
interface MCPConfigFile {
  mcpServers: Record<string, MCPServerConfig>;
}

/** 默认配置文件路径 */
const DEFAULT_CONFIG_PATH = '.mcp.json';

/**
 * 从 JSON 文件加载 MCP 配置
 * 文件不存在时返回空配置（不抛错，方便无 MCP 场景使用）
 */
export async function loadMCPConfig(
  path = DEFAULT_CONFIG_PATH,
): Promise<MCPServerConfig[]> {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content) as MCPConfigFile;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return [];
    }
    return Object.entries(parsed.mcpServers).map(([name, config]) => ({
      name,
      ...config,
    })) as Array<MCPServerConfig & { name: string }>;
  } catch {
    // 文件不存在或解析失败，返回空
    return [];
  }
}

/**
 * 批量注册所有 MCP server
 * 单个 server 失败不影响其他 server（失败隔离）
 * @returns { successes, failures } 记录每个 server 的注册结果
 */
export async function registerAllMCPServers(
  configs: Array<MCPServerConfig & { name: string }>,
): Promise<{ successes: string[]; failures: string[] }> {
  const successes: string[] = [];
  const failures: string[] = [];

  for (const { name, ...config } of configs) {
    try {
      const tools = await registry.registerMCPServer(name, config);
      successes.push(`${name} (${tools.length} 个工具)`);
    } catch (e) {
      failures.push(
        `${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { successes, failures };
}
