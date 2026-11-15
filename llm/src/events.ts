/**
 * llm 事件表。
 *
 * **必须 `extends EventMapBase`**：`EventMapBase` 带字符串索引签名，
 * `interface` 不会隐式获得它；否则消费方写 `Plugin<LlmEvents>` 会报 `TS2344`
 * （这是 core 实施期的实测教训）。
 *
 * 副作用须知：该索引签名会让 `keyof E & string` 退化为 `string`，
 * 即**未声明的事件名不会被 TS 拒绝**。收益只是「已声明的名字有精确签名」，
 * 并非穷举保护。
 *
 * 事件**只读**：监听器不得改变调用语义，抛错也不应中断调用链。
 */

import type { EventMapBase } from '@loop-agent/core';

import type { LlmError } from './errors.js';
import type { LlmRequest, LlmResponse } from './types.js';

/** 已注册 provider 的摘要 */
export interface LlmProviderRegisteredPayload {
  providerId: string;
  displayName: string;
}

/** 已注销 provider 的摘要 */
export interface LlmProviderUnregisteredPayload {
  providerId: string;
}

/** 一次请求即将发出 */
export interface LlmRequestPayload {
  providerId: string;
  request: LlmRequest;
}

/** 一次请求成功返回 */
export interface LlmResponsePayload {
  providerId: string;
  response: LlmResponse;
  /** 耗时（毫秒） */
  elapsedMs: number;
}

/** 一次请求失败 */
export interface LlmErrorPayload {
  providerId: string;
  error: LlmError;
}

/** llm 事件表 */
export interface LlmEvents extends EventMapBase {
  'llm/registered': (payload: LlmProviderRegisteredPayload) => void;
  'llm/unregistered': (payload: LlmProviderUnregisteredPayload) => void;
  'llm/request': (payload: LlmRequestPayload) => void;
  'llm/response': (payload: LlmResponsePayload) => void;
  'llm/error': (payload: LlmErrorPayload) => void;
}
