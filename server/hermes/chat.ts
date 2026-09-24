import { randomUUID } from "node:crypto";
import type { ApprovalChoiceValue, ChatStreamEvent } from "@shared/types";
import { detectHermes } from "./detect";
import { lifecycleError } from "./errors";
import {
  ensureGateway,
  type CreateSessionParams,
  type GatewayClient,
  type GatewayServerRequest,
} from "./gateway";

/**
 * Gateway 会话 + 流式对话（M5.2 → M5 交互式审批/模型热切）。
 *
 * `streamPrompt` 串起：`session.create` → `prompt.submit` → 订阅事件/服务端请求 →
 * 把 gateway 原始帧归一化为稳定事件（见 `@shared/types` 的 ChatStreamEvent），
 * 供 SSE 路由 / Skill UI 透传。
 *
 * 契约来源（只读参考，未修改）：
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/sessions.py
 *     session.create（含 model/provider/reasoning_effort）/ session.interrupt / session.close
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/prompt_voice.py
 *     prompt.submit
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/events.py
 *     message.start / message.delta / message.interim / message.complete /
 *     reasoning.delta / thinking.delta / tool.start / tool.complete / error /
 *     subagent.* / request.cancel …
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/server_requests.py
 *     approval（choice: once/session/always/deny）/ clarify
 *   ~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/config_free_tier_control.py
 *     config.set（key:"model" → 会话热切，methods_config_set.py::_set_model）
 *
 * 审批策略：
 *   - `OS_GATEWAY_AUTO_APPROVE=1`（或 options.autoApprove）：立即回 once / 第一个选项（不打断 UI）；
 *   - `options.interactive !== true`（非交互，如 REST broker）：立即回安全默认 deny / 空答案；
 *   - `options.interactive === true`（SSE 交互流）：挂起 pending，事件携带 chatId/id 供
 *     `decideApproval(chatId, …)` 回应；**流结束 / 单条决策超时仍 pending → 自动安全默认兜底**。
 *   无论决策如何，事件都先透出给 onEvent。
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
  // M5：审批撤回 + subagent 观测事件（contracts/events.py::request.cancel / subagent.*）。
  "request.cancel",
  "subagent.spawn_requested",
  "subagent.start",
  "subagent.progress",
  "subagent.thinking",
  "subagent.tool",
  "subagent.complete",
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
 * approval/clarify 事件携带 `{ id, choices?, prompt? }`（id = 内部请求 id = requestId）。
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
        id: request.id,
        command: str(request.params.command),
        description: str(request.params.description),
        choices: strArray(request.params.choices),
        name: str(request.params.tool_name),
        prompt:
          str(request.params.description) ?? str(request.params.command) ?? undefined,
      };
    case "clarify":
      return {
        type: "clarify",
        sessionId,
        requestId: request.id,
        id: request.id,
        question: str(request.params.question),
        choices: strArray(request.params.choices),
        prompt: str(request.params.question) ?? undefined,
      };
    default:
      return {
        type: "raw",
        sessionId,
        raw: { id: request.id, method: request.method, params: request.params },
      };
  }
}

/* ------------------------------------------------------------------ *
 * 交互式决策注册表（chatId → pending 服务端请求）
 * ------------------------------------------------------------------ */

/** 标准 approval 选项（契约 ApprovalChoice：once/session/always/deny）。 */
export const APPROVAL_CHOICES: readonly ApprovalChoiceValue[] = [
  "once",
  "session",
  "always",
  "deny",
];

/** decideApproval 的决策输入。 */
export interface ChatDecisionInput {
  type: "approval" | "clarify";
  /** approval：once | session | always | deny（或该 pending 声明的 choices 之一）。 */
  choice?: string;
  /** clarify：答案（缺省 ""）。 */
  answer?: string;
}

/** decideApproval 的成功结果。 */
export interface ChatDecideOutcome {
  ok: true;
  chatId: string;
  requestId: string;
  type: "approval" | "clarify";
  decision: Record<string, unknown>;
}

interface PendingChatDecision {
  chatId: string;
  requestId: string;
  type: "approval" | "clarify";
  /** gateway 透传的可选 choices（校验用；缺省用 APPROVAL_CHOICES）。 */
  allowedChoices?: string[];
  timer: NodeJS.Timeout;
  client: GatewayClient;
}

interface ChatRuntime {
  chatId: string;
  sessionId: string;
  closed: boolean;
  /** requestId → pending 决策。 */
  pending: Map<string, PendingChatDecision>;
  emit: (event: ChatStreamEvent) => void;
}

/** 进行中的 chat 流运行时（进程内；流结束即删除）。 */
const chatRuntimes = new Map<string, ChatRuntime>();

