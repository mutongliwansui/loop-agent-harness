# 🧩 Tool Extension

> [⬅ Back to README](../../../README.md)

### Adding a Custom Tool

```typescript
import type { Tool } from './src/types.js';
import { registry } from './src/tools/registry.js';

const myTool: Tool = {
  name: 'myTool',
  description: 'My custom tool',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input content' },
    },
    required: ['input'],
  },
  async execute(args) {
    const input = String(args.input);
    return `Processed result: ${input}`;
  },
};

// Register into the global registry
registry.register(myTool);
```

### Connecting External MCP Tools

MCP (Model Context Protocol) is a standardized tool-integration protocol supporting stdio, SSE (deprecated) and Streamable HTTP transports; Streamable HTTP is recommended for remote MCP servers.

#### Option 1: Config file (recommended)

Create `.mcp.json` or add one interactively via the CLI's `/mcp add` command:

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

On startup, the project automatically loads the config and registers the tools of all MCP servers. Tool naming rule: `{serverName}__{toolName}` (e.g. `filesystem__read_file`).

#### Option 2: Interactive CLI add

After launching, type `mcp add my-server` and follow the prompts for transport type, command/URL, etc. It tests the connection automatically and then writes the config. The transport type can be `stdio` / `sse` / `http` (i.e. Streamable HTTP); choosing `http` also lets you enter one optional auth header (e.g. `Authorization: Bearer xxx`).

#### Option 3: Programmatic integration

```typescript
import { registry } from './src/tools/registry.js';

await registry.registerMCPServer('filesystem', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
});

// After registration, use registry.list() to see all tools
// Example MCP tool names: filesystem__read_file, filesystem__write_file
```

#### Option 4: Streamable HTTP transport (recommended for remote servers)

```typescript
await registry.registerMCPServer('my-server', {
  type: 'streamableHttp',
  url: 'https://host/mcp',
  // Optional: custom request headers (Bearer Token / API Key, etc.)
  headers: { Authorization: 'Bearer <token>' },
});
```

> - `type` also accepts the ecosystem aliases `http` / `streamable-http` (case-insensitive); all three are equivalent.
> - Streamable HTTP has replaced HTTP+SSE since the MCP spec 2025-03-26; the 2026-07-28 spec marks HTTP+SSE as Deprecated.

#### Option 5: SSE transport (deprecated, legacy compatibility only)

```typescript
await registry.registerMCPServer('my-server', {
  type: 'sse',
  url: 'http://localhost:3000/sse',
});
```

> **Note**: A failed connection to a single MCP server does not affect other servers or built-in tools (failure isolation).

### Localized display names for MCP tools

MCP tool cards in the WebUI (chat stream and live status) show a Chinese display name, a semantic icon, a source-server badge and localized parameter labels. The material comes from the MCP protocol and is resolved with the following precedence (requirement 20261104-001):

| Priority | Source | Notes |
|---|---|---|
| 1 | `tool.title` | Top-level title introduced by MCP spec 2025-06-18 |
| 2 | `tool.annotations.title` | Available since 2025-03-26; most servers only provide this field |
| 3 | Description already Chinese | Short name distilled locally, **no LLM call** |
| 4 | LLM translation | Batched in the background, cached by content fingerprint |
| 5 | Name prettifying | `shortestPath` → `Shortest Path` (last resort) |

> **Target language beats literal precedence**: `title` / `annotations.title` are used as-is only when they are already Chinese.
> An English title with a Chinese description resolves from the Chinese description (better suited to a Chinese UI);
> an English title with an English description still goes through LLM translation, and falls back to the raw title while
> translation is pending or failed, so no information is lost.

Parameter labels follow the same chain: `inputSchema.properties[k].description` → CJK distillation / LLM translation → prettified key.

```json
{
  "tools": {
    "mcpTranslate": { "enabled": true, "mode": "auto", "timeoutMs": 20000, "maxToolsPerBatch": 60 }
  }
}
```

- `enabled: false`: no LLM call at all; names fall back to prettified English.
- `mode: 'always'`: translate even when the description is already Chinese (default `auto` skips it to save calls).
- Translation runs in the background and **never blocks server registration or chatting**; results are cached in `~/.loop-agent/mcp-meta.json` and automatically invalidated when a server changes its descriptions.
- Display metadata is UI-only: it never enters the `Tool` interface or `toOpenAITools()`, so the model-facing tool list and prompt cache stay byte-identical.
- Inspect status via `GET /mcp/tool-meta` (the WebUI MCP page also shows "ready N/M" plus failure reasons).
