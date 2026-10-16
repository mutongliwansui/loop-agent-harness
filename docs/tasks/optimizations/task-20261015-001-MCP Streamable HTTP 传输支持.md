# Task-20261015-001：MCP Streamable HTTP 传输支持

> 目标：为 MCP 接入新增 Streamable HTTP 传输，使 Agent 能连接仅提供 Streamable HTTP 端点的远程 MCP Server（含 Bearer/API Key 认证头），同时保留 stdio / SSE 两种既有传输以兼容存量配置。
>
> 对应优化建议编号：`20261015-001`（见 [优化建议.md](file:///d:/trae_workspace/loop-agent-command/docs/optimization_suggestions/优化建议.md)）

---

## 一、任务目标需求

### 1.1 背景

MCP 规范自 **2025-03-26** 版起，用 **Streamable HTTP** 取代了旧的 HTTP+SSE 传输；在 **2026-07-28** 版规范中，HTTP+SSE 已被正式标记为 **Deprecated**（SEP-2596），规范明确「新实现 SHOULD NOT 采用，存量实现 SHOULD 迁移到 Streamable HTTP」。当前项目 MCP 接入只实现了 `stdio` 与 `sse`（即被废弃的 HTTP+SSE），存在两个现实问题：

1. **接不上**：越来越多远程 MCP Server（云侧托管、企业内网网关）只暴露 Streamable HTTP 端点（单个 `/mcp` 端点，POST + 可选 SSE 流），不提供旧式 SSE 双端点，当前配置无法接入。
2. **走不远**：继续停留在已 Deprecated 的传输上，会逐步失去生态兼容性。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| 传输类型定义 | [client.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/client.ts#L22) `MCPServerConfig = StdioConfig \| SSEConfig`，仅 stdio / sse | **需扩展**：新增 `StreamableHttpConfig` |
| 传输实例化 | [client.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/client.ts#L45-L55) `connect()` 内 `if (stdio) … else SSEClientTransport` | **需改造**：改为三分支，且抽出独立可测函数 |
| transport 字段类型 | [client.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/client.ts#L28) `StdioClientTransport \| SSEClientTransport \| null` | **需扩展**：并入 `StreamableHTTPClientTransport` |
| 配置结构 | [schema.ts](file:///d:/trae_workspace/loop-agent-command/src/config/schema.ts#L64) `mcpServers: Record<string, MCPServerConfig>`，纯类型驱动，无运行时枚举校验 | 复用，**无需改动** |
| 生命周期管理 | [mcp-manager.ts](file:///d:/trae_workspace/loop-agent-command/src/config/mcp-manager.ts#L29-L44) `loadServers` 泛型透传 config，不感知 type | 复用，**无需改动** |
| 注册链路 | [registry.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/registry.ts#L117-L149) `registerMCPServer` 只 `client.connect(config)`，不感知 type | 复用，**无需改动** |
| 交互式添加 | [mcp-command.ts](file:///d:/trae_workspace/loop-agent-command/src/commands/mcp-command.ts#L28-L46) 传输类型只接受 `stdio` / `sse` | **需扩展**：新增 http 选项 + 认证头输入 |
| 列表展示 | [mcp-command.ts](file:///d:/trae_workspace/loop-agent-command/src/commands/mcp-command.ts#L102-L104) 详情为 `stdio ? command/args : url` 二元分支 | **需改造**：按 type 三分支，headers 脱敏 |
| 类型导出 | [tools/mcp/index.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/index.ts#L4)、[tools/index.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/index.ts#L19) 导出 `MCPServerConfig, StdioConfig, SSEConfig` | **需同步**：补导出 `StreamableHttpConfig` |
| SDK 能力 | `@modelcontextprotocol/sdk@^1.30.0`（[package.json](file:///d:/trae_workspace/loop-agent-command/package.json#L19)）**已内置** `StreamableHTTPClientTransport`（`dist/esm/client/streamableHttp.js`），构造签名 `new StreamableHTTPClientTransport(url: URL, opts?: { requestInit?, authProvider?, sessionId?, reconnectionOptions?, fetch? })` | **零新增依赖** |

### 1.3 任务目标

- 配置支持第三种传输：`{ "type": "streamableHttp", "url": "https://host/mcp", "headers": { "Authorization": "Bearer xxx" } }`。
- `/mcp add <name>` 交互式添加时，传输类型可选 `http`（等价写法），并可选择填写认证头。
- `/mcp list` 能正确展示 streamableHttp 类型的 URL 与「是否已配置认证头」。
- `/mcp test <name>`、`/mcp reload`、启动自动加载三条链路对 streamableHttp 与既有类型行为一致。
- **保留 stdio / sse**：存量配置不破坏；sse 在交互与文档中标注为「已废弃，建议迁移」。

### 1.4 设计约束

- **零新依赖**：仅复用 SDK 已内置的 `StreamableHTTPClientTransport`，不新增 npm 包。
- **类型安全**：`MCPServerConfig` 判别联合扩展，编译期穷尽检查不漏分支。
- **向后兼容**：既有 `stdio` / `sse` 配置结构、字段与行为完全不变。
- **可单元测试**：传输实例化逻辑抽为纯函数，单测无需真实建连（不依赖网络/子进程）。
- **安全**：`headers` 可能含密钥，展示与日志必须脱敏（仅显示键名，不回显值）。

---

## 二、方案设计

### 2.1 总体思路

```
用户配置 / /mcp add 交互
   │  { type: 'streamableHttp' | 'http' | 'streamable-http', url, headers? }   D1 / D2 / D6
   ▼
MCPManager.loadServers ──▶ registry.registerMCPServer ──▶ new MCPClient(name)
   │                                                              │
   │                                                    connect(config)  D5
   │                                                              │
   │                                          createTransport(config)  ← 纯函数，可单测
   │                                                  ├─ stdio        → StdioClientTransport
   │                                                  ├─ sse          → SSEClientTransport            D3
   │                                                  └─ streamableHttp→ StreamableHTTPClientTransport
   │                                                                     { requestInit: { headers } }   D2
   ▼
/mcp list 详情渲染（三分支 + headers 脱敏）                                     D7
```

### 2.2 关键设计决策

#### D1 配置 `type` 主值取 `streamableHttp`，并归一化接受 `http` / `streamable-http` 别名

- 项目内既有取值为小写单词（`stdio` / `sse`），SDK 类名为 `StreamableHTTPClientTransport`，取 **`streamableHttp`** 作为主值最贴近代码语义。
- MCP 规范使用 `streamable-http`，而 Claude Code 等生态实现将 `http` 与 `streamable-http` 视为等价别名，用户很可能直接粘贴生态配置。故解析时**归一化**：`streamableHttp` / `http` / `streamable-http`（大小写不敏感）均识别为同一传输。
- 归一化放在独立纯函数 `normalizeMcpTransportType()`，配置读取与 `/mcp add` 交互共用同一入口。
- **被否决项**：只支持单一写法（用户粘贴生态配置会报错，体验差）；支持 `ws` 等其它传输（超出本任务范围）。

#### D2 复用 `url` 字段，新增可选 `headers` 并透传为 `requestInit.headers`

- `url` 与 `sse` 同义，避免引入 `endpoint` 等新命名。
- 远程 MCP 普遍需要认证，`headers?: Record<string, string>` 覆盖 `Authorization: Bearer …` / `X-API-Key` 等场景，映射为 SDK 的 `{ requestInit: { headers } }`。
- **被否决项**：不支持 headers（远程服务基本无法接入）；直接让用户写原始 `requestInit` 对象（配置复杂度外溢，且暴露 fetch 细节）。

#### D3 保留 `sse`，但标注为已废弃

- 存量配置必须继续可用，直接移除属破坏性变更。
- `/mcp add` 交互与 README 中对 `sse` 加「已废弃（Deprecated），建议改用 http」提示，引导迁移但不阻断。
- **被否决项**：删除 sse（破坏存量配置）；把 sse 自动改写成 streamableHttp（旧 SSE 双端点与 Streamable HTTP 端点语义不同，静默改写必然失败）。

#### D4 不做「streamableHttp 失败自动回退 sse」的隐式降级

- 两种传输的端点形态与协议语义不同，自动回退会掩盖配置错误、延长失败等待，并产生难排查的「偶发连上」现象。
- 显式优于隐式：由用户在配置里写清 `type`，失败即失败并给出明确报错。
- **被否决项**：connect 失败后依次尝试三种传输。

#### D5 传输实例化抽为纯函数 `createTransport(config): Transport`

- 现状把构造逻辑内联在 `connect()` 中（[client.ts:L45-L55](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/client.ts#L45-L55)），无法在不真实建连的前提下单测。
- 抽出 `createTransport()` 后，单测可直接断言「给定配置 → 返回哪种 transport 实例」，成本极低且稳定。
- **被否决项**：只做集成测试（依赖网络/子进程，CI 不稳定）。

#### D6 `/mcp add` 交互新增 http 选项与可选认证头

- 传输类型提示改为 `(stdio/sse/http, 默认 stdio)`；输入 `http` / `streamableHttp` / `streamable-http` 均可。
- 选择 http 后，先问 `URL`，再问**可选**的认证头（一行 `Key: Value`，留空跳过）；多条可后续用配置文件手写。
- **被否决项**：交互里支持任意多行 headers（交互复杂度上升，配置文件已能覆盖）。

#### D7 `/mcp list` 详情按 type 三分支，且 `headers` 脱敏

- 现状二元分支（[mcp-command.ts:L102-L104](file:///d:/trae_workspace/loop-agent-command/src/commands/mcp-command.ts#L102-L104)）在新增类型后会落入 `else` 而丢失类型信息。
- 改为按 `type` 显式分支：`stdio → command + args`；`sse → url（已废弃）`；`streamableHttp → url`。三者若配置了 `headers` 统一追加 `headers: [Authorization, X-API-Key]`（**仅键名**）。
- **被否决项**：直接打印 header 值（可能泄露密钥）。

### 2.3 检索结论（规范与生态）

| 结论 | 来源 |
|---|---|
| Streamable HTTP 自 2025-03-26 规范取代 HTTP+SSE（HTTP POST 发送 + 可选 GET SSE 流接收） | [MCP Spec 2025-03-26 Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) |
| 2026-07-28 规范将 HTTP+SSE 正式标记为 Deprecated（SEP-2596），存量应迁移，新实现不应采用 | [MCP Spec 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) |
| 生态命名：规范名 `streamable-http`；Claude Code 等价接受 `http` 与 `streamable-http`；`headers` 用于 Bearer Token / API Key | [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)、[.mcp.json 配置参考](https://thepromptshelf.dev/blog/mcp-json-configuration-reference-2026/) |
| SDK 已内置 `StreamableHTTPClientTransport`（支持 `requestInit` / `sessionId` / `reconnectionOptions` / `authProvider`） | 本地 `@modelcontextprotocol/sdk@^1.30.0` 类型声明 `dist/esm/client/streamableHttp.d.ts` |

---

## 三、任务详细设计

### 3.1 `client.ts`：类型与传输实例化

```typescript
/** Streamable HTTP 传输配置（Task-20261015-001） */
export interface StreamableHttpConfig {
  type: 'streamableHttp';
  url: string;
  /** 自定义请求头（如 Authorization: Bearer …、X-API-Key） */
  headers?: Record<string, string>;
}

/** MCP server 统一配置 */
export type MCPServerConfig = StdioConfig | SSEConfig | StreamableHttpConfig;

/** 传输类型归一化：接受 streamableHttp / http / streamable-http（大小写不敏感，D1） */
export function normalizeMcpTransportType(raw: string): 'stdio' | 'sse' | 'streamableHttp' | null;

/** 按配置构造 transport（纯函数，便于单测，D5） */
export function createTransport(config: MCPServerConfig): Transport;
```

- `createTransport` 内部分支：
  - `stdio` → `new StdioClientTransport({ command, args, env, cwd, stderr: 'pipe' })`
  - `sse` → `new SSEClientTransport(new URL(config.url))`
  - `streamableHttp` → `new StreamableHTTPClientTransport(new URL(config.url), { requestInit: config.headers ? { headers: config.headers } : undefined })`
- `MCPClient.transport` 字段类型扩为 `StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null`。
- `connect()` 改调用 `createTransport(config)`，其余逻辑（幂等保护、connected 标记）不变。
- `disconnect()` 不变（三类 transport 均实现 `Transport.close()`）。

### 3.2 `mcp-command.ts`：交互与展示

- 交互式添加（[L28-L46](file:///d:/trae_workspace/loop-agent-command/src/commands/mcp-command.ts#L28-L46)）：
  - 提示文案 → `传输类型 (stdio/sse/http, 默认 stdio): `
  - 用 `normalizeMcpTransportType()` 判定；`null` 时报错并取消（错误文案列出全部合法值）。
  - `streamableHttp` 分支：`URL` 必填校验 → 可选 `认证头 (如 Authorization: Bearer xxx，留空跳过): `，非空则按首个 `:` 切分为 `{ [key]: value }`。
- 列表详情（[L102-L104](file:///d:/trae_workspace/loop-agent-command/src/commands/mcp-command.ts#L102-L104)）：按 `type` 三分支渲染，`headers` 仅列键名（D7）。
- `test` / `reload` / `remove` 子命令**无需改动**（走泛型链路）。

### 3.3 导出同步

- [tools/mcp/index.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/index.ts#L4)、[tools/index.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/index.ts#L19) 追加 `StreamableHttpConfig`（以及按需导出 `createTransport` / `normalizeMcpTransportType`）。

### 3.4 边界与错误处理

| 场景 | 行为 |
|---|---|
| `type` 为未知值（如 `ws`） | `normalizeMcpTransportType` 返回 `null` → `/mcp add` 报错取消；加载既有配置时 `createTransport` 抛「不支持的传输类型: xxx」 |
| `streamableHttp` 缺 `url` | `/mcp add` 报「URL 不能为空」取消；配置加载时报明确错误并被失败隔离捕获（不影响其他 server） |
| `url` 非法（非 URL 字符串） | `new URL()` 抛错 → 该 server 记为 failures，其余 server 正常加载 |
| 认证头格式缺 `:` | 交互提示格式错误并取消写入（不写入半成品配置） |
| 服务端返回 401/403 | 由 SDK 抛出，`registerMCPServer` 包装为 `MCP server <name> 连接失败: …`，`/mcp test` 原样展示 |
| 同一 server 配置了 headers 但为 `{}` | 视为未配置，不传 `requestInit` |
| `/mcp list` 展示 | 仅显示 header 键名，绝不回显值 |

### 3.5 演进项（本任务不做）

- `sessionId` 持久化与断线重连策略（SDK `reconnectionOptions` 自定义）。
- OAuth 2.1 授权流（SDK `authProvider` + `finishAuth`）。
- 交互式多行 headers 录入。
- SSE → Streamable HTTP 的一键迁移命令（需端点探测，风险高）。
- 自定义 `fetch`（代理场景）。

---

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | `StreamableHttpConfig` 类型 + `MCPServerConfig` 联合扩展 + `normalizeMcpTransportType` + `createTransport` + `connect()` 接线 + 类型导出 | 代码：配置可直接接入 Streamable HTTP |
| **P1** | `/mcp add` 交互（http 选项 + 认证头）+ `/mcp list` 三分支与脱敏 + 单测（类型归一 / transport 选择 / 未知 type / headers 透传）+ `tsc --noEmit` + 全量回归 | 测试全绿 |
| **P2** | README 双语（特性行、`/mcp` 章节、接入 MCP 章节、配置示例）、优化建议台账置完成、任务文档打勾 | 文档 |

---

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| [src/tools/mcp/client.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/client.ts) | 新增 `StreamableHttpConfig`、`normalizeMcpTransportType`、`createTransport`；扩展 `MCPServerConfig` 与 `transport` 字段类型；`connect()` 改为调用 `createTransport` | P0 |
| [src/tools/mcp/index.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/index.ts) | 补导出 `StreamableHttpConfig`（及可选 `createTransport` / `normalizeMcpTransportType`） | P0 |
| [src/tools/index.ts](file:///d:/trae_workspace/loop-agent-command/src/tools/index.ts) | 同步类型导出 | P0 |
| [src/commands/mcp-command.ts](file:///d:/trae_workspace/loop-agent-command/src/commands/mcp-command.ts) | `interactiveAddMcp` 新增 http 选项与认证头输入；`list` 详情三分支 + headers 脱敏 | P1 |
| `tests/mcp-client-transport.test.ts` | 新增：类型归一化、`createTransport` 三分支选择、未知 type、headers 透传 | P1 |
| [README.md](file:///d:/trae_workspace/loop-agent-command/README.md) / [README.en.md](file:///d:/trae_workspace/loop-agent-command/README.en.md) | 特性行（stdio/SSE → stdio/SSE/Streamable HTTP）、`/mcp` 章节、接入 MCP 章节与配置示例 | P2 |
| [docs/optimization_suggestions/优化建议.md](file:///d:/trae_workspace/loop-agent-command/docs/optimization_suggestions/优化建议.md) | `20261015-001` 收口置完成 | P2 |
| 本文件 | 验收清单打勾 + 完成记录 | P2 |

> 无需改动：`src/config/schema.ts`、`src/config/mcp-manager.ts`、`src/tools/registry.ts`（均泛型透传，不感知传输类型）。

---

## 六、任务验收清单

### P0：类型与传输接线

- [x] 6.1 配置 `{ "type": "streamableHttp", "url": "https://host/mcp" }` 可连接并注册工具（transport 构造已实现并由单测覆盖；真实连通性见 6.13）
- [x] 6.2 `type` 写 `http` / `streamable-http` 亦被识别为同一传输（D1）
- [x] 6.3 `createTransport` 对三种 type 返回对应 transport 实例
- [x] 6.4 `MCPServerConfig` 扩展后编译期穷尽检查通过，既有 stdio/sse 配置行为不变

### P1：交互、展示与测试

- [x] 6.5 `/mcp add` 传输类型可选 `http`，并支持填写可选认证头（交互代码已实现；真机交互见 6.13）
- [x] 6.6 `/mcp list` 正确展示 streamableHttp 的 url，且 headers 仅显示键名（D7）
- [x] 6.7 未知 `type` 在交互时报错取消；加载配置时被失败隔离捕获，不影响其他 server
- [x] 6.8 `headers` 正确透传为 `requestInit.headers`
- [x] 6.9 单测覆盖类型归一/transport 选择/未知 type/headers 透传，全绿（新增 13 例）
- [x] 6.10 `npx tsc --noEmit` 通过 + 全量回归无新增失败（48 文件 / 479 用例全绿）

### P2：文档

- [x] 6.11 README 双语同步（特性行、`/mcp` 章节、接入 MCP 章节、配置示例）
- [x] 6.12 优化建议台账 `20261015-001` 置完成

### 人工验证（真实环境）

- [ ] 6.13 接入一个真实 Streamable HTTP MCP Server（带 Bearer 认证），`/mcp test` 与工具调用成功
- [ ] 6.14 存量 stdio / sse 配置加载与调用无回归

### 完成记录

- 2026-10-15 P0：`client.ts` 新增 `StreamableHttpConfig`、`normalizeMcpTransportType`（归一 `streamableHttp`/`http`/`streamable-http`）、`createTransport`（纯函数三分支）；`MCPServerConfig` 扩展为三成员联合，`MCPClient.transport` 类型改为通用 `Transport`，`connect()` 改为调用 `createTransport`；同步导出至 `tools/mcp/index.ts` 与 `tools/index.ts`。
- 2026-10-15 P1：`mcp-command.ts` 新增 `describeServer`（三分支 + headers 仅列键名脱敏，已导出供单测）；`interactiveAddMcp` 支持 `http` 选项与可选认证头（格式校验 `Key: Value`）；`/mcp list` 改用 `describeServer`。新增 `tests/mcp-client-transport.test.ts` 13 例。`npx tsc --noEmit` 通过，全量回归 48 文件 / 479 用例全绿。
- 2026-10-15 P2：README.md / README.en.md 同步特性行、接入章节（新增「方式四 Streamable HTTP」「方式五 SSE（已废弃）」）、配置示例与 `/mcp add` 说明；优化建议台账 `20261015-001` 置完成。
- 遗留（人工验证）：6.13 真实 Streamable HTTP Server（带 Bearer）连通性与工具调用；6.14 存量 stdio / sse 配置回归。
