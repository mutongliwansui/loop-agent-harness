/**
 * `@loop-agent/llm` 唯一对外导出面。
 *
 * 分层判据（三包口径必须一致）：
 * - `core` 管机制：插件长什么样、怎么挂、怎么撤
 * - `main` 管装配：挂哪些、什么顺序、启停、存哪、重启还原
 * - `llm`  管契约：一个大模型服务商该提供什么、怎么被继承、能力怎么声明
 * - 实现管具体：OpenAI 兼容实现、重试/限流/路由（非本包）
 *
 * 一句话：**core 管机制，main 管装配，llm 管契约，实现管具体。**
 */

// ── 领域类型（D1：本包自持，协议无关）──
export type {
  LlmContentPart,
  LlmMessage,
  LlmToolDef,
  LlmToolCall,
  LlmUsage,
  LlmFinishReason,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from './types.js';

// ── 能力协商 ──
export type { LlmCapabilities, CapabilityViolation } from './capabilities.js';
export {
  defaultCapabilities,
  checkRequestCapabilities,
  assertRequestCapabilities,
} from './capabilities.js';

// ── provider 契约（抽象基类）──
export { LlmProvider } from './provider.js';
export type { LlmCallOptions, LlmCallHooks } from './provider.js';

// ── 编译成插件 ──
export { defineLlmProvider, defineLlmProviderFactory, mergeProviderOptions } from './define.js';
export type { LlmProviderDefinition } from './define.js';

// ── 目录服务与安装器 ──
export { installLlm, getLlmRegistry, createLlmRegistry, providerServiceKey } from './registry.js';
export type { LlmRegistry, LlmProviderInfo } from './registry.js';

// ── 服务 key ──
export { LLM_SERVICE_KEYS } from './keys.js';

// ── 错误族 ──
export {
  LlmError,
  LlmConfigError,
  LlmProviderNotFoundError,
  LlmProviderConflictError,
  LlmCapabilityError,
  LlmAuthError,
  LlmRateLimitError,
  LlmRequestError,
  LlmAbortedError,
  normalizeLlmError,
} from './errors.js';

// ── 事件表与载荷 ──
export type {
  LlmEvents,
  LlmProviderRegisteredPayload,
  LlmProviderUnregisteredPayload,
  LlmRequestPayload,
  LlmResponsePayload,
  LlmErrorPayload,
} from './events.js';