/** 安全默认 result：approval→deny（auto→once）；clarify→空答案（auto→第一个选项）。 */
function safeDecisionResult(
  type: "approval" | "clarify",
  auto: boolean,
  choices?: string[],
): Record<string, unknown> {
  if (type === "approval") return { choice: auto ? "once" : "deny" };
  const first = choices && choices.length > 0 ? choices[0] : undefined;
  return { answer: auto && first ? first : "" };
}

/** 结算一条 pending（回 gateway + 拆除注册）。返回是否成功送出。 */
function settlePending(
  pending: PendingChatDecision,
  result: Record<string, unknown>,
): boolean {
  clearTimeout(pending.timer);
  const runtime = chatRuntimes.get(pending.chatId);
  runtime?.pending.delete(pending.requestId);
  try {
    return pending.client.respond(pending.requestId, result);
  } catch {
    return false;
  }
}

/**
 * 回应一条 pending 的 approval / clarify（M5 交互式授权）。
 *
 * - chatId 不存在（未知或流已结束）→ `CHAT_NOT_FOUND`（404）；
 * - chat 存在但该 type 无 pending（已决/未产生）→ `DECISION_RESOLVED`（409）；
 * - 非法参数 → `INVALID_VALUE`（400）。
 */
export function decideApproval(
  chatId: string,
  decision: ChatDecisionInput,
): ChatDecideOutcome {
  if (typeof chatId !== "string" || chatId.trim() === "") {
    throw lifecycleError("INVALID_VALUE", "chatId 不能为空。");
  }
  const type = decision?.type;
  if (type !== "approval" && type !== "clarify") {
    throw lifecycleError("INVALID_VALUE", "type 必须是 approval 或 clarify。");
  }

  const runtime = chatRuntimes.get(chatId);
  if (!runtime || runtime.closed) {
    throw lifecycleError(
      "CHAT_NOT_FOUND",
      `chat 不存在或已结束：${chatId}`,
    );
  }

  let target: PendingChatDecision | undefined;
  for (const pending of runtime.pending.values()) {
    if (pending.type === type) {
      target = pending;
      break;
    }
  }
  if (!target) {
    throw lifecycleError(
      "DECISION_RESOLVED",
      `没有待决的 ${type} 请求（可能已决策或已按安全默认兜底）。`,
    );
  }

  let result: Record<string, unknown>;
  if (type === "approval") {
    const choice = typeof decision.choice === "string" ? decision.choice : "";
    const allowed = new Set<string>([
      ...APPROVAL_CHOICES,
      ...(target.allowedChoices ?? []),
    ]);
    if (!allowed.has(choice)) {
      throw lifecycleError(
        "INVALID_VALUE",
        `非法 approval choice：${choice === "" ? "(空)" : choice}`,
      );
    }
    result = { choice };
  } else {
    const answer = typeof decision.answer === "string" ? decision.answer : "";
    result = { answer };
  }

  const sent = settlePending(target, result);
  if (!sent) {
    throw lifecycleError(
      "GATEWAY_UNAVAILABLE",
      "gateway 连接不可用，决策未能送达。",
    );
  }
  return {
    ok: true,
    chatId,
    requestId: target.requestId,
    type,
    decision: result,
  };
}

/** streamPrompt 依赖注入与选项。 */
export interface StreamPromptOptions {
  /** 用户输入（必填）。 */
  prompt: string;
  /** 目标 profile（透传 session.create）。 */
  profile?: string;
  /** 会话模型（透传 session.create 的 model；契约：contracts/sessions.py::SessionCreateParams）。 */
  model?: string;
  /**
   * 昂贵模型二次确认放行（M5 收尾）：true 时热切 `config.set model` 带
   * `confirm_expensive_model:true`（gateway 真实契约键，见 switchSessionModel）。
   * 不带 force 且非 autoApprove 时，昂贵模型 → `confirm_required` → 透出
   * `session/model.confirm_required` 事件并结束流（**不静默放行**、不提交 prompt）；
   * 前端 Modal 确认后带 force 重试 SSE。`OS_GATEWAY_AUTO_APPROVE=1` 时自动 force。
   */
  force?: boolean;
  /** chat 流 id（decideApproval 定位键）；缺省自动生成 uuid，随事件与结果回传。 */
  chatId?: string;
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
  /**
   * 交互式决策（M5）：true 时 approval/clarify 挂起等待 decideApproval，
   * 超时/流结束自动安全默认兜底。默认 false（非交互：立即安全默认）。
   */
  interactive?: boolean;
  /** 单条交互决策超时（毫秒），默认 120000；仅 interactive 生效。 */
  decisionTimeoutMs?: number;
  /** 整体超时（毫秒），默认 300000。 */
  timeoutMs?: number;
  /** 结束时是否关闭会话（默认 true）。 */
  closeOnFinish?: boolean;
}

