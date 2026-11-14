/**
 * `@loop-agent/core` 唯一对外导出面。
 *
 * 只导出公开契约；内部实现（disposer 栈、host 序号、隔离域结构、收敛循环等）
 * 不导出，以免使用方依赖到「本可自由重构」的细节。
 */

// ── 类型 ──
export type {
  Disposer,
  Inject,
  Plugin,
  PluginFunction,
  PluginObject,
  PluginOptions,
  FiberState,
  EventMapBase,
  DiagnosticReport,
} from './types.js';

// ── Fiber ──
export type { Fiber } from './fiber.js';

// ── Context ──
export type { Context, CoreHost, IsolationScope } from './context.js';
export { createRootContext, createHost } from './context.js';

// ── 插件清单挂载 ──
// 宿主层职责（挂载哪些插件、顺序、启停、持久化）不在内核范围，
// 见 @loop-agent/main 的 PersistentPluginRegistry。
// 内核只提供建装能力：createHost() + createRootContext() + ctx.plugin()。

// ── 服务与事件 ──
export { ServiceRegistry } from './service.js';
export type { ServiceEntry } from './service.js';
export { TypedEventBus } from './events.js';
export type { ListenerErrorRecord } from './events.js';

// ── 错误族（6 类）──
export {
  CoreError,
  CircularDependencyError,
  ServiceNotFoundError,
  ServiceConflictError,
  PluginLoadError,
  FiberDisposedError,
} from './errors.js';
export type { CoreErrorOptions } from './errors.js';
