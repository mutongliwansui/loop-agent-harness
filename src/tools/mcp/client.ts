// MCP 客户端：管理 stdio/SSE/Streamable HTTP 三种传输的 MCP server 连接
// Task-20261015-001：新增 Streamable HTTP 传输（规范自 2025-03-26 起取代 HTTP+SSE，sse 已 Deprecated）
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** stdio 传输配置 */
export interface StdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** SSE 传输配置（已废弃：规范自 2025-03-26 起以 Streamable HTTP 取代，保留仅为兼容存量配置） */
export interface SSEConfig {
  type: 'sse';
  url: string;
}

/**
 * Streamable HTTP 传输配置（Task-20261015-001）
 * 说明：配置文件中 type 亦可写生态别名 `http` / `streamable-http`（大小写不敏感），
 * 由 normalizeMcpTransportType 归一化识别。
 */
export interface StreamableHttpConfig {
  type: 'streamableHttp';
  url: string;
  /** 自定义请求头（如 Authorization: Bearer …、X-API-Key） */
  headers?: Record<string, string>;
}

/** MCP server 统一配置 */
export type MCPServerConfig = StdioConfig | SSEConfig | StreamableHttpConfig;

/** 归一化传输类型：接受 streamableHttp / http / streamable-http（大小写不敏感，D1） */
export function normalizeMcpTransportType(
  raw: string,
): 'stdio' | 'sse' | 'streamableHttp' | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'stdio') return 'stdio';
  if (v === 'sse') return 'sse';
  if (v === 'streamablehttp' || v === 'http' || v === 'streamable-http') return 'streamableHttp';
  return null;
}

/**
 * 按配置构造 transport（纯函数，便于单测，D5）
 * 配置来自 JSON 时无编译期约束，故先用 normalizeMcpTransportType 归一化再分支（兼容 http 别名）
 */
export function createTransport(config: MCPServerConfig): Transport {
  const type = normalizeMcpTransportType(String((config as { type?: unknown }).type ?? ''));
  switch (type) {
    case 'stdio': {
      const c = config as StdioConfig;
      return new StdioClientTransport({
        command: c.command,
        args: c.args,
        env: c.env,
        cwd: c.cwd,
        stderr: 'pipe', // 捕获 stderr，不污染主进程
      });
    }
    case 'sse': {
      const c = config as SSEConfig;
      return new SSEClientTransport(new URL(c.url));
    }
    case 'streamableHttp': {
      const c = config as StreamableHttpConfig;
      // 空对象视为未配置，不传 requestInit
      const headers =
        c.headers && Object.keys(c.headers).length > 0 ? c.headers : undefined;
      return new StreamableHTTPClientTransport(new URL(c.url), {
        requestInit: headers ? { headers } : undefined,
      });
    }
    default:
      throw new Error(
        `不支持的 MCP 传输类型: ${String((config as { type?: unknown }).type)}`,
      );
  }
}

/** 单个 MCP server 的客户端实例 */
export class MCPClient {
  readonly name: string;
  private client: Client;
  private transport: Transport | null = null;
  private connected = false;

  constructor(name: string) {
    this.name = name;
    this.client = new Client(
      { name: 'react-agent', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  /** 连接到 MCP server */
  async connect(config: MCPServerConfig): Promise<void> {
    if (this.connected) {
      throw new Error(`MCP server ${this.name} 已连接，请勿重复连接`);
    }

    this.transport = createTransport(config);
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** 列出 server 提供的所有工具 */
  async listTools() {
    if (!this.connected) {
      throw new Error(`MCP server ${this.name} 未连接`);
    }
    return this.client.listTools();
  }

  /** 调用某个工具 */
  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.connected) {
      throw new Error(`MCP server ${this.name} 未连接`);
    }
    return this.client.callTool({ name, arguments: args });
  }

  /** 断开连接，清理子进程 */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.transport?.close();
    } finally {
      this.connected = false;
      this.transport = null;
    }
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }
}
