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

### MCP 工具展示名中文化

WebUI 对话流与运行态里的 MCP 工具卡片会显示中文名、语义图标、来源 server 徽标与中文参数标签，素材来自 MCP 协议的展示元信息，按下面的优先级解析（需求 20261104-001）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `tool.title` | MCP 规范 2025-06-18 引入的顶层 title |
| 2 | `tool.annotations.title` | 自 2025-03-26 可用；本机多数 server 只提供该字段 |
| 3 | 描述已是中文 | 本地按标点/长度提炼短名，**不调 LLM** |
| 4 | LLM 翻译 | 后台异步批量翻译，结果按内容指纹缓存 |
| 5 | 名字分词美化 | `shortestPath` → `Shortest Path`（末位兜底） |

> **目标语言优先于字面优先级**：`title` / `annotations.title` 只在本身就是中文时直接采纳；
> 若 title 是英文而描述是中文，则用中文描述提炼（比英文 title 更贴合中文界面）；
> 若 title 是英文且描述也是英文，则仍走 LLM 翻译，翻译未就绪或失败时回落 title 原文展示（不丢信息）。

参数标签同理：`inputSchema.properties[k].description` → CJK 提炼 / LLM 翻译 → 美化键名。

```json
{
  "tools": {
    "mcpTranslate": { "enabled": true, "mode": "auto", "timeoutMs": 20000, "maxToolsPerBatch": 60 }
  }
}
```

- `enabled: false`：完全不调 LLM，展示名回落为名字美化（功能不坏）。
- `mode: 'always'`：中文描述也强制走 LLM（默认 `auto` 会跳过，省调用）。
- 翻译在后台上进行，**不阻塞 server 注册与对话**；结果缓存在 `~/.loop-agent/mcp-meta.json`，server 改了描述会自动失效重译。
- 展示元信息只服务 UI：不进 `Tool` 接口、不进 `toOpenAITools()`，模型侧工具列表与前缀缓存逐字节不变。
- 查看状态：`GET /mcp/tool-meta`（WebUI 的 MCP 页也会显示「已就绪 N/M」与失败原因）。
