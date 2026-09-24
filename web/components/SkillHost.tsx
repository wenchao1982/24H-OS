import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SkillHostInvokeRequest,
  SkillHostInvokeResponse,
  SkillUiCapability,
  SkillUiHostInit,
  SkillUiInfo,
  SkillUiRpcResponse,
} from "@shared/types";
import { API_BASE } from "../api";

/**
 * SkillHost —— 功能性 Skill 的 UI 宿主。
 *
 * - 用 sandbox="allow-scripts" 的 iframe 加载 skill 的 ui 入口（跨源到 4319）；
 * - 实现 24os-skill-ui/1 的 postMessage RPC broker：
 *     握手 host.init / ui.ready、按 id 关联请求响应、调用宿主 broker 接口；
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

  // 每次重新加载 UI 换一个 nonce。
  const sessionNonce = useMemo(
    () => `${skill.id}-${reloadKey}-${Math.random().toString(36).slice(2, 10)}`,
    [skill.id, reloadKey],
  );

  const capabilities = skill.manifest.capabilities;
  const capabilitiesRef = useRef<SkillUiCapability[]>(capabilities);
  capabilitiesRef.current = capabilities;

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
      protocol: skill.manifest.protocol,
      capabilities: skill.manifest.capabilities,
      permissions: skill.manifest.permissions,
      sessionNonce,
    };
    win.postMessage({ __24os: true, type: "host.init", payload }, "*");
    pushLog({
      kind: "event",
      method: "host.init",
      detail: `握手 nonce=${sessionNonce.slice(0, 12)}… capabilities=[${capabilities.join(", ")}]`,
    });
  }, [skill.manifest, sessionNonce, capabilities, pushLog]);

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

      void invoke(method, data.params, data.id);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [invoke, respond, sendInit, pushLog]);

  const reload = () => {
    setLogs([]);
    setPermissionUsed(false);
    setReloadKey((key) => key + 1);
  };

  const size = skill.manifest.size ?? { width: 980, height: 660 };

  return (
    <div className="skill-host">
      <div className="skill-host-header">
        <div className="skill-host-title">
          <span className="badge badge-live">Skill UI</span>
          <strong>{skill.title}</strong>
          <span className="skill-host-id">{skill.id}</span>
        </div>
        <div className="skill-host-actions">
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

      <div className="skill-host-body">
        <iframe
          key={reloadKey}
          ref={iframeRef}
          className="skill-frame"
          title={`skill-ui-${skill.id}`}
          sandbox="allow-scripts"
          src={`${API_BASE}/skill-ui/${encodeURIComponent(skill.id)}/${skill.manifest.entry}`}
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
