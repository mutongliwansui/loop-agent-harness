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
