import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatDecisionInput, StreamPromptOptions } from "../hermes/chat";
import { lifecycleError } from "../hermes/errors";
import { hermesRoutes } from "./hermes";

/**
 * Hermes 路由测试（fastify.inject）。
 * 用临时 HOME + 不存在的 OS_HERMES_CLI + 空 PATH 隔离，确保不探测/启动真实 hermes。
 */

const tempDirs: string[] = [];
let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  app = Fastify();
  await app.register(hermesRoutes);

  saved.HOME = process.env.HOME;
  saved.PATH = process.env.PATH;
  saved.OS_HERMES_CLI = process.env.OS_HERMES_CLI;
  saved.OS_HERMES_HOME = process.env.OS_HERMES_HOME;
  saved.HERMES_HOME = process.env.HERMES_HOME;

  const home = newTempDir("24os-hermes-route-home-");
  process.env.HOME = home;
  delete process.env.OS_HERMES_HOME;
  delete process.env.HERMES_HOME;
  process.env.OS_HERMES_CLI = path.join(home, "missing-hermes");
  process.env.PATH = "/nonexistent";
});

afterEach(async () => {
  await app.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/hermes/status", () => {
  it("无 CLI / 无 home 时返回探测字段且 mode=mock", async () => {
    const res = await app.inject({ method: "GET", url: "/api/hermes/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("mock");
    expect(body.cliPath).toBeNull();
    // OS_HERMES_CLI 显式指向不存在的路径 → 不可用但来源标为 env（无效即停，不回退）。
    expect(body.cliSource).toBe("env");
    expect(Array.isArray(body.hermesHomes)).toBe(true);
    expect(typeof body.activeHome).toBe("string");
  });
});

describe("GET /api/hermes/gateway", () => {
  it("未运行时 running=false 且给出说明", async () => {
    const res = await app.inject({ method: "GET", url: "/api/hermes/gateway" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.running).toBe(false);
    expect(body.port).toBeNull();
    expect(body.connected).toBe(false);
    expect(body.cliPath).toBeNull();
    expect(body.message).toContain("stub");
  });
});

describe("POST /api/hermes/gateway/start", () => {
  it("无 CLI → 503 HERMES_CLI_UNAVAILABLE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/gateway/start",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("HERMES_CLI_UNAVAILABLE");
  });
});

describe("POST /api/hermes/gateway/stop", () => {
  it("幂等：未运行时也返回 200", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/gateway/stop",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().running).toBe(false);
  });
});

/** 解析 SSE 响应体为事件数组。 */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data:"))
    .map((chunk) => JSON.parse(chunk.slice("data:".length).trim()) as Record<string, unknown>);
}

