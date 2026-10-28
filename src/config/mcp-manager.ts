// MCP Manager：MCP server 生命周期管理（load/unload/reload/disconnectAll）
import { registry } from '../tools/registry.js';
import {
  normalizeMcpTransportType,
  type MCPServerConfig,
  type StdioConfig,
} from '../tools/mcp/client.js';
import { configLoader } from './loader.js';
import type { ConfigLoader } from './loader.js';
import type { ResolvedConfig } from './schema.js';
import { debug } from '../debug.js';

/**
 * 进程启动目录（模块加载时捕获，独立于任何工作空间运行时）。
 * Task-20261021-010-02 D19：MCPManager 是进程级单例、启动期一次性连接，
 * stdio server 的 cwd 固定为「配置显式值 ?? 启动目录」，不随会话所属工作空间变化。
 */
const startupRoot = process.cwd();

/** 为未显式配置 cwd 的 stdio server 填入启动目录（不修改原配置对象） */
function withExplicitCwd(cfg: MCPServerConfig): MCPServerConfig {
  if (normalizeMcpTransportType(String((cfg as { type?: unknown }).type ?? '')) !== 'stdio') return cfg;
  const stdio = cfg as StdioConfig;
  return stdio.cwd ? cfg : { ...stdio, cwd: startupRoot };
}

export interface LoadResult {
  successes: string[];
  failures: string[];
}

/** /mcp view 结果：服务连接状态 + 工具清单 */
export interface MCPViewResult {
  ok: boolean;
  /** 查询前该 server 是否已连接（false 表示走了临时连接查询） */
  connected: boolean;
  tools: { name: string; description: string }[];
  message?: string;
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
    const entries = Object.entries(servers).filter(([name]) => !registry.listMCPServers().includes(name));
    if (entries.length === 0) return { successes: [], failures: [] };

    const t0 = Date.now();
    debug.log(`[mcp] 开始连接 ${entries.length} 个 server（并发）...`);

    // D20：并发连接，任何一个的超时不再阻塞其他 server 与整体启动
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => {
        debug.log(`[mcp]   → ${name} 连接中...`);
        const t1 = Date.now();
        try {
          const tools = await registry.registerMCPServer(name, withExplicitCwd(cfg));
          debug.log(`[mcp]   ✓ ${name} (${tools.length} 工具, +${Date.now() - t1}ms)`);
          return { name, ok: true, tools, elapsed: Date.now() - t1 } as const;
        } catch (e) {
          debug.log(`[mcp]   ✗ ${name} 失败 (+${Date.now() - t1}ms): ${e instanceof Error ? e.message : String(e)}`);
          return { name, ok: false, err: e, elapsed: Date.now() - t1 } as const;
        }
      }),
    );

    const successes: string[] = [];
    const failures: string[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        // allSettled 永不 reject，理论上不会走到这里
        failures.push(`${(r.reason as { name?: string })?.name ?? '?'}: ${String(r.reason)}`);
        continue;
      }
      const v = r.value;
      if (v.ok) {
        successes.push(`${v.name} (${v.tools.length} 个工具)`);
      } else {
        failures.push(`${v.name}: ${v.err instanceof Error ? v.err.message : String(v.err)}`);
      }
    }
    debug.log(`[mcp] 完成：${successes.length} 成功 + ${failures.length} 失败，总耗时 ${Date.now() - t0}ms`);
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
      const tools = await registry.registerMCPServer(name, withExplicitCwd(cfg));
      await registry.disconnectMCPServer(name);
      return { ok: true, message: `连接成功（${tools.length} 个工具）` };
    } catch (e) {
      return {
        ok: false,
        message: `连接失败: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * 查看指定 MCP server 的服务信息与工具清单：
   * - 已连接：直接读 registry 已注册工具（零开销，不重连）
   * - 未连接：临时连接拉取工具清单后立即断开（与 testServer 同款临时连接模式）
   */
  async viewServer(name: string, cfg: MCPServerConfig): Promise<MCPViewResult> {
    const connected = registry.listMCPServers().includes(name);
    try {
      if (!connected) {
        await registry.registerMCPServer(name, withExplicitCwd(cfg));
      }
      const prefix = `${name}__`;
      const tools = registry
        .list()
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => ({ name: t.name, description: t.description }));
      if (!connected) {
        await registry.disconnectMCPServer(name);
      }
      return { ok: true, connected, tools };
    } catch (e) {
      return {
        ok: false,
        connected,
        tools: [],
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/** 全局单例 */
export const mcpManager = new MCPManager();

export function getMCPManager(): MCPManager {
  return mcpManager;
}
