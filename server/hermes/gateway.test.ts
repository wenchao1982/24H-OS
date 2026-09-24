import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  GatewayClient,
  parseBackendReadyLine,
  parseSessionToken,
  type GatewayServerRequest,
} from "./gateway";

/** 收到的客户端帧。 */
interface ReceivedFrame {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

/** 起一个本地 mock gateway WS 服务器。 */
async function makeMockServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  received: ReceivedFrame[];
}> {
  const received: ReceivedFrame[] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data) => {
      let req: { id?: string; method?: string; params?: Record<string, unknown> };
      try {
        req = JSON.parse(data.toString()) as typeof req;
      } catch {
        return;
      }
      received.push(req);

      // 通知（无 id）不回应，也不发测试事件。
      if (req.id === undefined) return;

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
        case "session.create":
          result = {
            session_id: "sess-1",
            stored_session_id: "stored-1",
            message_count: 0,
            messages: [],
            info: { profile_name: req.params?.profile ?? "default" },
          };
          break;
        case "prompt.submit":
          result = { status: "streaming" };
          break;
        case "session.interrupt":
          result = { status: "interrupted", interrupted: true };
          break;
        case "session.close":
          result = { closed: true };
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
  return { wss, port, received };
}

const openServers: WebSocketServer[] = [];
const openClients: GatewayClient[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const wss of openServers.splice(0)) {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

async function makeClient(): Promise<{
  client: GatewayClient;
  port: number;
  received: ReceivedFrame[];
}> {
  const { wss, port, received } = await makeMockServer();
  openServers.push(wss);
  const client = new GatewayClient({ port, token: "test-token", connectTimeoutMs: 3000 });
  openClients.push(client);
  await client.connect();
  return { client, port, received };
}

/** 轮询等待直到 predicate 为真或超时。 */
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it("连接后自动声明 client.capabilities（server_requests:true）", async () => {
    const { received } = await makeClient();
    await waitFor(() => received.some((f) => f.method === "client.capabilities"));
    const frame = received.find((f) => f.method === "client.capabilities");
    expect(frame?.params).toMatchObject({ server_requests: true });
    expect(frame?.id).toBeUndefined();
  });

  it("createSession/submitPrompt/interrupt/closeSession 走对应方法与参数", async () => {
    const { client, received } = await makeClient();
    const created = await client.createSession({ title: "t", profile: "p" });
    expect(created.session_id).toBe("sess-1");
    const submitted = await client.submitPrompt("sess-1", "你好");
    expect(submitted.status).toBe("streaming");
    const interrupted = await client.interrupt("sess-1");
    expect(interrupted.status).toBe("interrupted");
    const closed = await client.closeSession("sess-1");
    expect(closed.closed).toBe(true);

    const methods = received.map((f) => f.method);
    expect(methods).toEqual(
      expect.arrayContaining([
        "session.create",
        "prompt.submit",
        "session.interrupt",
        "session.close",
      ]),
    );
    expect(received.find((f) => f.method === "session.create")?.params).toMatchObject({
      title: "t",
      profile: "p",
    });
    expect(received.find((f) => f.method === "prompt.submit")?.params).toMatchObject({
      session_id: "sess-1",
      text: "你好",
    });
  });

  it("服务端→客户端请求：onRequest 收到并可 respond 回应", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    openServers.push(wss);
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;

    let socket: WsSocket | null = null;
    const responses: Array<Record<string, unknown>> = [];
    wss.on("connection", (s) => {
      socket = s;
      s.on("message", (data) => {
        responses.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    const client = new GatewayClient({ port, token: "t", connectTimeoutMs: 3000 });
    openClients.push(client);
    await client.connect();

    const seen: GatewayServerRequest[] = [];
    const off = client.onRequest((request) => seen.push(request));
    socket!.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "srq-1",
        method: "approval",
        params: { session_id: "s1", request_id: "r1", command: "rm -rf /", choices: ["once", "deny"] },
      }),
    );
    await waitFor(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "srq-1", method: "approval" });
    expect(seen[0].params).toMatchObject({ request_id: "r1" });

    expect(client.respond("srq-1", { choice: "deny" })).toBe(true);
    await waitFor(() => responses.some((frame) => frame.id === "srq-1"));
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-1",
      result: { choice: "deny" },
    });
    off();
  });

  it("respondError 回 JSON-RPC error 帧", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    openServers.push(wss);
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    const responses: Array<Record<string, unknown>> = [];
    wss.on("connection", (s) => {
      s.on("message", (data) => responses.push(JSON.parse(data.toString()) as Record<string, unknown>));
    });
    const client = new GatewayClient({ port, token: "t", connectTimeoutMs: 3000 });
    openClients.push(client);
    await client.connect();
    expect(client.respondError("srq-2", 4001, "denied")).toBe(true);
    await waitFor(() => responses.some((frame) => frame.id === "srq-2"));
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-2",
      error: { code: 4001, message: "denied" },
    });
  });
});
