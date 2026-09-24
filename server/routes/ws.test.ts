import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBroadcast } from "../dashboard/bus";
import {
  attachDashboardWs,
  checkWsAuth,
  isLoopbackHost,
  type DashboardWsHandle,
} from "./ws";

/**
 * Dashboard WS 测试（M7）：
 * - 真实 server（临时端口）连 ws 客户端，broadcast → 收到消息
 * - ping → pong
 * - 非回环 + 无 token → 401（checkWsAuth 纯函数 + 真实 upgrade 拒绝）
 */

let app: FastifyInstance;
let handle: DashboardWsHandle | null;
let port: number;

beforeEach(async () => {
  app = Fastify({ logger: false });
  handle = null;
  port = 0;
});

afterEach(async () => {
  try {
    handle?.close();
  } catch {
    // ignore
  }
  handle = null;
  setBroadcast(null);
  await app.close();
});

async function listen(
  host = "127.0.0.1",
  token: string | null = null,
): Promise<void> {
  await app.listen({ port: 0, host });
  const address = app.server.address() as AddressInfo;
  port = address.port;
  handle = attachDashboardWs(app, { host, token, heartbeatMs: 50_000 });
}

function wsUrl(pathAndQuery = "/api/ws"): string {
  return `ws://127.0.0.1:${port}${pathAndQuery}`;
}

/** 连接并从建立瞬间开始缓冲消息，避免 hello 竞态。 */
function connectBuffered(
  url: string,
): Promise<{
  ws: WebSocket;
  next: (
    predicate?: (data: unknown) => boolean,
    timeoutMs?: number,
  ) => Promise<unknown>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffer: unknown[] = [];
    const waiters: Array<{
      predicate?: (data: unknown) => boolean;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];

    const tryDeliver = (item: unknown): void => {
      for (let i = 0; i < waiters.length; i += 1) {
        const waiter = waiters[i];
        if (!waiter.predicate || waiter.predicate(item)) {
          clearTimeout(waiter.timer);
          waiters.splice(i, 1);
          waiter.resolve(item);
          return;
        }
      }
      buffer.push(item);
    };

    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        data = raw.toString();
      }
      tryDeliver(data);
    });

    const timer = setTimeout(() => reject(new Error("connect timeout")), 3000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        next: (predicate, timeoutMs = 3000) => {
          const bufferedIdx = buffer.findIndex(
            (item) => !predicate || predicate(item),
          );
          if (bufferedIdx >= 0) {
            const [item] = buffer.splice(bufferedIdx, 1);
            return Promise.resolve(item);
          }
          return new Promise((res, rej) => {
            const waitTimer = setTimeout(
              () => rej(new Error("message timeout")),
              timeoutMs,
            );
            waiters.push({
              predicate,
              resolve: res,
              reject: rej,
              timer: waitTimer,
            });
          });
        },
      });
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("checkWsAuth（token 校验函数）", () => {
  it("回环 → 匿名放行", () => {
    expect(checkWsAuth({ host: "127.0.0.1", token: null })).toBe(true);
    expect(checkWsAuth({ host: "localhost", token: "t" })).toBe(true);
    expect(checkWsAuth({ host: "::1", token: "t" })).toBe(true);
  });

  it("非回环 + 无 token 配置 → 拒绝", () => {
    expect(checkWsAuth({ host: "0.0.0.0", token: null })).toBe(false);
  });

  it("非回环 + 错误 token → 拒绝", () => {
    expect(
      checkWsAuth({ host: "0.0.0.0", token: "secret", queryToken: "bad" }),
    ).toBe(false);
    expect(
      checkWsAuth({ host: "0.0.0.0", token: "secret", headerToken: "bad" }),
    ).toBe(false);
  });

  it("非回环 + 正确 query/header token → 放行", () => {
    expect(
      checkWsAuth({ host: "0.0.0.0", token: "secret", queryToken: "secret" }),
    ).toBe(true);
    expect(
      checkWsAuth({ host: "0.0.0.0", token: "secret", headerToken: "secret" }),
    ).toBe(true);
  });

  it("isLoopbackHost", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});

describe("GET /api/ws（回环真实连接）", () => {
  it("连接收到 hello；broadcast 能收到；ping→pong", async () => {
    await listen("127.0.0.1", null);
    const { ws, next } = await connectBuffered(wsUrl());

    const hello = await next((d) => (d as { type?: string }).type === "hello");
    expect((hello as { type: string }).type).toBe("hello");
    expect((hello as { payload?: { service?: string } }).payload?.service).toBe(
      "24h-os-dashboard",
    );

    // broadcast
    const gotBroadcast = next((d) => (d as { type?: string }).type === "app.install");
    handle!.broadcast({
      type: "app.install",
      at: new Date().toISOString(),
      payload: { id: "demo-app", version: "1.0.0" },
    });
    const event = (await gotBroadcast) as {
      type: string;
      payload: { id: string };
    };
    expect(event.payload.id).toBe("demo-app");

    // ping → pong
    const pong = next((d) => (d as { type?: string }).type === "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    const pongMsg = (await pong) as { type: string };
    expect(pongMsg.type).toBe("pong");

    ws.close();
  });
});

describe("非回环鉴权（upgrade 拒绝）", () => {
  it("无/错 token → 升级被拒（401）；正确 query token 可连", async () => {
    // 挂载时 host=0.0.0.0 → 强制走 token 校验（真实监听仍在 127.0.0.1）。
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    port = address.port;
    handle = attachDashboardWs(app, {
      host: "0.0.0.0",
      token: "secret-ws-token",
      heartbeatMs: 50_000,
    });

    let failure = "";
    try {
      await connectBuffered(wsUrl("/api/ws"));
    } catch (error) {
      failure = (error as Error).message;
    }
    // 无 token → 401（或 ws 库包装后的 Unexpected server response: 401）
    expect(failure).toMatch(/401/);

    const { ws, next } = await connectBuffered(
      wsUrl("/api/ws?token=secret-ws-token"),
    );
    const hello = await next((d) => (d as { type?: string }).type === "hello");
    expect((hello as { type: string }).type).toBe("hello");
    ws.close();
  });
});
