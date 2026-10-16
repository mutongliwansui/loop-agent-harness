# 🧩 工具扩展

> [⬅ 返回 README](../../../README.md)

### 新增自定义工具

```typescript
import type { Tool } from './src/types.js';
import { registry } from './src/tools/registry.js';

const myTool: Tool = {
  name: 'myTool',
  description: '我的自定义工具',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '输入内容' },
    },
    required: ['input'],
  },
  async execute(args) {
    const input = String(args.input);
    return `处理结果: ${input}`;
  },
};

// 注册到全局注册表
registry.register(myTool);
```

### 接入 MCP 外部工具

MCP（Model Context Protocol）是一种标准化的工具接入协议，支持 stdio、SSE（已废弃）与 Streamable HTTP 三种传输方式；远程 MCP Server 推荐使用 Streamable HTTP。

#### 方式一：配置文件（推荐）

创建 `.mcp.json` 或通过 CLI 的 `/mcp add` 命令交互式添加：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "fetch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "remote": {
      "type": "streamableHttp",
      "url": "https://host/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

项目启动时会自动加载配置并注册所有 MCP server 的工具。工具名规则：`{serverName}__{toolName}`（如 `filesystem__read_file`）。

#### 方式二：CLI 交互式添加

启动后输入 `mcp add my-server`，按提示输入传输类型、命令/URL 等，自动测试连接后写入配置。传输类型可选 `stdio` / `sse` / `http`（即 Streamable HTTP）；选择 `http` 时可再填一行可选认证头（如 `Authorization: Bearer xxx`）。

#### 方式三：编程式接入

```typescript
import { registry } from './src/tools/registry.js';

await registry.registerMCPServer('filesystem', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
});

// 注册成功后，可通过 registry.list() 查看所有工具
// MCP 工具名示例：filesystem__read_file, filesystem__write_file
```

#### 方式四：Streamable HTTP 接入（远程服务推荐）

```typescript
await registry.registerMCPServer('my-server', {
  type: 'streamableHttp',
  url: 'https://host/mcp',
  // 可选：自定义请求头（Bearer Token / API Key 等）
  headers: { Authorization: 'Bearer <token>' },
});
```

> - `type` 亦可写生态别名 `http` / `streamable-http`（大小写不敏感），三者等价。
> - Streamable HTTP 自 MCP 规范 2025-03-26 版起取代 HTTP+SSE，2026-07-28 版规范已将 HTTP+SSE 标记为 Deprecated。

#### 方式五：SSE 接入（已废弃，仅兼容存量服务）

```typescript
await registry.registerMCPServer('my-server', {
  type: 'sse',
  url: 'http://localhost:3000/sse',
});
```

> **注意**：单个 MCP server 连接失败不影响其他 server 或内置工具（失败隔离）。
