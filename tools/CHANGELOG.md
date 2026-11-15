# Changelog

本包遵循语义化版本。变更按需求编号 / 任务编号归档。

## 0.1.0 — 2026-11-14

初始契约（需求 20261114-006，任务 20261114-006）。

### 新增

- **`ToolBase` 抽象基类**：必实现项只有构造参数（`ToolSpec`）与 `protected execute()`；`invoke()` 为模板方法，固化「取消检查 → 参数形状检查 → JSON Schema 校验 → `execute()` → 结果归一」四步，任一步失败均返回 `isError: true` 的 `ToolResult` 而不向上抛。辅助函数 `okResult()` / `failWith()`。
- **`ToolProvider` 抽象基类**：「一个插件提供 N 个工具」的成组契约；`create(options)` 允许异步（MCP 需握手），`onDispose()` 为 `protected`、由框架经 `dispose()` 触发。
- **领域类型**（本包自持、不依赖 `@loop-agent/llm`）：`JsonSchema` / `ToolSpec` / `ToolInvokeContext` / `ToolResult` / `ToolDefView`，以及常量 `DEFAULT_TOOL_TIMEOUT_MS`（30_000）。
- **行为声明**：`ToolAnnotations` 对齐 MCP 四个 hint，`DEFAULT_TOOL_ANNOTATIONS` 取悲观默认（`readOnlyHint=false` / `destructiveHint=true` / `idempotentHint=false` / `openWorldHint=true`），`resolveAnnotations()` 只补未声明字段、不覆盖显式 `false`。
- **参数校验（手写子集，零三方依赖）**：`validateArgs()` 支持 type / properties / required / items / enum / minimum / maximum / minLength / maxLength / pattern / additionalProperties，超出子集的关键字宽松跳过；`formatIssues()` 渲染人读文本；`validateToolName()` / `validateParametersSchema()` / `validateDescription()` 供注册期同步校验。
- **`canonicalize()`**：递归键序规范化，让等价 schema 产出逐字节相同序列化结果，保住 provider 前缀缓存不变量。
- **插件编译器（双导出）**：`defineTools()`（直接得插件对象）与 `defineToolsFactory()`（得工厂，接收 main 清单 `options`）。两者共用同一构建体，`options` 浅合并（清单侧优先）；`mergeToolsOptions()` 导出同一合并逻辑供测试引用。
- **目录服务**：`ToolRegistry`（`list` / `names` / `get` / `require` / `count` / `listByProvider` / `register` / `registerAll` / `invoke` / `toToolDefs` / `on`）与 `createToolRegistry()`。`registerAll()` 先全量校验、全部通过才落登记，返回的 `Disposer` 逆序撤销整批。
- **安装器**：`installTools()` 提供 `tools:registry`，重复安装翻译为 `TOOLS_REGISTRY_EXISTS`；`getToolRegistry()` 未装时抛 `TOOLS_REGISTRY_MISSING`。
- **服务 key**：`TOOLS_SERVICE_KEYS`（`tools:registry` + `tools:provider:` 前缀）与 `providerServiceKey()`。
- **错误族 10 类**：均继承 `CoreError`，`code` 前缀 `TOOLS_`。`ToolsInvalidNameError` 携带 `toolName` / `reason`，`ToolsDuplicateError` 携带冲突双方 `providerId`，`ToolsConfigError` 携带 `field`。
- **事件表 5 个**：`tools/registered` / `tools/unregistered` / `tools/invoke` / `tools/result` / `tools/error`，只读观测，监听器故障不影响业务调用。

### 设计要点

- 只依赖 `@loop-agent/core`，零三方运行时依赖；单 ESM 产物（3 个文件：`index.js` / `index.js.map` / `index.d.ts`）。
- 与 `llm` **平级**而非从属：`tools → llm` 会把两条正交的轴捆成 `tools → llm → core` 三层链。`ToolDefView` 与 `LlmToolDef` 字段一字等价，宿主适配是一行 map。
- 每提供者独占 `tools:provider:<id>`：core 的 `provide()` 遇重复 key 抛冲突且不覆盖，单 key 存 Map 会丢掉归属追踪与自动撤销。
- `tools:registry` 由 `defineTools()` 无条件注入为硬依赖：目录未就绪时 Fiber 停在 `PENDING`，`apply` 不执行，杜绝「提供者抢跑后找不到目录」。
- 事件不走 core 的 `host.bus`（`Context` 只暴露 `on`、无 `emit`），由 registry 自带发射器，便于脱离 core 单独测试。
- 工具名取 `^[A-Za-z0-9_-]{1,64}$` 且禁 `__` 前缀：64 是 OpenAI / Bedrock / Gemini 的最低公共上限，`__` 永久保留给 MCP 适配器的 `server__tool` 命名空间。
- `parameters` 强制显式 `type: 'object'`：缺 `type` 在 OpenAI 严格模式与 Bedrock 会被直接拒，错误暴露在挂载期而非每轮请求 400。
- `annotations` 只是 hint、不构成权限：本包只声明不强制，权限门禁归宿主。

### 测试

`vitest run` 9 个文件 209 用例 + `tsc --noEmit` 覆盖的纯类型断言（`types.test-d.ts`）。含边界回归：源码纯净性、零反向依赖、单 ESM 产物、依赖单副本、外部消费（真起子进程走 exports）。

### 不含

具体工具实现、MCP 适配层、输出治理、权限门禁、超时执行、`ToolDisplay` 的 WebUI 接入、`src/tools/` 迁移。
