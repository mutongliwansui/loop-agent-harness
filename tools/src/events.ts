/**
 * tools 事件表。
 *
 * **必须 `extends EventMapBase`**：`EventMapBase` 带字符串索引签名，
 * `interface` 不会隐式获得它；否则消费方写 `Plugin<ToolsEvents>` 会报 TS2344
 * （core 实施期的实测教训，llm 同口径）。
 *
 * 事件**只读**：监听器不得改变调用语义，抛错也不应中断调用链。
 */

import type { EventMapBase } from '@loop-agent/core';

import type { ToolsError } from './errors.js';
import type { ToolResult } from './types.js';

/** 工具注册成功 */
export interface ToolRegisteredPayload {
  name: string;
  /** 来源提供者 id；直接向目录注册时为 undefined */
  providerId?: string;
}

/** 工具注销 */
export interface ToolUnregisteredPayload {
  name: string;
  providerId?: string;
}

/** 一次调用即将开始 */
export interface ToolInvokePayload {
  name: string;
  args: Record<string, unknown>;
}

/** 一次调用结束（成功或失败均发） */
export interface ToolResultPayload {
  name: string;
  result: ToolResult;
  /** 耗时（毫秒） */
  elapsedMs: number;
}

/** 一次调用发生错误（与 `tools/result` 互补：后者总有，本事件仅失败时发） */
export interface ToolErrorPayload {
  name: string;
  error: ToolsError;
}

/** tools 事件表 */
export interface ToolsEvents extends EventMapBase {
  'tools/registered': (payload: ToolRegisteredPayload) => void;
  'tools/unregistered': (payload: ToolUnregisteredPayload) => void;
  'tools/invoke': (payload: ToolInvokePayload) => void;
  'tools/result': (payload: ToolResultPayload) => void;
  'tools/error': (payload: ToolErrorPayload) => void;
}
