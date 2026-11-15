/**
 * llm 错误族。
 *
 * 全部继承 core 的 `CoreError`，理由：
 * - `CoreError` 已带稳定 `code` + `pluginName` + `fiberId` + `cause`，
 *   这些字段在日志、HTTP 状态映射、跨进程边界都需要，自造基类等于重写一遍；
 * - `instanceof CoreError` 的兜底捕获不会漏掉 llm 错误；独立 `Error` 基类
 *   会让宿主统一错误处理分裂成两套。
 *
 * 子类划分沿用 `src/llm/client.ts` 的既有语义（401/403 明确不重试、
 * 429 交上层退避、abort 短路），保证将来默认实现能平移。
 */

import { CoreError, type CoreErrorOptions } from '@loop-agent/core';

/** llm 错误基类；code 前缀统一 `LLM_` */
export class LlmError extends CoreError {
  constructor(message: string, opts: CoreErrorOptions = {}) {
    super(message, { code: 'LLM_ERROR', ...opts });
    this.name = 'LlmError';
  }
}

/** 定义校验失败、options 非法等配置类错误；重试无意义 */
export class LlmConfigError extends LlmError {
  constructor(message: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(message, { ...opts, code: 'LLM_CONFIG_INVALID' });
    this.name = 'LlmConfigError';
  }
}

/** 指定 id 的 provider 未注册 */
export class LlmProviderNotFoundError extends LlmError {
  /** 未找到的 provider id */
  readonly providerId: string;

  constructor(providerId: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`大模型 provider 未注册: ${providerId}`, { ...opts, code: 'LLM_PROVIDER_NOT_FOUND' });
    this.name = 'LlmProviderNotFoundError';
    this.providerId = providerId;
  }
}

/** 同一 id 重复注册 */
export class LlmProviderConflictError extends LlmError {
  /** 冲突的 provider id */
  readonly providerId: string;

  constructor(providerId: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`大模型 provider 重复注册: ${providerId}`, { ...opts, code: 'LLM_PROVIDER_CONFLICT' });
    this.name = 'LlmProviderConflictError';
    this.providerId = providerId;
  }
}

/** 请求超出 provider 声明的能力；应换 provider 而非重试 */
export class LlmCapabilityError extends LlmError {
  /** 违反的能力位名，如 'toolCalling' */
  readonly capability: string;
  /** 出错的 provider id */
  readonly providerId: string;

  constructor(
    providerId: string,
    capability: string,
    message: string,
    opts: Omit<CoreErrorOptions, 'code'> = {},
  ) {
    super(message, { ...opts, code: 'LLM_CAPABILITY_UNSUPPORTED' });
    this.name = 'LlmCapabilityError';
    this.providerId = providerId;
    this.capability = capability;
  }
}

/** 鉴权失败（401/403）；重试无意义 */
export class LlmAuthError extends LlmError {
  constructor(message: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(message, { ...opts, code: 'LLM_AUTH_FAILED' });
    this.name = 'LlmAuthError';
  }
}

/** 限流（429）；交上层退避后重试 */
export class LlmRateLimitError extends LlmError {
  /** 服务商建议的重试等待毫秒数（若有） */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: Omit<CoreErrorOptions, 'code'> & { retryAfterMs?: number } = {},
  ) {
    const { retryAfterMs, ...rest } = opts;
    super(message, { ...rest, code: 'LLM_RATE_LIMIT' });
    this.name = 'LlmRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 其余服务商侧请求错误 */
export class LlmRequestError extends LlmError {
  /** 上游 HTTP 状态码（若有） */
  readonly status?: number;

  constructor(
    message: string,
    opts: Omit<CoreErrorOptions, 'code'> & { status?: number } = {},
  ) {
    const { status, ...rest } = opts;
    super(message, { ...rest, code: 'LLM_REQUEST_FAILED' });
    this.name = 'LlmRequestError';
    this.status = status;
  }
}

/** 请求被中止；短路处理，不重试 */
export class LlmAbortedError extends LlmError {
  constructor(message = '大模型调用已被中止', opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(message, { ...opts, code: 'LLM_ABORTED' });
    this.name = 'LlmAbortedError';
  }
}

/**
 * 把任意抛出物归一为 `LlmError`。
 *
 * 已是 `LlmError` 的原样返回（保留其精确 code 与自定义字段）；
 * 否则包一层，原错误挂 `cause`，调用方补 `pluginName` / `fiberId`。
 */
export function normalizeLlmError(
  err: unknown,
  context: { message?: string } & Omit<CoreErrorOptions, 'code'> = {},
): LlmError {
  if (err instanceof LlmError) return err;
  const { message, ...rest } = context;
  const detail = err instanceof Error ? err.message : String(err);
  return new LlmError(message ? `${message}: ${detail}` : detail, { ...rest, cause: err });
}
