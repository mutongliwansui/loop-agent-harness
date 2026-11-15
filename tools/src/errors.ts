/**
 * 工具错误族。
 *
 * 全部继承 core 的 `CoreError`：它已带稳定 `code` + `pluginName` + `fiberId` +
 * `cause`，自造基类等于重写一遍；且 `instanceof CoreError` 的兜底捕获不会漏掉
 * 工具错误，宿主不必为每个包写分支。
 */

import { CoreError, type CoreErrorOptions } from '@loop-agent/core';

import type { ValidationIssue } from './schema.js';

/** 工具错误基类；code 前缀统一 `TOOLS_` */
export class ToolsError extends CoreError {
  constructor(message: string, opts: CoreErrorOptions = {}) {
    super(message, { code: 'TOOLS_ERROR', ...opts });
    this.name = 'ToolsError';
  }
}

/** 定义 / 配置非法（description 为空、parameters 非 object schema、id 含 `:` 等） */
export class ToolsConfigError extends ToolsError {
  /** 出错的字段名 */
  readonly field?: string;

  constructor(
    message: string,
    opts: Omit<CoreErrorOptions, 'code'> & { field?: string } = {},
  ) {
    const { field, ...rest } = opts;
    super(message, { ...rest, code: 'TOOLS_CONFIG_INVALID' });
    this.name = 'ToolsConfigError';
    this.field = field;
  }
}

/** 工具名不合法（字符集 / 长度 / `__` 前缀） */
export class ToolsInvalidNameError extends ToolsError {
  /** 不合法的名字 */
  readonly toolName: string;
  /** 不合法原因（人读，直接透出给使用者） */
  readonly reason: string;

  constructor(toolName: unknown, reason: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`工具名不合法: '${String(toolName)}' — ${reason}`, {
      ...opts,
      code: 'TOOLS_INVALID_NAME',
    });
    this.name = 'ToolsInvalidNameError';
    this.toolName = String(toolName);
    this.reason = reason;
  }
}

/** 重复 `installTools()`（把 core 的 ServiceConflictError 翻译成人读语义） */
export class ToolsRegistryExistsError extends ToolsError {
  constructor(opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super('tools 已安装，请勿重复调用 installTools()', {
      ...opts,
      code: 'TOOLS_REGISTRY_EXISTS',
    });
    this.name = 'ToolsRegistryExistsError';
  }
}

/** 目录内重名注册 */
export class ToolsDuplicateError extends ToolsError {
  /** 冲突的工具名 */
  readonly toolName: string;
  /** 已存在的提供者 id（若已知） */
  readonly existingProviderId?: string;
  /** 试图注册的提供者 id（若已知） */
  readonly incomingProviderId?: string;

  constructor(
    toolName: string,
    opts: Omit<CoreErrorOptions, 'code'> & {
      existingProviderId?: string;
      incomingProviderId?: string;
    } = {},
  ) {
    const { existingProviderId, incomingProviderId, ...rest } = opts;
    const owner = existingProviderId ? `（已由 '${existingProviderId}' 提供）` : '';
    const incoming = incomingProviderId ? `，来自 '${incomingProviderId}'` : '';
    super(`工具重名: '${toolName}'${owner}${incoming}`, {
      ...rest,
      code: 'TOOLS_DUPLICATE',
    });
    this.name = 'ToolsDuplicateError';
    this.toolName = toolName;
    this.existingProviderId = existingProviderId;
    this.incomingProviderId = incomingProviderId;
  }
}

/** 同 id 提供者重复挂载（服务 key 冲突的语义化翻译） */
export class ToolsProviderExistsError extends ToolsError {
  /** 冲突的提供者 id */
  readonly providerId: string;

  constructor(providerId: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`工具提供者已挂载，请勿重复挂载: '${providerId}'`, {
      ...opts,
      code: 'TOOLS_PROVIDER_EXISTS',
    });
    this.name = 'ToolsProviderExistsError';
    this.providerId = providerId;
  }
}

/** 指定名字的工具未注册 */
export class ToolsNotFoundError extends ToolsError {
  /** 未找到的工具名 */
  readonly toolName: string;

  constructor(toolName: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`工具未注册: '${toolName}'`, { ...opts, code: 'TOOLS_NOT_FOUND' });
    this.name = 'ToolsNotFoundError';
    this.toolName = toolName;
  }
}

/** 参数校验失败（仅作 `invoke()` 内部构造，不外抛） */
export class ToolsArgsInvalidError extends ToolsError {
  /** 目标工具名 */
  readonly toolName: string;
  /** 逐条问题 */
  readonly issues: ValidationIssue[];

  constructor(
    toolName: string,
    issues: ValidationIssue[],
    opts: Omit<CoreErrorOptions, 'code'> = {},
  ) {
    super(`工具 '${toolName}' 参数校验失败（${issues.length} 处问题）`, {
      ...opts,
      code: 'TOOLS_ARGS_INVALID',
    });
    this.name = 'ToolsArgsInvalidError';
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** `getToolRegistry()` 时目录服务未安装 */
export class ToolsRegistryMissingError extends ToolsError {
  /** 缺失的服务 key */
  readonly key: string;

  constructor(key: string, opts: Omit<CoreErrorOptions, 'code'> = {}) {
    super(`未找到 ${key}：请先挂载 installTools()`, {
      ...opts,
      code: 'TOOLS_REGISTRY_MISSING',
    });
    this.name = 'ToolsRegistryMissingError';
    this.key = key;
  }
}

/** `execute()` 抛出的异常被归一后的包装错误（供事件与诊断使用） */
export class ToolsExecError extends ToolsError {
  /** 目标工具名 */
  readonly toolName: string;

  constructor(
    toolName: string,
    message: string,
    opts: Omit<CoreErrorOptions, 'code'> = {},
  ) {
    super(`工具执行失败: ${message}`, { ...opts, code: 'TOOLS_EXEC_FAILED' });
    this.name = 'ToolsExecError';
    this.toolName = toolName;
  }
}
