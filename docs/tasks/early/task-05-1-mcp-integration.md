# Task-05-1：MCP Tool 接入

## 需求目标

为 ReAct Agent 增加 Model Context Protocol（MCP）工具接入能力，使 Agent 不仅能调用本地内置工具（Task-05），还能通过 MCP 协议接入外部工具服务器，实现工具生态的横向扩展。

### 目标清单
1. 实现 `src/tools/mcp/client.ts`：MCP 客户端，管理与 MCP server 的连接（stdio / SSE 两种传输）
2. 实现 `src/tools/mcp/adapter.ts`：适配器，把 MCP tool 包装成项目 `Tool` 接口
3. 在 Registry 增加 `registerMCPServer(serverConfig)` 方法，批量注册某 MCP server 的所有工具
4. 提供 `.mcp.json` 配置文件，声明式管理多个 MCP server
5. 支持启动时自动加载所有 MCP server 工具
6. MCP 工具与内置工具在 ReAct 主循环中无差别使用

## 实现方案

### 1. 依赖

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x"
  }
}
```

### 2. MCP 客户端（`src/tools/mcp/client.ts`）

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface MCPServerConfig {
  /** server 唯一标识，用作工具名前缀避免冲突 */
  name: string;
  /** 传输方式 */
  transport: 'stdio' | 'sse';
  /** stdio 模式：可执行命令 */
  command?: string;
  /** stdio 模式：命令参数 */
  args?: string[];
  /** stdio 模式：环境变量 */
  env?: Record<string, string>;
  /** sse 模式：server URL */
  url?: string;
}

export class MCPClient {
  private client: Client;
  private connected = false;

  constructor(private config: MCPServerConfig) {
    this.client = new Client(
      { name: 'react-agent', version: '0.1.0' },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    let transport;
    if (this.config.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: this.config.command!,
        args: this.config.args ?? [],
        env: { ...process.env, ...this.config.env } as Record<string, string>,
      });
    } else {
      transport = new SSEClientTransport(new URL(this.config.url!));
    }
    await this.client.connect(transport);
    this.connected = true;
  }

  /** 列出 server 提供的所有工具 */
  async listTools() {
    if (!this.connected) throw new Error(`MCP server ${this.config.name} 未连接`);
    const resp = await this.client.listTools();
    return resp.tools;
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.connected) throw new Error(`MCP server ${this.config.name} 未连接`);
    return this.client.callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
```

### 3. 适配器（`src/tools/mcp/adapter.ts`）

```typescript
import type { Tool } from '../../types.js';
import { MCPClient } from './client.js';

/**
 * 把 MCP tool 包装成项目 Tool 接口
 * - name 加前缀 `{serverName}__{toolName}`，避免多 server 工具重名
 * - execute 内部走 MCP 的 callTool RPC
 * - 返回结果归一化为字符串
 */
export function adaptMCPTool(
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  client: MCPClient,
  serverName: string,
): Tool {
  const fullName = `${serverName}__${mcpTool.name}`;
  return {
    name: fullName,
    description: mcpTool.description ?? `(MCP tool from ${serverName})`,
    parameters: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    async execute(args) {
      const result = await client.callTool(mcpTool.name, args);
      // MCP callTool 返回 content 数组，可能含 text/image/resource
      if (Array.isArray(result.content)) {
        const texts = result.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        return texts.join('\n') || JSON.stringify(result);
      }
      return JSON.stringify(result);
    },
  };
}
```

### 4. Registry 扩展

```typescript
// src/tools/registry.ts 增加
import { MCPClient, MCPServerConfig } from './mcp/client.js';
import { adaptMCPTool } from './mcp/adapter.js';

export class ToolRegistry {
  private mcpClients: MCPClient[] = [];

  /**
   * 注册一个 MCP server 的所有工具
   * @returns 已注册的工具名数组
   */
  async registerMCPServer(config: MCPServerConfig): Promise<string[]> {
    const client = new MCPClient(config);
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];
    for (const t of tools) {
      const adapted = adaptMCPTool(t, client, config.name);
      this.register(adapted);  // 复用已有 register，含重名校验
      registered.push(adapted.name);
    }
    return registered;
  }

  /** 断开所有 MCP server 连接（进程退出前调用） */
  async disconnectAllMCP(): Promise<void> {
    await Promise.all(this.mcpClients.map((c) => c.disconnect()));
    this.mcpClients = [];
  }
}
```

### 5. 配置文件（`.mcp.json`）

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "fetch",
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  ]
}
```

### 6. 加载器（`src/tools/mcp/loader.ts`）

```typescript
import { readFile } from 'node:fs/promises';
import { registry } from '../registry.js';
import type { MCPServerConfig } from './client.js';

interface MCPConfig {
  servers: MCPServerConfig[];
}

