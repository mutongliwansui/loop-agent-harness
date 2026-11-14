/**
 * 内核错误族。
 *
 * 全部错误都带稳定 `code`：即便在 workspaces 方案下单副本已成常态、
 * `instanceof` 可靠，`code` 在日志、HTTP 状态码映射、跨进程（HTTP 边界）
 * 场景下本就必需，成本为零。
 */

/** `CoreError` 构造参数 */
export interface CoreErrorOptions {
  /** 稳定错误码，默认 'CORE_ERROR' */
  code?: string;
  /** 出错插件名（若已知） */
  pluginName?: string;
  /** 出错 Fiber id（若已知） */
  fiberId?: string;
  /** 原始错误，会被挂到 Error.cause */
  cause?: unknown;
}

/** 内核错误基类：全部内核错误的共同父类，便于跨模块 instanceof 判别 */
export class CoreError extends Error {
  /** 稳定错误码，供日志 / HTTP 状态映射使用（跨进程边界也可靠） */
  readonly code: string;

  /** 出错插件名（若已知） */
  readonly pluginName?: string;

  /** 出错 Fiber id（若已知） */
  readonly fiberId?: string;

  constructor(message: string, opts: CoreErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CoreError';
    this.code = opts.code ?? 'CORE_ERROR';
    this.pluginName = opts.pluginName;
    this.fiberId = opts.fiberId;
  }
}

/** A ↔ B 互相硬依赖，或依赖链成环 */
export class CircularDependencyError extends CoreError {
  constructor(message: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(message, { ...opts, code: 'CORE_CIRCULAR_DEP' });
    this.name = 'CircularDependencyError';
  }
}

/** 强制取服务但无人提供 */
export class ServiceNotFoundError extends CoreError {
  /** 缺失的服务 key */
  readonly key: string;

  constructor(key: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`服务未提供: ${key}`, { ...opts, code: 'CORE_SERVICE_MISSING' });
    this.name = 'ServiceNotFoundError';
    this.key = key;
  }
}

/** 同一 key 被两个 ACTIVE Fiber 同时提供 */
export class ServiceConflictError extends CoreError {
  /** 冲突的服务 key */
  readonly key: string;

  constructor(key: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`服务已被其他 Fiber 提供: ${key}`, { ...opts, code: 'CORE_SERVICE_CONFLICT' });
    this.name = 'ServiceConflictError';
    this.key = key;
  }
}

/** 插件 `apply` 抛错（包装原 error + 栈） */
export class PluginLoadError extends CoreError {
  constructor(message: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(message, { ...opts, code: 'CORE_PLUGIN_LOAD' });
    this.name = 'PluginLoadError';
  }
}

/** 在已 DISPOSED 的 ctx 上注册 */
export class FiberDisposedError extends CoreError {
  constructor(message = 'Fiber 已卸载，无法继续注册', opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(message, { ...opts, code: 'CORE_FIBER_DISPOSED' });
    this.name = 'FiberDisposedError';
  }
}
