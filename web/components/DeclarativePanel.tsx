import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatStreamEvent,
  PanelAction,
  PanelField,
  PanelOption,
  SkillUiInfo,
} from "@shared/types";
import { interpolatePrompt } from "@shared/panel";
import { API_BASE, decideChat, fetchModelOptions, newChatId } from "../api";
import Modal from "./Modal";

/**
 * DeclarativePanel —— 声明式 Skill UI 宿主（M4.1 → M5 交互式审批/模型）。
 *
 * skill 作者只写 `ui/panel.yaml`（24os-skill-panel/1），这里把它渲染成表单 +
 * 模板画廊 + 预览，并把 `actions[].kind === "prompt"` 的动作通过
 * `POST /api/hermes/chat/stream`（SSE）流式展示。
 *
 * M5：输出区支持
 *   - 审批卡片（once / session / always / deny，或 gateway 透传的 choices）→
 *     `POST /api/hermes/chat/decide`；
 *   - 澄清输入框 + 选项 → 同上；
 *   - 模型下拉（当前 agent 模型 + 自由文本），切换后对**后续** prompt 生效
 *     （新会话带 `session.create.model`；热切经 `config.set model` 由服务端契约支持）；
 *   - 超时/兜底：收到 `decision.fallback` 或流结束时给出明确状态。
 *
 * **无任意 JS**：面板内不执行 skill 自带的脚本，能力完全由宿主提供，比 iframe
 * 形态更安全。`select.options_from` / `templates.index` 通过静态托管只读拉取。
 */

/** ui/ 下资源的同源 URL（相对 uiRoot）。 */
function uiAssetUrl(skillId: string, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  return `${API_BASE}/skill-ui/${encodeURIComponent(skillId)}/${clean}`;
}

/** 把 options_from 拉到的 JSON 规范化为 PanelOption[]。 */
export function normalizeOptions(data: unknown): PanelOption[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { options?: unknown }).options)
      ? ((data as { options: unknown[] }).options)
      : [];
  const result: PanelOption[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      result.push({ value: item, label: item });
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const value = typeof obj.value === "string" ? obj.value : undefined;
      if (!value) continue;
      const label = typeof obj.label === "string" ? obj.label : undefined;
      result.push(label ? { value, label } : { value });
    }
  }
  return result;
}

/** 模板清单条目（templates/index.json 的宽松形态）。 */
export interface TemplateEntry {
  id?: string;
  name?: string;
  description?: string;
  thumbnail?: string;
  preview?: string;
}

function asTemplateEntries(data: unknown): TemplateEntry[] {
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is TemplateEntry => typeof item === "object" && item !== null);
}

/** 字段初始值：default → slider 取 min → 空串。 */
export function initialValues(fields: PanelField[]): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default;
    else if (field.type === "slider") values[field.key] = field.min ?? 0;
    else values[field.key] = "";
  }
  return values;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

/** 输出区一行。 */
interface OutputLine {
  id: number;
  kind: "text" | "tool" | "subagent" | "request" | "done" | "error";
  text: string;
}

/** 挂起的审批 / 澄清决策卡片。 */
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

let lineSeq = 0;

