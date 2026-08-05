// MCP Manager：MCP server 生命周期管理（load/unload/reload/disconnectAll）
import { registry } from '../tools/registry.js';
import type { MCPServerConfig } from '../tools/mcp/client.js';
import { configLoader } from './loader.js';
import type { ConfigLoader } from './loader.js';
import type { ResolvedConfig } from './schema.js';

export interface LoadResult {
  successes: string[];
  failures: string[];
}

export class MCPManager {
  constructor(private loader: ConfigLoader = configLoader) {}

  /**
   * 启动时加载所有 MCP server（从合并后的配置）
   * 替代原 registerAllMCPServers
   */
  async loadFromConfig(): Promise<LoadResult> {
    const { config }: ResolvedConfig = this.loader.load();
    return this.loadServers(config.tools.mcpServers);
  }

  /**
   * 加载指定 MCP server 配置
   * 已连接的跳过（幂等）
   */
  async loadServers(servers: Record<string, MCPServerConfig>): Promise<LoadResult> {
    const successes: string[] = [];
    const failures: string[] = [];

    for (const [name, cfg] of Object.entries(servers)) {
      if (registry.listMCPServers().includes(name)) continue;
      try {
        const tools = await registry.registerMCPServer(name, cfg);
        successes.push(`${name} (${tools.length} 个工具)`);
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { successes, failures };
  }

  /** 加载单个 server */
  async loadServer(name: string, cfg: MCPServerConfig): Promise<string[]> {
    const res = await this.loadServers({ [name]: cfg });
    if (res.failures.length > 0) {
      throw new Error(res.failures[0]);
    }
    return res.successes;
  }

  /**
   * 卸载指定 MCP server（断开连接 + 移除工具）
   */
  async unloadServer(name: string): Promise<void> {
    await registry.disconnectMCPServer(name);
  }

  /**
   * 重新加载 MCP 配置（运行时热更新）：先全部卸载再从配置加载
   */
  async reload(): Promise<LoadResult> {
    await this.disconnectAll();
    return this.loadFromConfig();
  }

  /** 列出当前已连接的 MCP server */
  listConnected(): string[] {
    return registry.listMCPServers();
  }

  /** 关闭所有连接（进程退出时调用） */
  async disconnectAll(): Promise<void> {
    await registry.disconnectAllMCP();
  }

  /** 测试连接指定 MCP server（仅连接+listTools 后立即断开，不注册） */
  async testServer(name: string, cfg: MCPServerConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const tools = await registry.registerMCPServer(name, cfg);
      await registry.disconnectMCPServer(name);
      return { ok: true, message: `连接成功（${tools.length} 个工具）` };
    } catch (e) {
      return {
        ok: false,
        message: `连接失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

/** 全局单例 */
export const mcpManager = new MCPManager();

export function getMCPManager(): MCPManager {
  return mcpManager;
}
