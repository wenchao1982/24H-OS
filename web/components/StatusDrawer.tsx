import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardEvent } from "@shared/types";
import { API_BASE } from "../api";

/**
 * M7 状态抽屉：Dashboard WS 事件条。
 * - 连接 ws://host/api/ws（dev 经 Vite 代理 ws:true，或直连 API_BASE）
 * - 显示最近 50 条 {time, type, summary}
 * - 断开后指数退避重连（1s → 2s → 4s … 上限 30s），显示「重连中」
 */

const MAX_EVENTS = 50;

type WsState = "connecting" | "open" | "reconnecting" | "closed";

interface EventRow {
  id: number;
  at: string;
  type: string;
  summary: string;
}

function summarize(event: DashboardEvent): string {
  const p = event.payload ?? {};
  const parts: string[] = [];
  for (const key of [
    "id",
    "appId",
    "jobId",
    "name",
    "source",
    "skillId",
    "profile",
    "mode",
    "version",
    "status",
    "via",
    "len",
    "port",
    "message",
    "error",
  ]) {
    const value = p[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value)}`);
  }
  if (parts.length === 0 && Array.isArray(p.results)) {
    parts.push(`results=${p.results.length}`);
  }
  return parts.join(" ") || "—";
}

function resolveWsUrl(): string {
  // 优先同源（Vite 代理 /api ws:true）；失败场景下 API_BASE 直连兜底由调用方处理。
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    // dev: location 是 5173，同源 /api/ws 会经代理到 4319。
    if (window.location.port === "5173" || window.location.port === "5174") {
      return `${proto}//${window.location.host}/api/ws`;
    }
  }
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/api/ws`;
}

let nextId = 1;

export default function StatusDrawer() {
  const [open, setOpen] = useState(false);
  const [wsState, setWsState] = useState<WsState>("connecting");
  const [events, setEvents] = useState<EventRow[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUser = useRef(false);

  const pushEvent = useCallback((event: DashboardEvent) => {
    setEvents((prev) => {
      const row: EventRow = {
        id: nextId++,
        at: event.at,
        type: event.type,
        summary: summarize(event),
      };
      const next = [row, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEffect(() => {
    closedByUser.current = false;

    const connect = () => {
      if (closedByUser.current) return;
      setWsState(retryRef.current === 0 ? "connecting" : "reconnecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(resolveWsUrl());
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setWsState("open");
      };
      ws.onmessage = (message) => {
        try {
          const data: unknown = JSON.parse(String(message.data));
          if (data && typeof data === "object") {
            const event = data as DashboardEvent;
            if (typeof event.type === "string") pushEvent(event);
          }
        } catch {
          // 忽略非 JSON 帧。
        }
      };
      ws.onerror = () => {
        // onclose 会随后触发。
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (closedByUser.current) {
          setWsState("closed");
          return;
        }
        scheduleRetry();
      };
    };

    const scheduleRetry = () => {
      setWsState("reconnecting");
      const attempt = retryRef.current;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      retryRef.current = attempt + 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closedByUser.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [pushEvent]);

  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [open, events]);

  const stateLabel =
    wsState === "open"
      ? "已连接"
      : wsState === "connecting"
        ? "连接中"
        : wsState === "reconnecting"
          ? "重连中"
          : "已断开";

  return (
    <div className="status-drawer-root">
      <button
        type="button"
        className={
          wsState === "open" ? "status-toggle live" : "status-toggle offline"
        }
        onClick={() => setOpen((value) => !value)}
        title="Dashboard 事件"
      >
        状态
        <span className="status-toggle-dot" />
        <span className="status-toggle-label">{stateLabel}</span>
      </button>

      {open && (
        <div className="status-drawer">
          <div className="status-drawer-head">
            <span>Dashboard 事件（最近 {events.length} 条）</span>
            <span className={wsState === "open" ? "ws-pill ok" : "ws-pill warn"}>
              {stateLabel}
            </span>
          </div>
          <div className="status-drawer-list" ref={listRef}>
            {events.length === 0 && (
              <div className="status-drawer-empty">暂无事件</div>
            )}
            {events.map((row) => (
              <div key={row.id} className="status-event-row">
                <span className="status-event-time">
                  {row.at ? new Date(row.at).toLocaleTimeString() : ""}
                </span>
                <span className="status-event-type">{row.type}</span>
                <span className="status-event-summary">{row.summary}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
