import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatStreamEvent,
  SkillHostInvokeRequest,
  SkillHostInvokeResponse,
  SkillUiCapability,
  SkillUiEventMessage,
  SkillUiHostInit,
  SkillUiInfo,
  SkillUiRpcResponse,
} from "@shared/types";
import { API_BASE, decideChat, fetchModelOptions, newChatId } from "../api";
import Modal from "./Modal";

/**
 * SkillHost —— 功能性 Skill 的 UI 宿主（M5：交互式审批 + 模型下拉）。
 *
 * - 用 sandbox="allow-scripts" 的 iframe 加载 skill 的 ui 入口（跨源到 4319）；
 * - 实现 24os-skill-ui/1 的 postMessage RPC broker：
 *     握手 host.init / ui.ready、按 id 关联请求响应、调用宿主 broker 接口；
 * - chatStream（SSE）：事件经 `type:"event"` 转发给 iframe；M5 起宿主侧
 *   同步渲染审批（once/session/always/deny 或 gateway choices）与澄清卡片，
 *   点选 → `POST /api/hermes/chat/decide`；模型下拉对后续 chatStream 生效；
 * - 内置调试面板：记录每次 RPC、首个敏感能力（writeFile/runTool）的权限提示、
 *   可清空 / 折叠 / 重新加载 UI。
 *
 * 安全：因为 sandbox 未开 allow-same-origin，iframe 是 opaque origin，
 * 故用 event.source === iframe.contentWindow 校验来源，而非 origin。
 */

interface DebugLog {
  id: number;
  time: string;
  kind: "rpc" | "event" | "error" | "permission";
  method: string;
  detail: string;
  ms?: number;
  ok?: boolean;
}

/** 宿主侧挂起的审批 / 澄清卡片。 */
type PendingDecision =
  | {
      kind: "approval";
      chatId: string;
      requestId?: string;
      command?: string;
      description?: string;
      choices?: string[];
    }
  | {
      kind: "clarify";
      chatId: string;
      requestId?: string;
      question?: string;
      choices?: string[];
    };

/** 标准审批选项（gateway 未透传 choices 时使用）。 */
const DEFAULT_APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;

/** 敏感能力：首次使用会高亮提示。 */
const SENSITIVE_METHODS: readonly SkillUiCapability[] = ["writeFile", "runTool"];

/** 请求参数摘要（截断，避免日志爆炸）。 */
function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    const json = JSON.stringify(value);
    return json.length > 100 ? `${json.slice(0, 100)}…` : json;
  } catch {
    return String(value);
  }
}

