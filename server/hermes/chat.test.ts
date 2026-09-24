import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { ChatStreamEvent } from "@shared/types";
import { GatewayClient } from "./gateway";
import {
  decideApproval,
  isAutoApprove,
  normalizeGatewayEvent,
  normalizeGatewayRequest,
  streamPrompt,
  switchSessionModel,
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
        case "config.set": {
          const value = String(req.params?.value ?? "");
          const confirmed = req.params?.confirm_expensive_model === true;
          // 昂贵模型场景：value=big-model 且未带 confirm_expensive_model → 需确认；
          // 带了（force / autoApprove 自动 force）→ 放行。
          const expensive = value === "big-model" && !confirmed;
          result = {
            key: String(req.params?.key ?? ""),
            value,
            scope: "session",
            confirm_required: expensive,
            ...(expensive ? { confirm_message: "expensive" } : {}),
          };
          break;
        }
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

    expect(result).toMatchObject({ sessionId: "s1", status: "done" });
    expect(typeof result.chatId).toBe("string");
    expect(result.chatId.length).toBeGreaterThan(0);
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

    expect(result).toMatchObject({ sessionId: "s1", status: "interrupted" });
    expect(typeof result.chatId).toBe("string");
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

describe("streamPrompt —— 模型（M5 热切换研究）", () => {
  it("streamPrompt({ model }) → session.create 带 model", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(eventFrame("message.complete", { text: "ok" }));
      }
    });

    await streamPrompt({ client, prompt: "p", model: "anthropic/claude-x" });
    const created = server.received.find((f) => f.method === "session.create");
    expect(created?.params).toMatchObject({ model: "anthropic/claude-x" });
  });

  it("switchSessionModel → config.set key=model；confirm_required → ok:false", async () => {
    const { client } = await makeConnected();
    const result = await switchSessionModel(client, "s1", "openrouter/gpt-x");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("openrouter/gpt-x");
    expect(result.scope).toBe("session");

    await expect(switchSessionModel(client, "", "m")).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
    await expect(switchSessionModel(client, "s1", "  ")).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });

  it("switchSessionModel 映射 confirm_required → ok:false + confirmRequired", async () => {
    const { client } = await makeConnected();
    const result = await switchSessionModel(client, "s1", "big-model");
    expect(result.ok).toBe(false);
    expect(result.confirmRequired).toBe(true);
    expect(result.confirmMessage).toBe("expensive");
  });

  it("switchSessionModel({force:true}) → config.set 带 confirm_expensive_model → 放行", async () => {
    const { client, server } = await makeConnected();
    const result = await switchSessionModel(client, "s1", "big-model", { force: true });
    expect(result.ok).toBe(true);
    expect(result.confirmRequired).toBeUndefined();

    const call = server.received.find((f) => f.method === "config.set");
    expect(call?.params).toMatchObject({
      key: "model",
      value: "big-model",
      session_id: "s1",
      confirm_expensive_model: true,
    });
    // 契约 Params extra=forbid：绝不能发送未声明的 force 键。
    expect(call?.params).not.toHaveProperty("force");
  });

  it("OS_GATEWAY_AUTO_APPROVE=1 → switchSessionModel 自动 force（不带 options.force）", async () => {
    const prev = process.env.OS_GATEWAY_AUTO_APPROVE;
    process.env.OS_GATEWAY_AUTO_APPROVE = "1";
    try {
      const { client, server } = await makeConnected();
      const result = await switchSessionModel(client, "s1", "big-model");
      expect(result.ok).toBe(true);
      const call = server.received.find((f) => f.method === "config.set");
      expect(call?.params).toMatchObject({ confirm_expensive_model: true });
    } finally {
      if (prev === undefined) delete process.env.OS_GATEWAY_AUTO_APPROVE;
      else process.env.OS_GATEWAY_AUTO_APPROVE = prev;
    }
  });

  it("streamPrompt({model:big-model}) 不带 force → model.confirm_required 事件 + interrupted，不提交 prompt", async () => {
    const { client, server } = await makeConnected();
    const events: ChatStreamEvent[] = [];
    const result = await streamPrompt({
      client,
      prompt: "用昂贵模型",
      model: "big-model",
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("interrupted");
    const confirm = events.find(
      (e) => e.type === "session" && e.event === "model.confirm_required",
    );
    expect(confirm).toBeTruthy();
    const payload = (confirm?.payload ?? {}) as {
      confirmRequired?: boolean;
      confirmMessage?: string;
      model?: string;
    };
    expect(payload.confirmRequired).toBe(true);
    expect(payload.confirmMessage).toBe("expensive");
    expect(payload.model).toBe("big-model");
    // 不静默放行：prompt 从未提交。
    expect(server.received.some((f) => f.method === "prompt.submit")).toBe(false);
    expect(server.received.some((f) => f.method === "session.close")).toBe(true);
    const call = server.received.find((f) => f.method === "config.set");
    expect(call?.params?.confirm_expensive_model).toBeUndefined();
  });

  it("streamPrompt({model:big-model, force:true}) → 带 confirm_expensive_model → 流正常完成", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(eventFrame("message.complete", { text: "ok", status: "complete" }));
      }
    });
    const events: ChatStreamEvent[] = [];
    const result = await streamPrompt({
      client,
      prompt: "用昂贵模型",
      model: "big-model",
      force: true,
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("done");
    expect(
      events.some((e) => e.type === "session" && e.event === "model.confirm_required"),
    ).toBe(false);
    const call = server.received.find((f) => f.method === "config.set");
    expect(call?.params).toMatchObject({ confirm_expensive_model: true });
    expect(server.received.some((f) => f.method === "prompt.submit")).toBe(true);
  });

  it("streamPrompt + OS_GATEWAY_AUTO_APPROVE=1 → 自动 force，昂贵模型不打断", async () => {
    const prev = process.env.OS_GATEWAY_AUTO_APPROVE;
    process.env.OS_GATEWAY_AUTO_APPROVE = "1";
    try {
      const { client, server } = await makeConnected((method, _params, socket) => {
        if (method === "prompt.submit") {
          socket.send(eventFrame("message.complete", { text: "auto", status: "complete" }));
        }
      });
      const events: ChatStreamEvent[] = [];
      const result = await streamPrompt({
        client,
        prompt: "auto",
        model: "big-model",
        onEvent: (event) => events.push(event),
      });
      expect(result.status).toBe("done");
      expect(
        events.some((e) => e.type === "session" && e.event === "model.confirm_required"),
      ).toBe(false);
      const call = server.received.find((f) => f.method === "config.set");
      expect(call?.params).toMatchObject({ confirm_expensive_model: true });
    } finally {
      if (prev === undefined) delete process.env.OS_GATEWAY_AUTO_APPROVE;
      else process.env.OS_GATEWAY_AUTO_APPROVE = prev;
    }
  });
});