describe("POST /api/hermes/chat/stream —— SSE", () => {
  it("空 prompt → 400 INVALID_VALUE（未接管响应）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/chat/stream",
      payload: { prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_VALUE");
  });

  it("把归一化事件逐条推送，done 后结束响应", async () => {
    const sseApp = Fastify();
    await sseApp.register(hermesRoutes, {
      streamPrompt: async (options: StreamPromptOptions) => {
        options.onEvent?.({ type: "delta", sessionId: "s1", text: "你" });
        options.onEvent?.({ type: "delta", sessionId: "s1", text: "好" });
        options.onEvent?.({ type: "done", sessionId: "s1", text: "你好", status: "complete" });
        return { sessionId: "s1", status: "done" };
      },
    });

    const res = await sseApp.inject({
      method: "POST",
      url: "/api/hermes/chat/stream",
      payload: { prompt: "hi", profile: "p" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(res.body);
    expect(events.map((event) => event.type)).toEqual(["delta", "delta", "done"]);
    expect(events[2].text).toBe("你好");
    await sseApp.close();
  });

  it("streamPrompt 抛错 → 推送 error 事件（含错误码）", async () => {
    const sseApp = Fastify();
    await sseApp.register(hermesRoutes, {
      streamPrompt: async () => {
        throw lifecycleError("GATEWAY_UNAVAILABLE", "no cli");
      },
    });

    const res = await sseApp.inject({
      method: "POST",
      url: "/api/hermes/chat/stream",
      payload: { prompt: "hi" },
    });

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "GATEWAY_UNAVAILABLE" });
    await sseApp.close();
  });

  it("透传 chatId / model，并以 interactive:true 运行（M5）", async () => {
    const captured: Partial<StreamPromptOptions> = {};
    const sseApp = Fastify();
    await sseApp.register(hermesRoutes, {
      streamPrompt: async (options: StreamPromptOptions) => {
        Object.assign(captured, options);
        options.onEvent?.({ type: "done", sessionId: "s1", text: "ok", status: "complete" });
        return { sessionId: "s1", status: "done", chatId: options.chatId ?? "gen" };
      },
    });

    const res = await sseApp.inject({
      method: "POST",
      url: "/api/hermes/chat/stream",
      payload: { prompt: "hi", chatId: "chat-route-1", model: "m-x", profile: "writer" },
    });

    expect(res.statusCode).toBe(200);
    expect(captured.chatId).toBe("chat-route-1");
    expect(captured.model).toBe("m-x");
    expect(captured.profile).toBe("writer");
    expect(captured.interactive).toBe(true);
    await sseApp.close();
  });

  it("SSE body.force=true 透传给 streamPrompt；缺省不带 force（M5 昂贵模型确认）", async () => {
    const captured: StreamPromptOptions[] = [];
    const sseApp = Fastify();
    await sseApp.register(hermesRoutes, {
      streamPrompt: async (options: StreamPromptOptions) => {
        captured.push(options);
        options.onEvent?.({ type: "done", sessionId: "s1", text: "ok", status: "complete" });
        return { sessionId: "s1", status: "done", chatId: options.chatId ?? "gen" };
      },
    });

    await sseApp.inject({
      method: "POST",
      url: "/api/hermes/chat/stream",
      payload: { prompt: "a", model: "big-model", force: true },
    });
    await sseApp.inject({
      method: "POST",
      url: "/api/hermes/chat/stream",
      payload: { prompt: "b", model: "big-model" },
    });

    expect(captured[0]?.force).toBe(true);
    expect(captured[1]?.force).toBeUndefined();
    await sseApp.close();
  });
});

describe("POST /api/hermes/chat/decide —— 交互式决策", () => {
  it("缺 chatId / type → 400 INVALID_VALUE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/chat/decide",
      payload: { type: "approval" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_VALUE");

    const res2 = await app.inject({
      method: "POST",
      url: "/api/hermes/chat/decide",
      payload: { chatId: "c1", type: "nope" },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error).toBe("INVALID_VALUE");
  });

  it("未知 chatId → 404 CHAT_NOT_FOUND（真实 decideApproval，空注册表）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/chat/decide",
      payload: { chatId: "missing-chat", type: "approval", choice: "once" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("CHAT_NOT_FOUND");
  });

  it("已决（无 pending）→ 409 DECISION_RESOLVED（注入 decideApproval）", async () => {
    const decideApp = Fastify();
    await decideApp.register(hermesRoutes, {
      decideApproval: () => {
        throw lifecycleError("DECISION_RESOLVED", "没有待决的 approval 请求。");
      },
    });
    const res = await decideApp.inject({
      method: "POST",
      url: "/api/hermes/chat/decide",
      payload: { chatId: "c1", type: "approval", choice: "deny" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("DECISION_RESOLVED");
    await decideApp.close();
  });

  it("成功决策 → 200 { ok, requestId, decision }", async () => {
    const decideApp = Fastify();
    await decideApp.register(hermesRoutes, {
      decideApproval: (chatId: string, decision: ChatDecisionInput) => ({
        ok: true as const,
        chatId,
        requestId: "srq-1",
        type: decision.type,
        decision:
          decision.type === "approval"
            ? { choice: decision.choice ?? "deny" }
            : { answer: decision.answer ?? "" },
      }),
    });
    const res = await decideApp.inject({
      method: "POST",
      url: "/api/hermes/chat/decide",
      payload: { chatId: "c1", type: "approval", choice: "once" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      chatId: "c1",
      requestId: "srq-1",
      decision: { choice: "once" },
    });
    await decideApp.close();
  });
});

describe("POST /api/hermes/subagent —— M5 研究结论", () => {
  it("缺 confirm → 400 CONFIRM_REQUIRED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/subagent",
      payload: { prompt: "干活" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
  });

  it("confirm + 空 prompt → 400 INVALID_VALUE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/subagent",
      payload: { prompt: "   ", confirm: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_VALUE");
  });

  it("confirm + prompt → 501 UNSUPPORTED + 契约研究结论（不调模型）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hermes/subagent",
      payload: { prompt: "干活", confirm: true, profile: "writer" },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body).toMatchObject({ ok: false, supported: false, code: "UNSUPPORTED" });
    expect(body.contract.spawnSupported).toBe(false);
    expect(body.contract.observeSupported).toBe(true);
    expect(Array.isArray(body.contract.methods)).toBe(true);
  });
});
