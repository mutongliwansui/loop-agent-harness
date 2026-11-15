/**
 * `@loop-agent/tools` 唯一对外导出面。
 *
 * 分层判据（四包口径必须一致）：
 * - `core`  管机制：插件长什么样、怎么挂、怎么撤
 * - `main`  管装配：挂哪些、什么顺序、启停、存哪、重启还原
 * - `llm`   管契约：一个大模型服务商该提供什么、怎么被继承、能力怎么声明
 * - `tools` 管契约：**一个工具**该提供什么、怎么被继承、参数与失败怎么归一
 * - 实现管具体：内置工具、MCP 适配、输出治理、权限门禁（非本包）
 *
 * 一句话：**core 管机制，main 管装配，llm 管模型契约，tools 管工具契约，实现管具体。**
 */

// ── 领域类型（D2：本包自持，不依赖 llm）──
export type {
  JsonSchema,
  ToolDefView,
  ToolInvokeContext,
  ToolResult,
  ToolSpec,
} from './types.js';
export { DEFAULT_TOOL_TIMEOUT_MS } from './types.js';

// ── 行为声明与展示元信息（D9：对齐 MCP ToolAnnotations）──
export type { ToolAnnotations, ToolDisplay } from './annotations.js';
export { DEFAULT_TOOL_ANNOTATIONS, resolveAnnotations } from './annotations.js';

// ── 参数校验与规范化（D7/D12）──
export type { ToolNameCheck, ValidationIssue } from './schema.js';
export {
  canonicalize,
  formatIssues,
  validateArgs,
  validateDescription,
  validateParametersSchema,
  validateToolName,
} from './schema.js';

// ── 工具契约（抽象基类）──
export { ToolBase, failWith, okResult } from './tool.js';
export type { InvokeOptions } from './tool.js';

// ── 提供者契约（抽象基类）──
export { ToolProvider } from './provider.js';

// ── 编译成插件 ──
export { defineTools, defineToolsFactory, mergeToolsOptions } from './define.js';
export type { ToolsDefinition, ToolsSource, ToolProviderFacade } from './define.js';

// ── 目录服务与安装器 ──
export {
  createToolRegistry,
  getToolRegistry,
  installTools,
} from './registry.js';
export type { RegisterOptions, ToolRegistry } from './registry.js';

// ── 服务 key ──
export { TOOLS_SERVICE_KEYS, providerServiceKey } from './keys.js';

// ── 错误族 ──
export {
  ToolsArgsInvalidError,
  ToolsConfigError,
  ToolsDuplicateError,
  ToolsError,
  ToolsExecError,
  ToolsInvalidNameError,
  ToolsNotFoundError,
  ToolsProviderExistsError,
  ToolsRegistryExistsError,
  ToolsRegistryMissingError,
} from './errors.js';

// ── 事件表与载荷 ──
export type {
  ToolErrorPayload,
  ToolInvokePayload,
  ToolRegisteredPayload,
  ToolResultPayload,
  ToolsEvents,
  ToolUnregisteredPayload,
} from './events.js';
