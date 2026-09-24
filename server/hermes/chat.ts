import type { ChatStreamEvent } from "@shared/types";
import { detectHermes } from "./detect";
import { lifecycleError } from "./errors";
import {
  ensureGateway,
  type CreateSessionParams,
  type GatewayClient,
  type GatewayServerRequest,
} from "./gateway";

/**
 * Gateway 会话 + 流式对话（M5.2）。
 *
 * `streamPrompt` 串起：`session.create` → `prompt.submit` → 订阅事件/服务端请求 →
 * 把 gateway 原始帧归一化为稳定事件（见 `@shared/types` 的 ChatStreamEvent），
 * 供 SSE 路由 / Skill UI 透传。
 *
 * 契约来源（只读参考，未修改）：
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/sessions.py
 *     session.create / session.interrupt / session.close
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/prompt_voice.py
 *     prompt.submit
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/events.py
 *     message.start / message.delta / message.interim / message.complete /
 *     reasoning.delta / thinking.delta / tool.start / tool.complete / error …
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/server_requests.py
 *     approval（choice: once/session/always/deny）/ clarify
 *
 * 审批策略（安全默认）：approval 回 `deny`、clarify 回空答案（跳过）；
 * 仅当 `OS_GATEWAY_AUTO_APPROVE=1`（或 options.autoApprove）时 approval 回 `once`、
 * clarify 回第一个选项。无论决策如何，事件都先透出给 onEvent。
 */

/** 自动放行的环境变量：`OS_GATEWAY_AUTO_APPROVE=1`。 */
export const AUTO_APPROVE_ENV = "OS_GATEWAY_AUTO_APPROVE";

/** 归一化到 `session` 类型的 gateway 事件名（生命周期/信息类）。 */
const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.start",
  "session.info",
  "session.title",
  "session.usage",
  "session.control.update",
  "session.reclaimed",
  "session.resume_progress",
  "status.update",
  "notice",
  "reaction",
  "todo.updated",
  "gateway.ready",
  "skin.changed",
]);

/** 安全判定为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取字符串字段，非法回退 undefined。 */
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 取字符串数组字段，非法回退 undefined。 */
function strArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/** 是否启用自动放行（默认 deny）。 */
export function isAutoApprove(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTO_APPROVE_ENV] === "1";
}

/**
 * 把 gateway 事件通知（`method:"event"` 的 params）归一化为 ChatStreamEvent。
 * 未知类型原样透出为 `{ type: "raw", raw }`。
 */
export function normalizeGatewayEvent(
  params: Record<string, unknown>,
): ChatStreamEvent {
  const type = str(params.type) ?? "";
  const sessionId = str(params.session_id);
  const payload = isRecord(params.payload) ? params.payload : {};

  switch (type) {
    case "message.delta":
      return { type: "delta", sessionId, text: str(payload.text) ?? "" };

    case "message.interim":
      return {
        type: "message",
        sessionId,
        text: str(payload.text) ?? "",
        interim: true,
      };

    case "reasoning.delta":
    case "reasoning.available":
    case "thinking.delta":
      return { type: "thinking", sessionId, text: str(payload.text) ?? "" };

    case "message.complete":
      return {
        type: "done",
        sessionId,
        text: typeof payload.text === "string" ? payload.text : "",
        status: str(payload.status),
        usage: payload.usage,
        reason: str(payload.error) ?? str(payload.failure_reason),
      };

    case "tool.start":
      return {
        type: "tool.start",
        sessionId,
        toolId: str(payload.tool_id),
        name: str(payload.name),
        args: payload.args,
        summary: str(payload.preview),
      };

    case "tool.complete":
      return {
        type: "tool.complete",
        sessionId,
        toolId: str(payload.tool_id),
        name: str(payload.name),
        args: payload.args,
        summary: str(payload.summary),
        result: payload.result,
      };

    case "error":
      return {
        type: "error",
        sessionId,
        message: str(payload.message) ?? "gateway 会话错误",
      };

    default:
      if (SESSION_EVENT_TYPES.has(type)) {
        return { type: "session", sessionId, event: type, payload };
      }
      return { type: "raw", sessionId, raw: params };
  }
}

/**
 * 把服务端→客户端请求（approval / clarify 等）归一化为 ChatStreamEvent。
 * 未知方法原样透出为 `{ type: "raw", raw: { id, method, params } }`。
 */
export function normalizeGatewayRequest(
  request: GatewayServerRequest,
): ChatStreamEvent {
  const sessionId = str(request.params.session_id);
  switch (request.method) {
    case "approval":
      return {
        type: "approval",
        sessionId,
        requestId: request.id,
        command: str(request.params.command),
        description: str(request.params.description),
        choices: strArray(request.params.choices),
        name: str(request.params.tool_name),
      };
    case "clarify":
      return {
        type: "clarify",
        sessionId,
        requestId: request.id,
        question: str(request.params.question),
        choices: strArray(request.params.choices),
      };
    default:
      return {
        type: "raw",
        sessionId,
        raw: { id: request.id, method: request.method, params: request.params },
      };
  }
}

