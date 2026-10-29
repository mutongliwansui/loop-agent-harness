// 工具注册表：管理工具的注册、查询、转换为 OpenAI tools 参数格式
import type { Tool, OpenAIToolDef } from '../types.js';
import { MCPClient } from './mcp/client.js';
import { adaptMCPTool } from './mcp/adapter.js';
import type { MCPServerConfig } from './mcp/client.js';

/**
 * 规范化 JSON 对象：递归排序对象 keys，确保 JSON Schema 序列化结果确定性。
 * DeepSeek V4 等模型的前缀缓存依赖字节级一致的请求体，
 * 不稳定的 key 顺序会导致 tools 部分无法命中缓存。
 */
function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize((obj as Record<string, unknown>)[key]);
  }
  return result;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  /** MCP 客户端实例映射：serverName → MCPClient */
  private mcpClients = new Map<string, MCPClient>();

  /**
   * 注册工具
   * @throws 重复注册同名工具时抛出错误
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 ${tool.name} 已注册，不可重复注册`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 获取工具
   * @throws 工具未注册时抛出错误
   */
  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) {
      throw new Error(`工具 ${name} 未注册`);
    }
    return t;
  }

  /** 列出所有已注册工具 */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 判断工具是否已注册 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 注销工具（MCP 卸载或禁用内置工具时使用） */
  unregister(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error(`工具 ${name} 未注册，无法注销`);
    }
    this.tools.delete(name);
  }

  /** 清空所有工具（慎用，用于 reload） */
  clear(): void {
    this.tools.clear();
  }

  /** 断开指定 MCP server 连接并移除工具 */
  async disconnectMCPServer(serverName: string): Promise<void> {
    const client = this.mcpClients.get(serverName);
    if (!client) return;

    // 移除前缀匹配的工具
    const prefix = `${serverName}__`;
    for (const t of this.list()) {
      if (t.name.startsWith(prefix)) {
        this.tools.delete(t.name);
      }
    }

    try {
      await client.disconnect();
    } catch {
      // 忽略断开错误
    }
    this.mcpClients.delete(serverName);
  }

  /**
   * 转换为 OpenAI function calling 的 tools 参数格式
   * 按名称排序 + 参数规范化，确保序列化结果确定性以命中模型前缀缓存
   */
  toOpenAITools(): OpenAIToolDef[] {
    return this.list()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: canonicalize(t.parameters) as Record<string, unknown>,
        },
      }));
  }

  /**
   * 注册一个 MCP server：连接 → 列出工具 → 适配并注册到 registry
   * 失败不抛错，返回失败信息，让其他 server 继续注册（失败隔离）
   * @returns 注册成功的工具名数组
   */
  async registerMCPServer(
    name: string,
    config: MCPServerConfig,
  ): Promise<string[]> {
    // 已存在同名 server，直接跳过
    if (this.mcpClients.has(name)) {
      return [];
    }

    const client = new MCPClient(name);
    try {
      await client.connect(config);
      this.mcpClients.set(name, client);

      const { tools } = await client.listTools();
      const registered: string[] = [];
      for (const t of tools) {
        const adapted = adaptMCPTool(name, t, client);
        // 幂等：同名工具已存在则跳过，不抛错
        if (!this.tools.has(adapted.name)) {
          this.tools.set(adapted.name, adapted);
          registered.push(adapted.name);
        }
      }
      return registered;
    } catch (e) {
      // 连接或列出工具失败：清理已建立的连接，返回空数组
      // 必须先摘掉 Map 里的条目：connect 成功后已登记，listTools 失败时若不摘除，
      // listMCPServers 会把这条已断开的 client 当成「已连接」，监测器也会误判状态
      this.mcpClients.delete(name);
      await client.disconnect().catch(() => {});
      throw new Error(
        `MCP server ${name} 连接失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 健康检查指定 MCP server（McpMonitor 定期调用）。
   * 未连接直接返回 false——调用方据此走重连分支。
   */
  async healthCheckMCPServer(serverName: string): Promise<boolean> {
    const client = this.mcpClients.get(serverName);
    if (!client) return false;
    return client.checkHealth();
  }

  /** 断开所有 MCP server 连接（进程退出时调用） */
  async disconnectAllMCP(): Promise<void> {
    const tasks = [...this.mcpClients.values()].map((c) =>
      c.disconnect().catch(() => {}),
    );
    await Promise.all(tasks);
    this.mcpClients.clear();
  }

  /** 列出所有已连接的 MCP server 名称 */
  listMCPServers(): string[] {
    return [...this.mcpClients.keys()];
  }
}

/** 全局单例 */
export const registry = new ToolRegistry();