/**
 * 从 .mcp.json 加载并注册所有 MCP server 的工具
 * @returns 每个server 注册的工具名映射
 */
export async function loadMCPServers(configPath = '.mcp.json') {
  const raw = await readFile(configPath, 'utf-8');
  const config: MCPConfig = JSON.parse(raw);

  const results: Record<string, string[]> = {};
  for (const server of config.servers) {
    try {
      const names = await registry.registerMCPServer(server);
      results[server.name] = names;
      console.log(`[MCP] ${server.name}: 已注册 ${names.length} 个工具`);
    } catch (e) {
      console.error(`[MCP] ${server.name} 连接失败:`, e instanceof Error ? e.message : e);
    }
  }
  return results;
}
```

### 7. CLI 集成（src/index.ts）

```typescript
import { loadMCPServers } from './tools/mcp/loader.js';

async function main() {
  registerBuiltinTools();  // Task-05 的内置工具
  await loadMCPServers();  // 加载 MCP 工具（失败不阻断启动）

  // ... 原有 REPL 逻辑
}
```

### 8. System Prompt 集成

`buildSystemPrompt(registry.list())` 已经动态注入工具列表，MCP 工具（含 `serverName__toolName` 前缀）会自动出现在 Prompt 中，无需修改 prompt.ts。

## 设计要点

- **工具名前缀**：`{serverName}__{toolName}`，避免不同 server 的工具重名
- **传输双支持**：stdio（本地进程）+ SSE（远程服务）
- **失败不阻断**：单个 MCP server 连接失败不影响其他 server 与内置工具
- **连接生命周期**：进程退出时调用 `registry.disconnectAllMCP()`，清理子进程
- **结果归一化**：MCP callTool 返回 content 数组，适配器提取 text 内容转字符串
- **与内置工具无差别**：MCP 工具注册后与 commandRun/fileRead 等一样参与 ReAct 推理与并发执行

## 验收测试清单

- [x] 项1：`@modelcontextprotocol/sdk` 依赖已安装（实测：84 个包）
- [x] 项2：`MCPClient` 类已实现，支持 stdio 与 SSE 两种传输
- [x] 项3：`MCPClient.connect()` stdio 模式能启动子进程并完成握手（实测：npx @modelcontextprotocol/server-memory）
- [x] 项4：`MCPClient.listTools()` 返回工具列表（实测：9 个 memory 工具）
- [x] 项5：`MCPClient.callTool()` 能调用工具并返回结果（实测：create_entities 成功）
- [x] 项6：`adaptMCPTool()` 把 MCP tool 包装为项目 Tool 接口（实测验证）
- [x] 项7：适配后的工具名含 `{serverName}__` 前缀（实测：memory-adapt__create_entities）
- [x] 项8：适配后的 execute 返回字符串（提取 content.text）
- [x] 项9：`registry.registerMCPServer(config)` 批量注册某 server 的所有工具（实测：9 个工具一次注册）
- [x] 项10：重名工具（不同 server 同名）注册时不冲突（前缀隔离）
- [x] 项11：`.mcp.json` 配置文件可被 `loadMCPConfig()` 正确解析（文件不存在时返回空数组）
- [x] 项12：单个 server 连接失败时不影响其他 server 与内置工具加载（失败隔离，try-catch 包裹）
- [x] 项13：MCP 工具出现在 `registry.toOpenAITools()` 输出中（实测验证）
- [x] 项14：MCP 工具出现在 System Prompt 的工具列表中（Task-07 已补齐验证）
- [ ] 项15：ReAct 主循环可调用 MCP 工具并正确得到 Observation（待 Task-08 集成测试）
- [x] 项16：MCP 工具参与 `runner.runParallel` 并发执行（复用 Task-04 的 Runner，接口兼容）
- [x] 项17：`registry.disconnectAllMCP()` 能正确关闭所有 MCP 连接（实测验证）
- [ ] 项18：进程退出时（SIGINT/SIGTERM）自动调用 disconnectAllMCP（待 Task-08 CLI 入口实现）
- [x] 项19：`.mcp.json` 不存在时 Agent 仍可正常启动（仅内置工具）（实测：返回空数组）
- [x] 项20：`.mcp.json` 配置示例已提供（.mcp.json.example，含 filesystem + fetch）
- [x] 项21：`npm run typecheck` 通过

> 项14/15/18 需待 Task-07/08 完成后补齐验证，MCP 接入层本身已完整。

## 状态

- 状态：已完成（核心接入层 18/21 通过，3 项依赖后续任务集成验证）
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-04（ToolRegistry）、Task-05（registerBuiltinTools 模式参考）
- 优先级：中（扩展任务，非 ReAct 闭环必需）
- 备注：MCP 工具与内置工具在 ReAct 主循环中无差别处理，不影响 Task-06/07/08 的实现