/** streamPrompt 依赖注入与选项。 */
export interface StreamPromptOptions {
  /** 用户输入（必填）。 */
  prompt: string;
  /** 目标 profile（透传 session.create）。 */
  profile?: string;
  /** 外部取消信号：触发时中断并结束流。 */
  signal?: AbortSignal;
  /** 每个归一化事件的回调。 */
  onEvent?: (event: ChatStreamEvent) => void;
  /** 注入已连接的客户端（测试用）；缺省走 resolveClient / 自动探测。 */
  client?: GatewayClient;
  /** 解析客户端；默认 detectHermes + ensureGateway。 */
  resolveClient?: () => Promise<GatewayClient>;
  /** 透传给 session.create 的额外参数。 */
  sessionParams?: CreateSessionParams;
  /** 审批策略；默认读 OS_GATEWAY_AUTO_APPROVE。 */
  autoApprove?: boolean;
  /** 整体超时（毫秒），默认 300000。 */
  timeoutMs?: number;
  /** 结束时是否关闭会话（默认 true）。 */
  closeOnFinish?: boolean;
}

/** 流式对话的结束摘要。 */
export interface ChatStreamResult {
  sessionId: string;
  status: "done" | "interrupted" | "error";
}

/** 默认客户端解析：探测 CLI 并复用进程内单例 gateway。 */
async function defaultResolveClient(): Promise<GatewayClient> {
  const detection = await detectHermes();
  if (!detection.cliPath) {
    throw lifecycleError("GATEWAY_UNAVAILABLE", "未检测到可用的 hermes CLI。");
  }
  const entry = await ensureGateway(detection.cliPath);
  return entry.client;
}

/**
 * 运行一次流式对话，直到 `message.complete`（done）/ `error` / 取消 / 超时。
 *
 * 在事件与服务端请求到达时调用 onEvent；审批/澄清按安全默认自动回应。
 * 会话创建失败抛结构化错误；流内 `error` 事件不作为异常抛出（已透出）。
 */
export async function streamPrompt(
  options: StreamPromptOptions,
): Promise<ChatStreamResult> {
  const prompt = typeof options.prompt === "string" ? options.prompt : "";
  if (prompt.trim() === "") {
    throw lifecycleError("INVALID_VALUE", "prompt 不能为空。");
  }

  const autoApprove = options.autoApprove ?? isAutoApprove();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const client = options.client ?? (await (options.resolveClient ?? defaultResolveClient)());

  const created = await client.createSession({
    profile: options.profile,
    ...(options.sessionParams ?? {}),
  });
  const sessionId = created?.session_id;
  if (!sessionId) {
    throw lifecycleError("GATEWAY_RPC_ERROR", "session.create 未返回 session_id。");
  }

  let settled = false;
  let resolveDone!: (result: ChatStreamResult) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<ChatStreamResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const emit = (event: ChatStreamEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // 订阅者异常不影响流。
    }
  };

  const finish = (result: ChatStreamResult): void => {
    if (settled) return;
    settled = true;
    resolveDone(result);
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectDone(error);
  };

  const belongsToSession = (sid: unknown): boolean =>
    typeof sid !== "string" || sid === "" || sid === sessionId;

  const offEvent = client.onEvent((params) => {
    if (!belongsToSession(params.session_id)) return;
    const event = normalizeGatewayEvent(params);
    emit(event);
    if (event.type === "done") finish({ sessionId, status: "done" });
    else if (event.type === "error") finish({ sessionId, status: "error" });
  });

  const offRequest = client.onRequest((request) => {
    if (!belongsToSession(request.params.session_id)) return;
    emit(normalizeGatewayRequest(request));

    if (request.method === "approval") {
      client.respond(request.id, { choice: autoApprove ? "once" : "deny" });
      return;
    }
    if (request.method === "clarify") {
      const choices = strArray(request.params.choices) ?? [];
      const answer = autoApprove && choices.length > 0 ? choices[0] : "";
      client.respond(request.id, { answer });
      return;
    }
    // 其他单值提问（sudo / secret 等）：安全默认回空（跳过/拒绝）。
    client.respond(request.id, { value: "" });
  });

  const interruptSession = (): void => {
    void client.interrupt(sessionId).catch(() => undefined);
  };

  const onAbort = (): void => {
    interruptSession();
    finish({ sessionId, status: "interrupted" });
  };

  const timer = setTimeout(() => {
    fail(
      lifecycleError(
        "GATEWAY_TIMEOUT",
        `chat 流超时（>${timeoutMs}ms），已中断会话。`,
      ),
    );
    interruptSession();
  }, timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    if (!settled) {
      await client.submitPrompt(sessionId, prompt);
    }
    return await done;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    offEvent();
    offRequest();
    if (options.closeOnFinish !== false) {
      try {
        await client.closeSession(sessionId);
      } catch {
        // 会话可能已被中断/回收，忽略关闭失败。
      }
    }
  }
}
