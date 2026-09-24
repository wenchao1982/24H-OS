/**
 * Hermes 生命周期错误码与错误类。
 *
 * 这些错误码会原样出现在 REST 响应的 ApiError.error 字段，
 * 前端据此区分「需要确认」「CLI 不可用」「参数非法」等情况。
 */
export type LifecycleErrorCode =
  | "CONFIRM_REQUIRED"
  | "HERMES_CLI_UNAVAILABLE"
  | "INVALID_SOURCE"
  | "INVALID_NAME"
  | "COMMAND_NOT_ALLOWED"
  | "COMMAND_FAILED";

/** 生命周期层的统一错误类型，携带稳定的错误码。 */
export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

/** 便捷构造。 */
export function lifecycleError(
  code: LifecycleErrorCode,
  message: string,
): LifecycleError {
  return new LifecycleError(code, message);
}

/** 该错误对应的 HTTP 状态码（供路由层映射）。 */
export function statusForCode(code: LifecycleErrorCode): number {
  switch (code) {
    case "CONFIRM_REQUIRED":
    case "INVALID_SOURCE":
    case "INVALID_NAME":
    case "COMMAND_NOT_ALLOWED":
      return 400;
    case "HERMES_CLI_UNAVAILABLE":
      return 503;
    case "COMMAND_FAILED":
      return 502;
    default:
      return 500;
  }
}
