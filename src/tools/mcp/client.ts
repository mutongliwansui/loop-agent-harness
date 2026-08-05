// MCP 客户端：管理 stdio/SSE 两种传输的 MCP server 连接
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/** stdio 传输配置 */
export interface StdioConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** SSE 传输配置 */
export interface SSEConfig {
  type: 'sse';
  url: string;
}

/** MCP server 统一配置 */
export type MCPServerConfig = StdioConfig | SSEConfig;

/** 单个 MCP server 的客户端实例 */
export class MCPClient {
  readonly name: string;
  private client: Client;
  private transport: StdioClientTransport | SSEClientTransport | null = null;
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

    if (config.type === 'stdio') {
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        stderr: 'pipe', // 捕获 stderr，不污染主进程
      });
    } else {
      this.transport = new SSEClientTransport(new URL(config.url));
    }

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