function nowTime(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

let logSeq = 0;

export default function SkillHost({
  skill,
  onClose,
}: {
  skill: SkillUiInfo;
  onClose?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [permissionUsed, setPermissionUsed] = useState(false);
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  // 昂贵模型二次确认（M5 收尾）：收到 session/model.confirm_required → Modal。
  const [modelConfirm, setModelConfirm] = useState<string | null>(null);
  const modelConfirmResolve = useRef<((proceed: boolean) => void) | null>(null);

  // 每次重新加载 UI 换一个 nonce。
  const sessionNonce = useMemo(
    () => `${skill.id}-${reloadKey}-${Math.random().toString(36).slice(2, 10)}`,
    [skill.id, reloadKey],
  );

  // 命令式宿主只处理 iframe manifest；声明式面板由 DeclarativePanel 渲染。
  const manifest = skill.manifest;
  const capabilities = manifest?.capabilities ?? [];
  const capabilitiesRef = useRef<SkillUiCapability[]>(capabilities);
  capabilitiesRef.current = capabilities;

  // 模型下拉候选（M5）。
  useEffect(() => {
    let cancelled = false;
    fetchModelOptions()
      .then((options) => {
        if (!cancelled) setModelOptions(options);
      })
      .catch(() => {
        if (!cancelled) setModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pushLog = useCallback((entry: Omit<DebugLog, "id" | "time">) => {
    setLogs((prev) => [
      ...prev.slice(-199),
      { ...entry, id: ++logSeq, time: nowTime() },
    ]);
  }, []);

  /** 宿主 → iframe：发送握手初始化。 */
  const sendInit = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const payload: SkillUiHostInit = {
      protocol: manifest?.protocol ?? "",
      capabilities: manifest?.capabilities ?? [],
      permissions: manifest?.permissions ?? [],
      sessionNonce,
    };
    win.postMessage({ __24os: true, type: "host.init", payload }, "*");
    pushLog({
      kind: "event",
      method: "host.init",
      detail: `握手 nonce=${sessionNonce.slice(0, 12)}… capabilities=[${capabilities.join(", ")}]`,
    });
  }, [manifest, sessionNonce, capabilities, pushLog]);

  /** 宿主 → iframe：回传 RPC 响应。 */
  const respond = useCallback((response: SkillUiRpcResponse) => {
    iframeRef.current?.contentWindow?.postMessage(response, "*");
  }, []);

  /** 调用宿主 broker（REST），把结果回传 iframe。 */
  const invoke = useCallback(
    async (method: SkillUiCapability, params: unknown, id: string) => {
      const startedAt = performance.now();
      const body: SkillHostInvokeRequest = { skillId: skill.id, method, params };
      try {
        const response = await fetch(`${API_BASE}/api/skill-host/invoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json()) as SkillHostInvokeResponse;
        const ms = Math.round(performance.now() - startedAt);
        if (data.ok) {
          pushLog({
            kind: "rpc",
            method,
            detail: summarize(params),
            ms,
            ok: true,
          });
          respond({ __24os: true, id, ok: true, result: data.result });
        } else {
          const message = data.error?.message ?? "宿主拒绝";
          pushLog({ kind: "error", method, detail: message, ms, ok: false });
          respond({
            __24os: true,
            id,
            ok: false,
            error: data.error ?? { code: "HOST_ERROR", message },
          });
        }
      } catch (error) {
        const ms = Math.round(performance.now() - startedAt);
        const message = error instanceof Error ? error.message : String(error);
        pushLog({ kind: "error", method, detail: `网络错误：${message}`, ms, ok: false });
        respond({
          __24os: true,
          id,
          ok: false,
          error: { code: "NETWORK_ERROR", message },
        });
      }
    },
    [skill.id, pushLog, respond],
  );

  /** 宿主 → iframe：转发一条 chat 流式事件（M5.2 → M5 交互式）。 */
  const forwardChatEvent = useCallback(
    (event: ChatStreamEvent) => {
      const name =
        event.type === "delta" || event.type === "thinking" || event.type === "message"
          ? "chat.delta"
          : event.type === "done"
            ? "chat.done"
            : event.type === "error"
              ? "chat.error"
              : event.type === "tool.start" || event.type === "tool.complete"
                ? "chat.tool"
                : event.type === "subagent"
                  ? "chat.subagent"
                  : event.type === "approval" || event.type === "clarify"
                    ? "chat.request"
                    : "chat.event";
      const message: SkillUiEventMessage = {
        __24os: true,
        type: "event",
        event: name,
        payload: event,
      };
      iframeRef.current?.contentWindow?.postMessage(message, "*");

      // M5：宿主侧同步渲染审批 / 澄清卡片（iframe 也会收到事件）。
      if (event.type === "approval") {
        if (event.autoDecided) {
          pushLog({
            kind: "event",
            method: "chat.request",
            detail: `审批已自动处理：${event.description ?? event.command ?? ""}`,
          });
        } else {
          setDecisionError(null);
          setPending({
            kind: "approval",
            chatId: event.chatId ?? "",
            requestId: event.requestId,
            command: event.command,
            description: event.description,
            choices: event.choices,
          });
        }
      } else if (event.type === "clarify") {
        if (event.autoDecided) {
          pushLog({
            kind: "event",
            method: "chat.request",
            detail: `澄清已自动处理：${event.question ?? ""}`,
          });
        } else {
          setDecisionError(null);
          setClarifyAnswer("");
          setPending({
            kind: "clarify",
            chatId: event.chatId ?? "",
            requestId: event.requestId,
            question: event.question,
            choices: event.choices,
          });
        }
      } else if (
        event.type === "session" &&
        event.event === "decision.fallback"
      ) {
        const payload = (event.payload ?? {}) as { type?: string; reason?: string };
        pushLog({
          kind: "event",
          method: "chat.request",
          detail: `决策已按安全默认兜底（${payload.reason ?? "end"}）`,
        });
        setPending((prev) => (prev && prev.chatId === event.chatId ? null : prev));
      } else if (event.type === "done" || event.type === "error") {
        // 流结束时若仍有挂起卡片：服务端已兜底，清掉并记录状态。
        setPending((prev) => {
          if (prev) {
            pushLog({
              kind: "event",
              method: "chat.request",
              detail: "流已结束，未决请求已按安全默认处理",
            });
            return null;
          }
          return prev;
        });
      }

      const detail =
        event.type === "delta" || event.type === "thinking" || event.type === "message"
          ? (event.text ?? "")
          : event.type === "done"
            ? `status=${event.status ?? "complete"}`
            : event.type === "error"
              ? (event.message ?? "")
              : event.type === "subagent"
                ? `子代理 ${event.phase ?? "?"}${event.goal ? `：${event.goal}` : ""}${
                    event.status ? `（${event.status}）` : ""
                  }`
                : summarize(event);
      pushLog({
        kind: event.type === "error" ? "error" : "event",
        method: name,
        detail,
        ok: event.type !== "error",
      });
    },
    [pushLog],
  );

  /** 宿主侧提交审批 / 澄清决策。 */
  const submitDecision = useCallback(
    async (payload: { choice?: string; answer?: string }) => {
      if (!pending || decisionBusy) return;
      setDecisionBusy(true);
      setDecisionError(null);
      try {
        await decideChat({
          chatId: pending.chatId,
          type: pending.kind,
          ...(payload.choice !== undefined ? { choice: payload.choice } : {}),
          ...(payload.answer !== undefined ? { answer: payload.answer } : {}),
        });
        pushLog({
          kind: "rpc",
          method: "chat.decide",
          detail:
            pending.kind === "approval"
              ? `choice=${payload.choice ?? ""}`
              : `answer=${payload.answer?.trim() ? payload.answer : "(空)"}`,
          ok: true,
        });
        setPending(null);
        setClarifyAnswer("");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDecisionError(`决策失败：${message}`);
        pushLog({ kind: "error", method: "chat.decide", detail: message, ok: false });
      } finally {
        setDecisionBusy(false);
      }
    },
    [pending, decisionBusy, pushLog],
  );

  /** 昂贵模型确认：弹 Modal 并挂起等待用户 确认(true)/取消(false)。 */
  const askModelConfirm = useCallback((message: string): Promise<boolean> => {
    setModelConfirm(message);
    return new Promise<boolean>((resolve) => {
      modelConfirmResolve.current = resolve;
    });
  }, []);

  /** 结算昂贵模型确认（Modal 按钮 / 关闭）。 */
  const settleModelConfirm = useCallback((proceed: boolean) => {
    setModelConfirm(null);
    const resolve = modelConfirmResolve.current;
    modelConfirmResolve.current = null;
    resolve?.(proceed);
  }, []);

  /**
   * chatStream capability：宿主直接把 SSE 流经 postMessage 转发给 iframe，
   * 完成后按请求 id 回一个汇总响应。
   * 收到 `model.confirm_required` 时弹昂贵模型确认 Modal：
   * 确认 → 带 force:true 重试一次；取消 → 回 MODEL_CONFIRM_CANCELLED。
   */
  const invokeChatStream = useCallback(
    async (
      params: unknown,
      id: string,
      opts: { force?: boolean; allowConfirm?: boolean } = {},
    ): Promise<void> => {
      const obj = (params && typeof params === "object" ? params : {}) as {
        prompt?: unknown;
        profile?: unknown;
        model?: unknown;
      };
      const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
      const profile = typeof obj.profile === "string" ? obj.profile : undefined;
      const paramModel = typeof obj.model === "string" ? obj.model : undefined;
      const chatId = newChatId();
      const body = {
        prompt,
        profile,
        chatId,
        model: paramModel ?? (model.trim() ? model.trim() : undefined),
        ...(opts.force ? { force: true } : {}),
      };
      const startedAt = performance.now();

      if (prompt.trim() === "") {
        pushLog({ kind: "error", method: "chatStream", detail: "prompt 不能为空", ok: false });
        respond({
          __24os: true,
          id,
          ok: false,
          error: { code: "INVALID_VALUE", message: "prompt 不能为空" },
        });
        return;
      }

      try {
        const response = await fetch(`${API_BASE}/api/hermes/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok || !response.body) {
          const message = `HTTP ${response.status}`;
          pushLog({
            kind: "error",
            method: "chatStream",
            detail: message,
            ms: Math.round(performance.now() - startedAt),
            ok: false,
          });
          respond({
            __24os: true,
            id,
            ok: false,
            error: { code: "CHAT_STREAM_FAILED", message },
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let status = "done";
        let confirmMessage: string | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const chunk = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 2);
            if (chunk.startsWith("data:")) {
              let event: ChatStreamEvent | null = null;
              try {
                event = JSON.parse(chunk.slice("data:".length).trim()) as ChatStreamEvent;
              } catch {
                event = null;
              }
              if (event) {
                forwardChatEvent(event);
                if (event.type === "error") status = "error";
                if (
                  event.type === "session" &&
                  event.event === "model.confirm_required"
                ) {
                  const payload = (event.payload ?? {}) as { confirmMessage?: string };
                  confirmMessage =
                    payload.confirmMessage || "该模型可能产生较高费用，确认后方可使用。";
                }
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }

        // 昂贵模型确认：不静默放行——Modal 决策后 force 重试或明确取消。
        if (confirmMessage && opts.allowConfirm !== false) {
          pushLog({
            kind: "event",
            method: "chatStream",
            detail: `昂贵模型待确认：${confirmMessage.slice(0, 80)}`,
          });
          const proceed = await askModelConfirm(confirmMessage);
          if (proceed) {
            pushLog({
              kind: "rpc",
              method: "chatStream",
              detail: "已确认昂贵模型，带 force 重试",
            });
            await invokeChatStream(params, id, { force: true, allowConfirm: false });
            return;
          }
          pushLog({
            kind: "event",
            method: "chatStream",
            detail: "已取消昂贵模型确认，模型未切换",
          });
          respond({
            __24os: true,
            id,
            ok: false,
            error: {
              code: "MODEL_CONFIRM_CANCELLED",
              message: "已取消昂贵模型确认，模型未切换。",
            },
          });
          return;
        }
        if (confirmMessage) {
          // force 重试后 gateway 仍要求确认（异常契约）→ 明确失败，不放行。
          respond({
            __24os: true,
            id,
            ok: false,
            error: {
              code: "MODEL_CONFIRM_REQUIRED",
              message: confirmMessage,
            },
          });
          return;
        }

        pushLog({
          kind: "rpc",
          method: "chatStream",
          detail: `prompt=${summarize(prompt)}`,
          ms: Math.round(performance.now() - startedAt),
          ok: status !== "error",
        });
        respond({ __24os: true, id, ok: true, result: { status } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushLog({
          kind: "error",
          method: "chatStream",
          detail: `网络错误：${message}`,
          ms: Math.round(performance.now() - startedAt),
          ok: false,
        });
        respond({ __24os: true, id, ok: false, error: { code: "NETWORK_ERROR", message } });
      }
    },
    [forwardChatEvent, pushLog, respond, model, askModelConfirm],
  );

  // 监听 iframe 的 RPC 请求。
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as
        | { __24os?: unknown; type?: string; id?: string; method?: SkillUiCapability; params?: unknown }
        | null;
      if (!data || data.__24os !== true) return;

      // UI 就绪：重发握手（覆盖加载竞态）。
      if (data.type === "ui.ready") {
        pushLog({ kind: "event", method: "ui.ready", detail: "UI 就绪" });
        sendInit();
        return;
      }

      if (!data.id || !data.method) return;
      const method = data.method;

      if (!capabilitiesRef.current.includes(method)) {
        pushLog({
          kind: "error",
          method,
          detail: "未在该 skill 的 capabilities 中声明，已拒绝",
          ok: false,
        });
        respond({
          __24os: true,
          id: data.id,
          ok: false,
          error: { code: "FORBIDDEN", message: `未声明 capability：${method}` },
        });
        return;
      }

      // 敏感能力首次使用：高亮权限提示。
      if (SENSITIVE_METHODS.includes(method)) {
        setPermissionUsed(true);
        pushLog({
          kind: "permission",
          method,
          detail: `权限使用：${method}（prototype 自动放行，已记录）`,
        });
      }

      // chatStream：走 SSE 流式转发，而非一次性 REST invoke。
      if (method === "chatStream") {
        void invokeChatStream(data.params, data.id);
        return;
      }

      void invoke(method, data.params, data.id);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [invoke, invokeChatStream, respond, sendInit, pushLog]);

  const reload = () => {
    setLogs([]);
    setPermissionUsed(false);
    setReloadKey((key) => key + 1);
  };

  const size = manifest?.size ?? { width: 980, height: 660 };

  return (
    <div className="skill-host">
      <div className="skill-host-header">
        <div className="skill-host-title">
          <span className="badge badge-live">Skill UI</span>
          <strong>{skill.title}</strong>
          <span className="skill-host-id">{skill.id}</span>
        </div>
        <div className="skill-host-actions">
          <label className="model-picker" title="切换后对后续 chatStream 生效（新会话带该模型）">
            <span>模型</span>
            <input
              list="skill-model-options"
              value={model}
              placeholder="默认"
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="skill-model-options">
              {modelOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </label>
          <button type="button" className="btn-edit" onClick={reload}>
            重新加载
          </button>
          {onClose && (
            <button type="button" className="btn-edit" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>

      {modelConfirm !== null && (
        <Modal
          title="昂贵模型确认"
          onClose={() => settleModelConfirm(false)}
          footer={
            <>
              <button
                type="button"
                className="btn-edit"
                onClick={() => settleModelConfirm(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => settleModelConfirm(true)}
              >
                确认切换
              </button>
            </>
          }
        >
          <p className="model-confirm-message">{modelConfirm}</p>
          <p className="model-confirm-hint">
            确认后将以该模型发起对话（force 放行）；取消则不切换，保持当前模型。
          </p>
        </Modal>
      )}

      {pending?.kind === "approval" && (
        <div className="chat-decision chat-decision-host">
          <div className="chat-decision-title">
            ⚠ 审批：{pending.description ?? pending.command ?? "(无描述)"}
          </div>
          <div className="chat-decision-actions">
            {(pending.choices && pending.choices.length > 0
              ? pending.choices
              : [...DEFAULT_APPROVAL_CHOICES]
            ).map((choice) => (
              <button
                key={choice}
                type="button"
                className={choice === "deny" ? "chat-decision-btn danger" : "chat-decision-btn"}
                disabled={decisionBusy}
                onClick={() => void submitDecision({ choice })}
              >
                {choice}
              </button>
            ))}
          </div>
          {decisionError && <div className="chat-decision-error">{decisionError}</div>}
        </div>
      )}

      {pending?.kind === "clarify" && (
        <div className="chat-decision chat-decision-host">
          <div className="chat-decision-title">？{pending.question ?? "(无问题)"}</div>
          {pending.choices && pending.choices.length > 0 && (
            <div className="chat-decision-choices">
              {pending.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="chat-decision-chip"
                  disabled={decisionBusy}
                  onClick={() => setClarifyAnswer(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          <div className="chat-decision-row">
            <input
              className="input"
              value={clarifyAnswer}
              placeholder="输入答案（留空 = 跳过）"
              disabled={decisionBusy}
              onChange={(event) => setClarifyAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitDecision({ answer: clarifyAnswer });
                }
              }}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={decisionBusy}
              onClick={() => void submitDecision({ answer: clarifyAnswer })}
            >
              {decisionBusy ? "发送中…" : "发送"}
            </button>
          </div>
          {decisionError && <div className="chat-decision-error">{decisionError}</div>}
        </div>
      )}

      <div className="skill-host-body">
        <iframe
          key={reloadKey}
          ref={iframeRef}
          className="skill-frame"
          title={`skill-ui-${skill.id}`}
          sandbox="allow-scripts"
          src={`${API_BASE}/skill-ui/${encodeURIComponent(skill.id)}/${manifest?.entry ?? "index.html"}`}
          style={{ width: size.width, height: size.height }}
          onLoad={sendInit}
        />

        <div className={collapsed ? "skill-debug collapsed" : "skill-debug"}>
          <div className="skill-debug-header">
            <span>调试面板</span>
            <span className="skill-debug-count">{logs.length}</span>
            <div className="skill-debug-actions">
              <button type="button" onClick={() => setLogs([])}>
                清空
              </button>
              <button type="button" onClick={() => setCollapsed((value) => !value)}>
                {collapsed ? "展开" : "折叠"}
              </button>
            </div>
          </div>

          {permissionUsed && (
            <div className="permission-note">
              该 skill 使用了敏感能力（writeFile / runTool）。prototype 自动放行，已记录日志。
            </div>
          )}

          {!collapsed && (
            <div className="skill-debug-log">
              {logs.length === 0 && (
                <div className="skill-debug-empty">暂无 RPC。等待 UI 握手…</div>
              )}
              {logs.map((log) => (
                <div key={log.id} className={`debug-line debug-${log.kind}`}>
                  <span className="debug-time">{log.time}</span>
                  <span className="debug-method">{log.method}</span>
                  {log.ms !== undefined && <span className="debug-ms">{log.ms}ms</span>}
                  <span className="debug-detail">{log.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