describe("streamPrompt —— 交互式审批 / decideApproval（M5）", () => {
  it("interactive approval 挂起 → decideApproval(once) → gateway 收到 {choice:once} → done", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(
          requestFrame("srq-i1", "approval", {
            request_id: "ri1",
            command: "rm -rf /tmp/x",
            choices: ["once", "session", "always", "deny"],
          }),
        );
        // 稍后补 complete，留出决策窗口。
        setTimeout(() => {
          socket.send(eventFrame("message.complete", { text: "approved", status: "complete" }));
        }, 30);
      }
    });

    const chatId = "chat-interactive-1";
    const events: ChatStreamEvent[] = [];
    const result = await streamPrompt({
      client,
      prompt: "危险的",
      chatId,
      interactive: true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "approval") {
          // 事件携带 chatId / id / prompt / choices。
          expect(event.chatId).toBe(chatId);
          expect(event.id).toBe("srq-i1");
          expect(event.choices).toContain("once");
          expect(event.prompt).toContain("rm");
          expect(event.autoDecided).toBe(false);
          const outcome = decideApproval(chatId, { type: "approval", choice: "once" });
          expect(outcome).toMatchObject({ ok: true, requestId: "srq-i1" });
        }
      },
    });

    expect(result.status).toBe("done");
    expect(result.chatId).toBe(chatId);
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-i1",
      result: { choice: "once" },
    });
    // 流结束后 chat 已注销 → 再决策 404。
    expect(() => decideApproval(chatId, { type: "approval", choice: "deny" })).toThrowError(
      /不存在或已结束/,
    );
  });

  it("interactive clarify：decideApproval 回传 answer；非法 choice → DECISION_RESOLVED/INVALID", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(requestFrame("srq-c1", "clarify", { question: "选哪个?", choices: ["甲", "乙"] }));
        setTimeout(() => {
          socket.send(eventFrame("message.complete", { text: "answered" }));
        }, 30);
      }
    });

    const chatId = "chat-clarify-1";
    const result = await streamPrompt({
      client,
      prompt: "p",
      chatId,
      interactive: true,
      onEvent: (event) => {
        if (event.type === "clarify") {
          const outcome = decideApproval(chatId, { type: "clarify", answer: "甲" });
          expect(outcome.decision).toEqual({ answer: "甲" });
          // 已决 → 再次同 type 决策 409。
          expect(() => decideApproval(chatId, { type: "clarify", answer: "乙" })).toThrowError(
            /没有待决/,
          );
        }
      },
    });

    expect(result.status).toBe("done");
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-c1",
      result: { answer: "甲" },
    });
  });

  it("流结束仍 pending → 自动按安全默认兜底 deny + decision.fallback 事件", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(requestFrame("srq-f1", "approval", { command: "ls", choices: ["once", "deny"] }));
        setTimeout(() => {
          socket.send(eventFrame("message.complete", { text: "denied" }));
        }, 20);
      }
    });

    const events: ChatStreamEvent[] = [];
    await streamPrompt({
      client,
      prompt: "p",
      chatId: "chat-fallback-1",
      interactive: true,
      onEvent: (event) => events.push(event),
    });

    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-f1",
      result: { choice: "deny" },
    });
    const fallback = events.find(
      (e) => e.type === "session" && e.event === "decision.fallback",
    );
    expect(fallback).toBeTruthy();
    expect(fallback?.payload).toMatchObject({ reason: "stream_end", choice: "deny" });
  });

  it("decisionTimeoutMs 超时 → 自动 deny + decision.fallback(timeout)", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(requestFrame("srq-t1", "approval", { command: "slow" }));
        setTimeout(() => {
          socket.send(eventFrame("message.complete", { text: "timeout-done" }));
        }, 120);
      }
    });

    const events: ChatStreamEvent[] = [];
    await streamPrompt({
      client,
      prompt: "p",
      chatId: "chat-timeout-1",
      interactive: true,
      decisionTimeoutMs: 30,
      onEvent: (event) => events.push(event),
    });

    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-t1",
      result: { choice: "deny" },
    });
    const fallback = events.find(
      (e) => e.type === "session" && e.event === "decision.fallback",
    );
    expect(fallback?.payload).toMatchObject({ reason: "timeout" });
  });

  it("decideApproval：未知 chatId → CHAT_NOT_FOUND；非法 type/choice → INVALID_VALUE", () => {
    expect(() =>
      decideApproval("nope-chat", { type: "approval", choice: "once" }),
    ).toThrowError(/不存在或已结束/);
    expect(() =>
      decideApproval("x", { type: "bogus" as "approval", choice: "once" }),
    ).toThrowError(/type/);
    expect(() => decideApproval("", { type: "clarify" })).toThrowError(/chatId/);
  });

  it("autoApprove 优先：interactive 下仍立即回 once（不挂起）", async () => {
    const { client, server } = await makeConnected((method, _params, socket) => {
      if (method === "prompt.submit") {
        socket.send(requestFrame("srq-a2", "approval", { command: "ls" }));
        socket.send(eventFrame("message.complete", { text: "ok" }));
      }
    });

    const events: ChatStreamEvent[] = [];
    await streamPrompt({
      client,
      prompt: "p",
      chatId: "chat-auto-1",
      interactive: true,
      autoApprove: true,
      onEvent: (event) => events.push(event),
    });
    expect(server.received).toContainEqual({
      jsonrpc: "2.0",
      id: "srq-a2",
      result: { choice: "once" },
    });
    expect(events.find((e) => e.type === "approval")?.autoDecided).toBe(true);
  });
});