/** 流式对话的结束摘要。 */
export interface ChatStreamResult {
  sessionId: string;
  status: "done" | "interrupted" | "error";
  /** 本流的 chatId（客户端未传时为服务端生成）。 */
  chatId: string;
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
 * 在事件与服务端请求到达时调用 onEvent；审批/澄清按交互策略回应
 * （autoApprove 立即放行 / 非交互立即安全默认 / interactive 挂起待 decideApproval）。
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
  const decisionTimeoutMs = options.decisionTimeoutMs ?? 120_000;
  const interactive = options.interactive === true;
  const chatId =
    typeof options.chatId === "string" && options.chatId.trim() !== ""
      ? options.chatId.trim()
      : randomUUID();

  // 尽早响应 abort：resolveClient / createSession 阶段也可被取消。
  let earlyAborted = false;
  const earlyAbort = (): void => {
    earlyAborted = true;
  };
  if (options.signal) {
    if (options.signal.aborted) earlyAborted = true;
    else options.signal.addEventListener("abort", earlyAbort, { once: true });
  }

  const throwIfEarlyAborted = (): void => {
    if (earlyAborted) {
      throw lifecycleError("GATEWAY_UNAVAILABLE", "chat 流已被取消。");
    }
  };

  try {
    throwIfEarlyAborted();
    const client =
      options.client ??
      (await (options.resolveClient ?? defaultResolveClient)());
    throwIfEarlyAborted();

    const created = await client.createSession({
      profile: options.profile,
      ...(options.model ? { model: options.model } : {}),
      ...(options.sessionParams ?? {}),
    });
    throwIfEarlyAborted();

    const sessionId = created?.session_id;
    if (!sessionId) {
      throw lifecycleError(
        "GATEWAY_RPC_ERROR",
        "session.create 未返回 session_id。",
      );
    }

    // 昂贵模型二次确认（M5 收尾）：创建后经官方 `config.set model` 走 selection
    // guard（契约键 confirm_expensive_model）。confirm_required 时透出事件并结束流，
    // **不提交 prompt、不静默放行**；autoApprove（或 options.force）时自动 force。
    const modelTarget =
      typeof options.model === "string" && options.model.trim() !== ""
        ? options.model.trim()
        : "";
    if (modelTarget) {
      const switched = await switchSessionModel(client, sessionId, modelTarget, {
        force: options.force === true || autoApprove,
      });
      if (switched.confirmRequired) {
        const confirmMessage =
          switched.confirmMessage ||
          switched.warning ||
          "该模型可能产生较高费用，确认后方可使用。";
        try {
          options.onEvent?.({
            type: "session",
            chatId,
            sessionId,
            event: "model.confirm_required",
            payload: {
              model: modelTarget,
              confirmRequired: true,
              confirmMessage,
            },
          });
        } catch {
          // 订阅者异常不影响收尾。
        }
        if (options.closeOnFinish !== false) {
          try {
            await client.closeSession(sessionId);
          } catch {
            // 会话可能尚未完全就绪，忽略关闭失败。
          }
        }
        return { sessionId, status: "interrupted", chatId };
      }
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

    const runtime: ChatRuntime = {
      chatId,
      sessionId,
      closed: false,
      pending: new Map(),
      emit,
    };
    chatRuntimes.set(chatId, runtime);

    const finish = (result: Omit<ChatStreamResult, "chatId">): void => {
      if (settled) return;
      settled = true;
      resolveDone({ ...result, chatId });
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
      emit({ ...event, chatId });
      if (event.type === "done") finish({ sessionId, status: "done" });
      else if (event.type === "error") finish({ sessionId, status: "error" });
    });

    const offRequest = client.onRequest((request) => {
      if (!belongsToSession(request.params.session_id)) return;
      const base = normalizeGatewayRequest(request);

      if (request.method === "approval" || request.method === "clarify") {
        const type = request.method;
        const choices = base.choices;
        // 交互式 + 非 autoApprove：挂起等待 decideApproval；否则立即回应。
        const waitInteractive = interactive && !autoApprove;
        const event: ChatStreamEvent = {
          ...base,
          chatId,
          id: request.id,
          autoDecided: !waitInteractive,
        };
        // 先注册 pending 再 emit：订阅者可在 onEvent 内同步 decideApproval。
        if (waitInteractive) {
          const timer = setTimeout(() => {
            const pending = runtime.pending.get(request.id);
            if (!pending) return;
            const fallback = safeDecisionResult(type, false, choices);
            settlePending(pending, fallback);
            runtime.emit({
              type: "session",
              chatId,
              sessionId,
              event: "decision.fallback",
              payload: {
                requestId: request.id,
                type,
                reason: "timeout",
                ...fallback,
              },
            });
          }, decisionTimeoutMs);
          runtime.pending.set(request.id, {
            chatId,
            requestId: request.id,
            type,
            ...(choices ? { allowedChoices: choices } : {}),
            timer,
            client,
          });
        }
        emit(event);
        if (!waitInteractive) {
          client.respond(
            request.id,
            safeDecisionResult(type, autoApprove, choices),
          );
        }
        return;
      }

      // 其他单值提问（sudo / secret 等）：安全默认回空（跳过/拒绝）。
      emit({ ...base, chatId });
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
        // abort 时 done 可能先 settle：与 submitPrompt 竞速，避免卡在 RPC 上。
        const submit = client
          .submitPrompt(sessionId, prompt)
          .then(() => undefined)
          .catch((error: unknown) => {
            fail(error);
          });
        await Promise.race([submit, done.catch(() => undefined)]);
      }
      return await done;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      offEvent();
      offRequest();
      // 流结束仍 pending → 按安全默认兜底（deny / 空答案）。
      runtime.closed = true;
      if (runtime.pending.size > 0) {
        for (const pending of [...runtime.pending.values()]) {
          const fallback = safeDecisionResult(pending.type, false);
          settlePending(pending, fallback);
          emit({
            type: "session",
            chatId,
            sessionId,
            event: "decision.fallback",
            payload: {
              requestId: pending.requestId,
              type: pending.type,
              reason: "stream_end",
              ...fallback,
            },
          });
        }
        runtime.pending.clear();
      }
      if (chatRuntimes.get(chatId) === runtime) {
        chatRuntimes.delete(chatId);
      }
      if (options.closeOnFinish !== false) {
        try {
          await client.closeSession(sessionId);
        } catch {
          // 会话可能已被中断/回收，忽略关闭失败。
        }
      }
    }
  } catch (error) {
    // 早期 abort：转为 interrupted 结果，不向外抛（与流中断语义一致）。
    if (earlyAborted) {
      return { sessionId: "", status: "interrupted", chatId };
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", earlyAbort);
  }
}

/**
 * 会话模型热切换（M5 研究结论）。
 *
 * 正规契约 = `config.set { key:"model", value, session_id }`
 * （contracts/config_free_tier_control.py::ConfigSetParams +
 *  methods_config_set.py::_set_model）：
 *   - 会话空闲 → 立即热切 live agent（`_apply_model_switch`）；
 *   - 会话 running → 顺延到下一 turn（`deferred:true`）；
 *   - 昂贵模型可能返回 `confirm_required`（需再次带 confirm_expensive_model 确认）。
 * 另：`session.create` 的 `model` 参数可在建会话时指定（streamPrompt 已支持）。
 */
export interface SwitchSessionModelResult {
  /** false 表示未立即生效（confirm_required）。 */
  ok: boolean;
  /** 归一化后的模型名。 */
  value?: string;
  /** session | global | once。 */
  scope?: string;
  /** true = 切换被顺延到下一 turn。 */
  deferred?: boolean;
  confirmRequired?: boolean;
  warning?: string;
  confirmMessage?: string;
}

/** 对 live session 执行 `config.set model` 热切换。 */
export async function switchSessionModel(
  client: GatewayClient,
  sessionId: string,
  model: string,
  options: { force?: boolean } = {},
): Promise<SwitchSessionModelResult> {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw lifecycleError("INVALID_VALUE", "sessionId 不能为空。");
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw lifecycleError("INVALID_VALUE", "model 不能为空。");
  }
  // 契约（只读确认 tui_gateway/contracts/config_free_tier_control.py::ConfigSetParams
  // + methods_config_set.py::_set_model）：二次确认键是 **confirm_expensive_model**
  // （Params extra=forbid，绝不能发未声明的 `force`）；CLI 的 `config set --force`
  // 只跳过 unknown-key 提示，与昂贵模型无关。工作台对外用 force，此处映射。
  // OS_GATEWAY_AUTO_APPROVE=1 → 与既有审批策略一致，自动 force（不打断 UI）。
  const confirm = options.force === true || isAutoApprove();
  const raw = await client.call<Record<string, unknown>>("config.set", {
    key: "model",
    value: model,
    session_id: sessionId,
    ...(confirm ? { confirm_expensive_model: true } : {}),
  });
  const confirmRequired = raw?.confirm_required === true;
  const value = typeof raw?.value === "string" ? raw.value : model;
  const warning = typeof raw?.warning === "string" ? raw.warning : "";
  const confirmMessage =
    typeof raw?.confirm_message === "string" ? raw.confirm_message : "";
  return {
    ok: !confirmRequired,
    value,
    ...(typeof raw?.scope === "string" ? { scope: raw.scope } : {}),
    ...(raw?.deferred === true ? { deferred: true } : {}),
    ...(confirmRequired ? { confirmRequired: true } : {}),
    ...(warning ? { warning } : {}),
    ...(confirmMessage ? { confirmMessage } : {}),
  };
}