export default function DeclarativePanel({
  skill,
  onClose,
}: {
  skill: SkillUiInfo;
  onClose?: () => void;
}) {
  const panel = skill.panel;

  const [values, setValues] = useState<Record<string, string | number>>(() =>
    initialValues(panel?.fields ?? []),
  );
  const [optionsMap, setOptionsMap] = useState<Record<string, PanelOption[]>>(() => {
    const map: Record<string, PanelOption[]> = {};
    for (const field of panel?.fields ?? []) {
      if (field.type === "select" && field.options) map[field.key] = field.options;
    }
    return map;
  });
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [streamText, setStreamText] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  // 昂贵模型二次确认（M5 收尾）：收到 session/model.confirm_required → Modal。
  const [modelConfirm, setModelConfirm] = useState<string | null>(null);
  const modelConfirmResolve = useRef<((proceed: boolean) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback((kind: OutputLine["kind"], text: string) => {
    setLines((prev) => [...prev.slice(-499), { id: ++lineSeq, kind, text }]);
  }, []);

  const skillId = skill.id;
  const fields = useMemo(() => panel?.fields ?? [], [panel]);

  // 模型下拉候选（M5）：默认取第一个 agent 的 model（无 agent id 上下文时）。
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

  // select.options_from 动态枚举。
  useEffect(() => {
    let cancelled = false;
    for (const field of fields) {
      if (field.type !== "select" || !field.options_from) continue;
      fetch(uiAssetUrl(skillId, field.options_from))
        .then((response) =>
          response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)),
        )
        .then((data) => {
          if (cancelled) return;
          setOptionsMap((prev) => ({ ...prev, [field.key]: normalizeOptions(data) }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setOptionsMap((prev) => ({ ...prev, [field.key]: [] }));
          setError(`加载 ${field.key} 选项失败：${(err as Error).message}`);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [fields, skillId]);

  // templates/index.json 模板画廊。
  useEffect(() => {
    const index = panel?.templates?.index;
    if (!index) return;
    let cancelled = false;
    fetch(uiAssetUrl(skillId, index))
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)),
      )
      .then((data) => {
        if (!cancelled) setTemplates(asTemplateEntries(data));
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [panel?.templates?.index, skillId]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines, streamText]);

  const setField = (key: string, value: string | number) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const onFile = async (field: PanelField, file: File | undefined) => {
    if (!file) {
      setField(field.key, "");
      return;
    }
    const isText =
      file.type.startsWith("text/") ||
      /\.(txt|md|markdown|json|ya?ml|csv|log)$/i.test(file.name);
    try {
      if (isText) {
        setField(field.key, await file.text());
      } else {
        const buffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        setField(field.key, `data:${file.type || "application/octet-stream"};base64,${base64}`);
      }
    } catch (err) {
      setError(`读取文件失败：${(err as Error).message}`);
    }
  };

  const applyEvent = useCallback(
    (event: ChatStreamEvent) => {
      switch (event.type) {
        case "delta":
        case "thinking":
        case "message":
          if (event.text) setStreamText((prev) => prev + event.text);
          break;
        case "tool.start":
          log("tool", `▶ 工具 ${event.name ?? "?"}${event.summary ? `：${event.summary}` : ""}`);
          break;
        case "tool.complete":
          log("tool", `✔ 工具 ${event.name ?? "?"} 完成`);
          break;
        case "subagent":
          log(
            "subagent",
            `◆ 子代理 ${event.phase ?? "?"}${event.goal ? `：${event.goal}` : ""}${
              event.status ? `（${event.status}）` : ""
            }`,
          );
          break;
        case "approval":
          if (event.autoDecided) {
            log("request", `⚠ 审批：${event.description ?? event.command ?? "(无描述)"}（已自动处理）`);
          } else {
            log("request", `⚠ 审批：${event.description ?? event.command ?? "(无描述)"}（待决策）`);
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
          break;
        case "clarify":
          if (event.autoDecided) {
            log("request", `？澄清：${event.question ?? "(无问题)"}（已自动处理）`);
          } else {
            log("request", `？澄清：${event.question ?? "(无问题)"}（待决策）`);
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
          break;
        case "session":
          if (event.event === "decision.fallback") {
            const payload = (event.payload ?? {}) as {
              type?: string;
              reason?: string;
              choice?: string;
            };
            log(
              "request",
              `⚠ 决策已按安全默认兜底（${payload.reason ?? "end"}）：` +
                `${payload.type === "clarify" ? "空答案" : "deny"}`,
            );
            setPending((prev) => (prev && prev.chatId === event.chatId ? null : prev));
          } else if (event.event === "model.confirm_required") {
            const payload = (event.payload ?? {}) as { confirmMessage?: string };
            log(
              "request",
              `⚠ 昂贵模型待确认：${payload.confirmMessage || "该模型可能产生较高费用。"}`,
            );
          }
          break;
        case "done":
          log("done", `✔ 完成（${event.status ?? "complete"}）`);
          setPending((prev) => {
            if (prev) {
              log("request", "流已结束，未决请求已由服务端按安全默认处理。");
              return null;
            }
            return prev;
          });
          break;
        case "error":
          log("error", `✖ ${event.message ?? "对话错误"}`);
          break;
        default:
          break;
      }
    },
    [log],
  );

  /** 把一次决策提交给 POST /api/hermes/chat/decide。 */
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
        log(
          "request",
          pending.kind === "approval"
            ? `✔ 已选择 ${payload.choice ?? ""}`
            : `✔ 已回答：${payload.answer?.trim() ? payload.answer : "(空)"}`,
        );
        setPending(null);
        setClarifyAnswer("");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDecisionError(`决策失败：${message}`);
        log("error", `✖ 决策失败：${message}`);
      } finally {
        setDecisionBusy(false);
      }
    },
    [pending, decisionBusy, log],
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
   * 跑一轮 SSE（创建/带模型切换）；返回非空字符串表示收到
   * `model.confirm_required`（需 Modal 决策），null 表示流正常结束。
   */
  const streamOnce = useCallback(
    async (prompt: string, force: boolean): Promise<string | null> => {
      const chatId = newChatId();
      const controller = new AbortController();
      abortRef.current = controller;
      let confirmMessage: string | null = null;
      try {
        const response = await fetch(`${API_BASE}/api/hermes/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            chatId,
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(force ? { force: true } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const chunk = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 2);
            if (chunk.startsWith("data:")) {
              try {
                const event = JSON.parse(
                  chunk.slice("data:".length).trim(),
                ) as ChatStreamEvent;
                applyEvent(event);
                if (
                  event.type === "session" &&
                  event.event === "model.confirm_required"
                ) {
                  const payload = (event.payload ?? {}) as { confirmMessage?: string };
                  confirmMessage =
                    payload.confirmMessage || "该模型可能产生较高费用，确认后方可使用。";
                }
              } catch {
                // 忽略无法解析的帧。
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(`对话失败：${(err as Error).message}`);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
      return confirmMessage;
    },
    [applyEvent, model],
  );

  const runAction = async (action: PanelAction) => {
    if (running) return;
    setError(null);

    const missing = fields.filter((field) => field.required && isEmptyValue(values[field.key]));
    if (missing.length > 0) {
      setError(`请填写必填字段：${missing.map((field) => field.label).join("、")}`);
      return;
    }

    const prompt = interpolatePrompt(action.prompt, values, { missing: "empty" });

    setLines([]);
    setStreamText("");
    setPending(null);
    setDecisionError(null);
    log("text", `$ ${prompt}`);
    setRunning(true);

    try {
      // 昂贵模型确认：不静默放行——confirm_required → Modal → 确认 force 重试 / 取消提示。
      let force = false;
      for (;;) {
        const confirmMessage = await streamOnce(prompt, force);
        if (!confirmMessage) break;
        const proceed = await askModelConfirm(confirmMessage);
        if (!proceed) {
          log("request", "⏹ 已取消昂贵模型确认，模型未切换。");
          break;
        }
        if (force) {
          log("error", "✖ gateway 仍要求确认昂贵模型，已中止（不放行）。");
          break;
        }
        setLines([]);
        setStreamText("");
        setPending(null);
        log("text", `$ ${prompt}（已确认昂贵模型，force 重试）`);
        force = true;
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const abort = () => {
    abortRef.current?.abort();
    log("request", "⏹ 已中断");
  };

  if (!panel) {
    return (
      <div className="skill-host">
        <div className="skill-host-header">
          <div className="skill-host-title">
            <span className="badge badge-mock">声明式面板</span>
            <strong>{skill.title}</strong>
          </div>
          {onClose && (
            <div className="skill-host-actions">
              <button type="button" className="btn-edit" onClick={onClose}>
                关闭
              </button>
            </div>
          )}
        </div>
        <div className="decl-empty">该 skill 未提供 panel.yaml。</div>
      </div>
    );
  }

  const renderField = (field: PanelField) => {
    const value = values[field.key] ?? "";
    switch (field.type) {
      case "textarea":
        return (
          <textarea
            className="input decl-textarea"
            placeholder={field.placeholder}
            value={String(value)}
            onChange={(event) => setField(field.key, event.target.value)}
          />
        );
      case "select": {
        const options = optionsMap[field.key] ?? [];
        return (
          <select
            className="input"
            value={String(value)}
            onChange={(event) => setField(field.key, event.target.value)}
          >
            <option value="">{field.placeholder ?? "请选择…"}</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </select>
        );
      }
      case "slider":
        return (
          <div className="decl-slider">
            <input
              type="range"
              min={field.min ?? 0}
              max={field.max ?? 100}
              step={field.step ?? 1}
              value={Number(value) || 0}
              onChange={(event) => setField(field.key, Number(event.target.value))}
            />
            <span className="decl-slider-value">{String(value)}</span>
          </div>
        );
      case "file":
        return (
          <div className="decl-file">
            <input
              type="file"
              onChange={(event) => void onFile(field, event.target.files?.[0])}
            />
            {!isEmptyValue(value) && <span className="decl-file-name">已读取 {String(value).length} 字符</span>}
          </div>
        );
      case "text":
      default:
        return (
          <input
            className="input"
            type="text"
            placeholder={field.placeholder}
            value={String(value)}
            onChange={(event) => setField(field.key, event.target.value)}
          />
        );
    }
  };

  return (
    <div className="skill-host">
      <div className="skill-host-header">
        <div className="skill-host-title">
          <span className="badge badge-live">声明式面板</span>
          <strong>{panel.title}</strong>
          <span className="skill-host-id">{panel.skill}</span>
        </div>
        <div className="skill-host-actions">
          {running && (
            <button type="button" className="btn-edit" onClick={abort}>
              中断
            </button>
          )}
          <button
            type="button"
            className="btn-edit"
            onClick={() => {
              setLines([]);
              setStreamText("");
            }}
          >
            清空输出
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

      <div className="decl-body">
        <section className="decl-form">
          {panel.description && <p className="decl-desc">{panel.description}</p>}

          {fields.map((field) => (
            <label key={field.key} className="decl-field">
              <span className="decl-label">
                {field.label}
                {field.required && <em className="decl-required">*</em>}
              </span>
              {renderField(field)}
            </label>
          ))}

          {templates.length > 0 && (
            <div className="decl-templates">
              <div className="decl-section-title">模板</div>
              <div className="decl-gallery">
                {templates.map((template, index) => (
                  <button
                    key={template.id ?? index}
                    type="button"
                    className="decl-template"
                    onClick={() => {
                      if (!template.id) return;
                      const target = fields.find(
                        (field) =>
                          field.type === "select" &&
                          (optionsMap[field.key] ?? field.options ?? []).some(
                            (option) => option.value === template.id,
                          ),
                      );
                      if (target) setField(target.key, template.id as string);
                    }}
                  >
                    {template.thumbnail && (
                      <img
                        src={uiAssetUrl(skill.id, template.thumbnail)}
                        alt={template.name ?? template.id ?? "模板"}
                      />
                    )}
                    <span className="decl-template-name">
                      {template.name ?? template.id ?? `模板 ${index + 1}`}
                    </span>
                    {template.description && (
                      <span className="decl-template-desc">{template.description}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {panel.actions.length > 0 && (
            <div className="decl-actions">
              {panel.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="btn-primary"
                  disabled={running}
                  onClick={() => void runAction(action)}
                >
                  {running ? "运行中…" : action.label}
                </button>
              ))}
            </div>
          )}

          {error && <div className="notice notice-error">{error}</div>}
        </section>

        <section className="decl-preview">
          {panel.preview?.kind === "iframe" && panel.preview.source && (
            <iframe
              className="decl-preview-frame"
              title={`panel-preview-${skill.id}`}
              sandbox="allow-scripts"
              src={uiAssetUrl(skill.id, panel.preview.source)}
            />
          )}
          {panel.preview?.kind === "markdown" && panel.preview.source && (
            <iframe
              className="decl-preview-frame"
              title={`panel-preview-${skill.id}`}
              sandbox=""
              src={uiAssetUrl(skill.id, panel.preview.source)}
            />
          )}

          <div className="decl-output-toolbar">
            <label className="model-picker" title="切换后对后续 prompt 生效（新会话带该模型）">
              <span>模型</span>
              <input
                list="decl-model-options"
                value={model}
                placeholder="默认"
                onChange={(event) => setModel(event.target.value)}
                disabled={running}
              />
              <datalist id="decl-model-options">
                {modelOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </label>
          </div>

          <div className="decl-output" ref={outputRef}>
            {lines.length === 0 && !streamText && !pending && (
              <div className="skill-debug-empty">点击动作按钮后在此查看流式输出…</div>
            )}
            {lines.map((line) => (
              <div key={line.id} className={`decl-line decl-${line.kind}`}>
                {line.text}
              </div>
            ))}
            {streamText && <pre className="decl-stream">{streamText}</pre>}

            {pending?.kind === "approval" && (
              <div className="chat-decision">
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
                      className={
                        choice === "deny" ? "chat-decision-btn danger" : "chat-decision-btn"
                      }
                      disabled={decisionBusy}
                      onClick={() => void submitDecision({ choice })}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
                {decisionError && (
                  <div className="chat-decision-error">{decisionError}</div>
                )}
              </div>
            )}

            {pending?.kind === "clarify" && (
              <div className="chat-decision">
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
                {decisionError && (
                  <div className="chat-decision-error">{decisionError}</div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
