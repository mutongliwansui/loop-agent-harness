// API 层错误基础设施：错误码、HTTP 状态映射、可抛异常类型

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'bad_request'
  | 'conflict'
  | 'busy'
  | 'bad_gateway'
  | 'payload_too_large'
  | 'internal';

/** 统一错误码 → HTTP 状态映射 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  bad_request: 400,
  conflict: 409,
  busy: 409,
  bad_gateway: 502,
  payload_too_large: 413,
  internal: 500,
};

/** 携带错误码的 HTTP 异常（处理器直接抛出，统一转 JSON 响应） */
export class ApiHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
