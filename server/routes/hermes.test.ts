import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamPromptOptions } from "../hermes/chat";
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
    expect(body.cliSource).toBeNull();
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
        const { lifecycleError } = await import("../hermes/errors");
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
});
