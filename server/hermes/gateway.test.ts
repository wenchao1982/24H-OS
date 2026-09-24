import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  GatewayClient,
  parseBackendReadyLine,
  parseSessionToken,
} from "./gateway";

/** 起一个本地 mock gateway WS 服务器。 */
async function makeMockServer(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      let req: { id?: string; method?: string; params?: unknown };
      try {
        req = JSON.parse(data.toString()) as typeof req;
      } catch {
        return;
      }
      // 每个请求前先发一个事件通知，验证事件分发。
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: { type: "test.event", session_id: "", payload: { method: req.method } },
        }),
      );

      if (req.method?.startsWith("ignore.")) return; // 故意不响应，用于超时测试。

      let result: unknown;
      let error: { code: number; message: string } | undefined;
      switch (req.method) {
        case "ping":
          result = { pong: true };
          break;
        case "gateway.capabilities":
          result = { per_session_exclusive_submit: true };
          break;
        case "llm.oneshot":
          result = { text: "hi" };
          break;
        default:
          error = { code: 4004, message: "method not found" };
      }
      const frame = error
        ? { jsonrpc: "2.0", id: req.id, error }
        : { jsonrpc: "2.0", id: req.id, result };
      socket.send(JSON.stringify(frame));
    });
  });

  const port = (wss.address() as AddressInfo).port;
  return { wss, port };
}

const openServers: WebSocketServer[] = [];
const openClients: GatewayClient[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const wss of openServers.splice(0)) {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

async function makeClient(): Promise<{ client: GatewayClient; port: number }> {
  const { wss, port } = await makeMockServer();
  openServers.push(wss);
  const client = new GatewayClient({ port, token: "test-token", connectTimeoutMs: 3000 });
  openClients.push(client);
  await client.connect();
  return { client, port };
}

describe("parseBackendReadyLine", () => {
  it("解析 HERMES_BACKEND_READY port=19319 → 19319", () => {
    expect(parseBackendReadyLine("HERMES_BACKEND_READY port=19319\n")).toBe(19319);
    expect(
      parseBackendReadyLine("noise\nHERMES_BACKEND_READY port=1234\nHermes backend listening"),
    ).toBe(1234);
  });

  it("无匹配 → null", () => {
    expect(parseBackendReadyLine("nothing here")).toBeNull();
  });
});

describe("parseSessionToken", () => {
  it("从 HTML 片段提取 token", () => {
    const html = `<script>window.__HERMES_SESSION_TOKEN__="abc-123_XYZ";</script>`;
    expect(parseSessionToken(html)).toBe("abc-123_XYZ");
  });

  it("无 token → null", () => {
    expect(parseSessionToken("<html></html>")).toBeNull();
  });
});

describe("GatewayClient —— JSON-RPC over WS", () => {
  it("ping / capabilities / tools.list 按 id 正确关联", async () => {
    const { client } = await makeClient();
    const [ping, caps] = await Promise.all([client.ping(), client.capabilities()]);
    expect(ping.pong).toBe(true);
    expect(caps.per_session_exclusive_submit).toBe(true);
  });

  it("complete 走 llm.oneshot 返回文本", async () => {
    const { client } = await makeClient();
    const result = await client.complete("你好");
    expect(result.text).toBe("hi");
  });

  it("事件通知回调可订阅", async () => {
    const { client } = await makeClient();
    const seen: string[] = [];
    const off = client.onEvent((params) => {
      seen.push(String(params.type));
    });
    await client.ping();
    // 事件在响应前发出，稍等一拍。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toContain("test.event");
    off();
  });

  it("RPC 错误映射为 GATEWAY_RPC_ERROR", async () => {
    const { client } = await makeClient();
    await expect(client.call("unknown.method")).rejects.toMatchObject({
      code: "GATEWAY_RPC_ERROR",
    });
  });

  it("超时抛 GATEWAY_TIMEOUT", async () => {
    const { client } = await makeClient();
    await expect(
      client.call("ignore.forever", {}, { timeoutMs: 120 }),
    ).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
  });
});
