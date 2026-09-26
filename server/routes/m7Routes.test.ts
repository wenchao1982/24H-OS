import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAppEventListeners } from "../appmanifest/events";
import {
  configureHookExecutor,
  getHookLog,
  resetHookExecutor,
} from "../hooks/executor";
import { hookRoutes } from "./hooks";

/**
 * 路由测试（M7）：GET /api/hooks/log（fastify.inject）。
 * 定时任务（原 /api/bots）已迁移到官方 Cron，见 server/routes/cron.test.ts。
 */

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(hookRoutes);
  clearAppEventListeners();
  resetHookExecutor();
});

afterEach(async () => {
  resetHookExecutor();
  clearAppEventListeners();
  await app.close();
});

describe("GET /api/hooks/log", () => {
  it("默认返回空 entries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/hooks/log" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[]; total: number };
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("执行 hook 后出现在日志", async () => {
    configureHookExecutor({ broadcast: () => undefined });
    const { runHook } = await import("../hooks/executor");
    const { APP_MANIFEST_PROTOCOL } = await import("@shared/types");
    await runHook("ui.open", {
      protocol: APP_MANIFEST_PROTOCOL,
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      source: { type: "path", path: "/tmp" },
      ui: { skillId: "s1" },
    });

    const res = await app.inject({ method: "GET", url: "/api/hooks/log" });
    const body = res.json() as {
      entries: Array<{ hook: string; appId: string; status: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.entries[0]).toMatchObject({
      hook: "ui.open",
      appId: "demo",
      status: "ok",
    });
    expect(getHookLog().length).toBeGreaterThanOrEqual(1);
  });
});
