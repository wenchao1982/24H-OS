import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { ChatStreamEvent } from "@shared/types";
import { GatewayClient } from "./gateway";
import {
  isAutoApprove,
  normalizeGatewayEvent,
  normalizeGatewayRequest,
  streamPrompt,
} from "./chat";

/**
 * chat streamPrompt 测试：用本地 mock gateway（ws）模拟 Hermes TUI gateway，
 * 不触碰真实 hermes / ~/.hermes，也不产生任何模型调用。
 */

interface ReceivedFrame {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** 构造一个事件通知帧。 */
function eventFrame(type: string, payload: Record<string, unknown>, sessionId = "s1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sessionId, payload },
  });
}

/** 构造一个服务端→客户端请求帧。 */
function requestFrame(
  id: string,
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: "s1", ...params } });
}

interface ChatServer {
  wss: WebSocketServer;
  port: number;
  received: ReceivedFrame[];
  socket(): WsSocket | null;
}

/** 起一个 mock chat gateway；handler 在收到每个带 id 的调用后触发。 */
async function makeChatServer(
  handler?: (method: string, params: Record<string, unknown>, socket: WsSocket) => void,
): Promise<ChatServer> {
  const received: ReceivedFrame[] = [];
  let socket: WsSocket | null = null;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  wss.on("connection", (s) => {
    socket = s;
    s.on("message", (data) => {
      let req: ReceivedFrame;
      try {
        req = JSON.parse(data.toString()) as ReceivedFrame;
      } catch {
        return;
      }
      received.push(req);
      if (typeof req.id !== "string") return; // 通知（client.capabilities）不回应

      let result: Record<string, unknown> = {};
      switch (req.method) {
        case "session.create":
          result = {
            session_id: "s1",
            stored_session_id: "s1",
            message_count: 0,
            messages: [],
            info: {},
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
          break;
      }
      s.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
      handler?.(req.method ?? "", req.params ?? {}, s);
    });
  });

  const port = (wss.address() as AddressInfo).port;
  return { wss, port, received, socket: () => socket };
}

const openServers: WebSocketServer[] = [];
const openClients: GatewayClient[] = [];

async function connect(server: ChatServer): Promise<GatewayClient> {
  const client = new GatewayClient({ port: server.port, token: "t", connectTimeoutMs: 3000 });
  openClients.push(client);
  await client.connect();
  return client;
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  for (const wss of openServers.splice(0)) {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

async function makeConnected(
  handler?: (method: string, params: Record<string, unknown>, socket: WsSocket) => void,
): Promise<{ client: GatewayClient; server: ChatServer }> {
  const server = await makeChatServer(handler);
  openServers.push(server.wss);
  const client = await connect(server);
  return { client, server };
}

describe("normalizeGatewayEvent —— 事件归一化", () => {
  it("message.delta / thinking / tool / done / error 映射", () => {
    expect(normalizeGatewayEvent({ type: "message.delta", payload: { text: "hi" } })).toMatchObject({
      type: "delta",
      text: "hi",
    });
    expect(
      normalizeGatewayEvent({ type: "reasoning.delta", payload: { text: "r" } }),
    ).toMatchObject({ type: "thinking", text: "r" });
    expect(
      normalizeGatewayEvent({ type: "tool.start", payload: { tool_id: "t1", name: "shell" } }),
    ).toMatchObject({ type: "tool.start", toolId: "t1", name: "shell" });
    expect(
      normalizeGatewayEvent({ type: "message.complete", payload: { text: "ok", status: "complete" } }),
    ).toMatchObject({ type: "done", text: "ok", status: "complete" });
    expect(normalizeGatewayEvent({ type: "error", payload: { message: "boom" } })).toMatchObject({
      type: "error",
      message: "boom",
    });
  });

  it("session 生命周期事件归到 session；未知类型透出 raw", () => {
    expect(normalizeGatewayEvent({ type: "session.info", payload: { model: "m" } })).toMatchObject({
      type: "session",
      event: "session.info",
    });
    const raw = normalizeGatewayEvent({ type: "weird.event", payload: { x: 1 } });
    expect(raw.type).toBe("raw");
    expect(raw.raw).toEqual({ type: "weird.event", payload: { x: 1 } });
  });
});

describe("normalizeGatewayRequest —— 服务端请求归一化", () => {
  it("approval / clarify / 未知", () => {
    expect(
      normalizeGatewayRequest({
        id: "srq-1",
        method: "approval",
        params: { session_id: "s1", request_id: "r1", command: "rm", choices: ["once", "deny"] },
      }),
    ).toMatchObject({ type: "approval", requestId: "srq-1", command: "rm", choices: ["once", "deny"] });

    expect(
      normalizeGatewayRequest({
        id: "srq-2",
        method: "clarify",
        params: { session_id: "s1", question: "q?", choices: ["a", "b"] },
      }),
    ).toMatchObject({ type: "clarify", requestId: "srq-2", question: "q?" });

    expect(
      normalizeGatewayRequest({ id: "srq-3", method: "sudo", params: { session_id: "s1" } }),
    ).toMatchObject({ type: "raw" });
  });
});

describe("streamPrompt —— 会话 + 流式事件", () => {
  it("session.create → prompt.submit → delta×N + complete → 归一化序列与 done", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(eventFrame("message.delta", { text: "你" }));
        socket.send(eventFrame("message.delta", { text: "好" }));
        socket.send(eventFrame("message.complete", { text: "你好", status: "complete" }));
      }
    });

    const events: ChatStreamEvent[] = [];
    const result = await streamPrompt({
      client,
      prompt: "打个招呼",
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ sessionId: "s1", status: "done" });
    expect(events.map((e) => e.type)).toEqual(["delta", "delta", "done"]);
    expect(events.map((e) => e.text)).toEqual(["你", "好", "你好"]);

    const methods = server.received.map((f) => f.method);
    expect(methods).toEqual(
      expect.arrayContaining(["session.create", "prompt.submit", "session.close"]),
    );
    expect(server.received.find((f) => f.method === "prompt.submit")?.params).toMatchObject({
      session_id: "s1",
      text: "打个招呼",
    });
  });

  it("未知事件类型透出为 raw", async () => {
    const { client } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(eventFrame("mystery.event", { x: 1 }));
        socket.send(eventFrame("message.complete", { text: "done" }));
      }
    });

    const events: ChatStreamEvent[] = [];
    await streamPrompt({ client, prompt: "p", onEvent: (event) => events.push(event) });
    expect(events[0].type).toBe("raw");
    expect(events[0].raw).toMatchObject({ type: "mystery.event" });
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("streamPrompt —— 审批策略", () => {
  it("默认 approval 回 deny，且事件被透出", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(
          requestFrame("srq-1", "approval", {
            request_id: "r1",
            command: "rm -rf /",
            choices: ["once", "deny"],
          }),
        );
        socket.send(eventFrame("message.complete", { text: "denied", status: "complete" }));
      }
    });

    const events: ChatStreamEvent[] = [];
    await streamPrompt({ client, prompt: "危险的", onEvent: (event) => events.push(event) });

    expect(events.some((e) => e.type === "approval" && e.command === "rm -rf /")).toBe(true);
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-1",
      result: { choice: "deny" },
    });
  });

  it("autoApprove 时 approval 回 once、clarify 回第一个选项", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(
          requestFrame("srq-a", "approval", { request_id: "ra", command: "ls", choices: ["once", "deny"] }),
        );
        socket.send(requestFrame("srq-c", "clarify", { question: "选哪个?", choices: ["甲", "乙"] }));
        socket.send(eventFrame("message.complete", { text: "ok" }));
      }
    });

    await streamPrompt({ client, prompt: "p", autoApprove: true });
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-a",
      result: { choice: "once" },
    });
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-c",
      result: { answer: "甲" },
    });
  });

  it("默认 clarify 回空答案；isAutoApprove 读环境变量", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(requestFrame("srq-c", "clarify", { question: "q?", choices: ["甲"] }));
        socket.send(eventFrame("message.complete", { text: "ok" }));
      }
    });

    await streamPrompt({ client, prompt: "p" });
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-c",
      result: { answer: "" },
    });

    expect(isAutoApprove({ OS_GATEWAY_AUTO_APPROVE: "1" })).toBe(true);
    expect(isAutoApprove({})).toBe(false);
  });
});

describe("streamPrompt —— 中断与错误", () => {
  it("abort 触发 interrupt，流以 interrupted 结束", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(eventFrame("message.delta", { text: "开始" }));
        // 不发送 complete，等待客户端中断。
      }
    });

    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    const result = await streamPrompt({
      client,
      prompt: "长任务",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "delta") controller.abort();
      },
    });

    expect(result).toEqual({ sessionId: "s1", status: "interrupted" });
    expect(events.some((e) => e.type === "delta")).toBe(true);
    expect(server.received.some((f) => f.method === "session.interrupt")).toBe(true);
  });

  it("无 CLI（resolveClient 失败）抛 GATEWAY_UNAVAILABLE", async () => {
    await expect(
      streamPrompt({
        prompt: "p",
        resolveClient: async () => {
          const { lifecycleError } = await import("./errors");
          throw lifecycleError("GATEWAY_UNAVAILABLE", "no cli");
        },
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_UNAVAILABLE" });
  });

  it("空 prompt 抛 INVALID_VALUE", async () => {
    await expect(streamPrompt({ prompt: "   " })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });
});
