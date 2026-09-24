import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatStreamEvent,
  PanelAction,
  PanelField,
  PanelOption,
  SkillUiInfo,
} from "@shared/types";
import { interpolatePrompt } from "@shared/panel";
import { API_BASE } from "../api";

/**
 * DeclarativePanel —— 声明式 Skill UI 宿主（M4.1）。
 *
 * skill 作者只写 `ui/panel.yaml`（24os-skill-panel/1），这里把它渲染成表单 +
 * 模板画廊 + 预览，并把 `actions[].kind === "prompt"` 的动作通过
 * `POST /api/hermes/chat/stream`（SSE）流式展示。
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
  kind: "text" | "tool" | "request" | "done" | "error";
  text: string;
}

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
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback((kind: OutputLine["kind"], text: string) => {
    setLines((prev) => [...prev.slice(-499), { id: ++lineSeq, kind, text }]);
  }, []);

  const skillId = skill.id;
  const fields = useMemo(() => panel?.fields ?? [], [panel]);

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
        case "approval":
          log("request", `⚠ 审批：${event.description ?? event.command ?? "(无描述)"}（默认拒绝）`);
          break;
        case "clarify":
          log("request", `？澄清：${event.question ?? "(无问题)"}`);
          break;
        case "done":
          log("done", `✔ 完成（${event.status ?? "complete"}）`);
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
    log("text", `$ ${prompt}`);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`${API_BASE}/api/hermes/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
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
              applyEvent(JSON.parse(chunk.slice("data:".length).trim()) as ChatStreamEvent);
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

          <div className="decl-output" ref={outputRef}>
            {lines.length === 0 && !streamText && (
              <div className="skill-debug-empty">点击动作按钮后在此查看流式输出…</div>
            )}
            {lines.map((line) => (
              <div key={line.id} className={`decl-line decl-${line.kind}`}>
                {line.text}
              </div>
            ))}
            {streamText && <pre className="decl-stream">{streamText}</pre>}
          </div>
        </section>
      </div>
    </div>
  );
}
