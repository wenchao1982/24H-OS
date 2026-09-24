import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { DashboardEvent } from "@shared/types";
import { setBroadcast } from "../dashboard/bus";

/**
 * Dashboard WebSocket（M7）：`GET /api/ws`。
 *
 * 鉴权同安全基线：
 *   - 回环监听 → 匿名可连；
 *   - 非回环监听 → 必须 `?token=` 或 `x-24os-token` === OS_TOKEN，否则 401 关闭。
 *
 * 协议（JSON）：
 *   - 服务端→客户端：`{ type, at, payload? }`
 *   - 客户端→服务端：`{ type: "ping" }` → `{ type: "pong", at }`
 *
 * 连接管理：Map<ws,{alive}>；30s 心跳；关闭清理。
 */

/** 心跳间隔（毫秒）。 */
export const WS_HEARTBEAT_MS = 30_000;

export interface WsAuthInput {
  /** 进程监听的 HOST。 */
  host: string;
  /** OS_TOKEN（非回环时必填）。 */
  token: string | null;
  /** URL query `token`。 */
  queryToken?: string | null;
  /** 请求头 x-24os-token。 */
  headerToken?: string | string[] | undefined;
}

/** 是否回环主机（与 server/index.ts 一致）。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

/**
 * WS 鉴权（纯函数，便于单测）。
 * 回环 → true；非回环 → 必须提供匹配 OS_TOKEN 的 query 或 header。
 */
export function checkWsAuth(input: WsAuthInput): boolean {
  if (isLoopbackHost(input.host)) return true;
  if (!input.token) return false;
  const header = Array.isArray(input.headerToken)
    ? input.headerToken[0]
    : input.headerToken;
  const provided = input.queryToken?.trim() || header?.trim();
  return provided === input.token;
}

/** 从 upgrade 请求解析 query token 与 header token。 */
export function parseWsAuthFromRequest(
  req: IncomingMessage,
): { queryToken: string | null; headerToken: string | string[] | undefined } {
  let queryToken: string | null = null;
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    queryToken = url.searchParams.get("token");
  } catch {
    queryToken = null;
  }
  return { queryToken, headerToken: req.headers["x-24os-token"] };
}

/** 手写 HTTP 401 响应并销毁 socket（upgrade 前拒绝）。 */
function rejectUpgrade(socket: Duplex, status: 401 | 404, message: string): void {
  const body = JSON.stringify({ error: status === 401 ? "UNAUTHORIZED" : "NOT_FOUND", message });
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
}

export interface DashboardWsOptions {
  /** 监听 HOST（默认 process.env.HOST || 127.0.0.1）。 */
  host?: string;
  /** OS_TOKEN（默认 process.env.OS_TOKEN）。 */
  token?: string | null;
  /** 心跳间隔，默认 30s。 */
  heartbeatMs?: number;
}

export interface DashboardWsHandle {
  /** 向全部连接广播。 */
  broadcast(event: DashboardEvent): void;
  /** 当前连接数。 */
  clientCount(): number;
  /** 关闭 WS（卸载 upgrade / 心跳 / 广播）。 */
  close(): void;
}

/**
 * 在 Fastify 的底层 server 上挂载 `/api/ws` upgrade，并接管 dashboard 广播。
 */
export function attachDashboardWs(
  app: FastifyInstance,
  options: DashboardWsOptions = {},
): DashboardWsHandle {
  const host = options.host ?? (process.env.HOST?.trim() || "127.0.0.1");
  const token =
    options.token !== undefined
      ? options.token
      : process.env.OS_TOKEN?.trim() || null;
  const heartbeatMs = options.heartbeatMs ?? WS_HEARTBEAT_MS;

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, { alive: boolean }>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      pathname = "/";
    }
    if (pathname !== "/api/ws") {
      // 非本端点：交给其它 upgrade 监听者；无则 404。
      const hasOther = app.server
        .listeners("upgrade")
        .some((fn) => fn !== onUpgrade);
      if (!hasOther) rejectUpgrade(socket, 404, `未找到 WS 端点：${pathname}`);
      return;
    }

    const { queryToken, headerToken } = parseWsAuthFromRequest(req);
    if (!checkWsAuth({ host, token, queryToken, headerToken })) {
      rejectUpgrade(socket, 401, "缺少或无效的 WS token。");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  app.server.on("upgrade", onUpgrade);

  const send = (ws: WebSocket, data: unknown): void => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // 单连接失败忽略。
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    clients.set(ws, { alive: true });

    send(ws, {
      type: "hello",
      at: new Date().toISOString(),
      payload: { service: "24h-os-dashboard" },
    });

    ws.on("pong", () => {
      const state = clients.get(ws);
      if (state) state.alive = true;
    });

    ws.on("message", (raw) => {
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const obj = frame as Record<string, unknown>;
      if (obj.type === "ping") {
        send(ws, { type: "pong", at: new Date().toISOString() });
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        clients.delete(ws);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      state.alive = false;
      try {
        ws.ping();
      } catch {
        clients.delete(ws);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const broadcastFn = (event: DashboardEvent): void => {
    const data = JSON.stringify(event);
    for (const ws of clients.keys()) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          // ignore
        }
      }
    }
  };

  const unloadBroadcast = setBroadcast(broadcastFn);

  const close = (): void => {
    clearInterval(heartbeat);
    unloadBroadcast();
    app.server.off("upgrade", onUpgrade);
    for (const ws of clients.keys()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    clients.clear();
    try {
      wss.close();
    } catch {
      // ignore
    }
  };

  return {
    broadcast: broadcastFn,
    clientCount: () => clients.size,
    close,
  };
}
