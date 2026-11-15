# Changelog

本包遵循语义化版本。变更按需求编号 / 任务编号归档。

## 0.1.0 — 2026-11-14

初始契约（需求 20261114-005）。

### 新增

- **`LlmProvider` 抽象基类**：必实现项只有 `id` + `complete()`；`displayName` / `capabilities()` / `stream()` / `onDispose()` 均有默认实现。
- **领域类型**（协议无关、camelCase、本包自持）：`LlmMessage` / `LlmContentPart` / `LlmToolDef` / `LlmToolCall` / `LlmUsage` / `LlmRequest` / `LlmResponse` / `LlmStreamEvent`。
- **能力协商**：`LlmCapabilities` 具名能力位、`checkRequestCapabilities()`（返回全部违例）、`assertRequestCapabilities()`（抛 `LlmCapabilityError`）。默认全 `false`；超能力在调用前拒绝，不发请求。
- **插件编译器（双导出）**：`defineLlmProvider()`（直接得插件对象）与 `defineLlmProviderFactory()`（得工厂，接收 main 清单 `options`）。两者共用同一构建体，`options` 做浅合并（清单侧优先）。
- **目录服务**：`LlmRegistry`（`list` / `get` / `require` / `defaultProvider` / `setDefault` / `complete` / `stream` / `register` / `on`）与 `createLlmRegistry()`。
- **安装器**：`installLlm()` 提供 `llm:registry`；重复安装翻译为 `LLM_REGISTRY_EXISTS` 并给可读提示。`getLlmRegistry()` 便捷取值。
- **服务 key**：`LLM_SERVICE_KEYS`（`llm:registry` + `llm:provider:<id>` 前缀）与 `providerServiceKey()`。
- **错误族 9 类**：均继承 `CoreError`；含 `normalizeLlmError()` 归一工具。
- **事件表 5 个**：`llm/registered` / `llm/unregistered` / `llm/request` / `llm/response` / `llm/error`，只读观测，监听器故障不影响业务调用。

### 设计要点

- 只依赖 `@loop-agent/core`，零三方运行时依赖；单 ESM 产物（3 个文件）。
- provider 对 `llm:registry` 声明**硬依赖**：目录未就绪时 Fiber 停在 `PENDING`，`apply` 不执行。
- 每 provider 独占 `llm:provider:<id>`：core 的 `provide()` 遇重复 key 抛冲突且不覆盖，单 key 存 Map 会丢掉归属追踪与自动撤销。
- 事件不走 core 的 `host.bus`（`Context` 只暴露 `on`、无 `emit`），由 registry 自带发射器，便于脱离 core 单独测试。

### 不含

具体服务商实现、中间件链（重试/限流/预算/路由）、`completeVision?`、`src/` 接入。
