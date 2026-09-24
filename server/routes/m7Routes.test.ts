import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAppEventListeners } from "../appmanifest/events";
import {
  configureHookExecutor,
  getHookLog,
  resetHookExecutor,
} from "../hooks/executor";
import { hookRoutes } from "./hooks";
import { botRoutes } from "./bots";
import {
  resetSchedulerState,
  startScheduler,
  stopScheduler,
} from "../bot/scheduler";

/**
 * 路由测试（M7）：GET /api/hooks/log、GET /api/bots（fastify.inject）。
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let app: FastifyInstance;

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(hookRoutes);
  await app.register(botRoutes);
  clearAppEventListeners();
  resetHookExecutor();
  resetSchedulerState();
  savedEnv.OS_BOTS_FILE = process.env.OS_BOTS_FILE;
});

afterEach(async () => {
  stopScheduler();
  resetSchedulerState();
  resetHookExecutor();
  clearAppEventListeners();
  await app.close();
  if (savedEnv.OS_BOTS_FILE === undefined) delete process.env.OS_BOTS_FILE;
  else process.env.OS_BOTS_FILE = savedEnv.OS_BOTS_FILE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
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

describe("GET /api/bots", () => {
  it("默认（文件不存在）返回空列表 + 调度器状态", async () => {
    const dir = newTempDir("24os-bots-api-");
    process.env.OS_BOTS_FILE = path.join(dir, "missing.yaml");

    const res = await app.inject({ method: "GET", url: "/api/bots" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bots: unknown[];
      schedulerRunning: boolean;
      file: string;
      log: unknown[];
      message: string;
    };
    expect(body.bots).toEqual([]);
    expect(body.schedulerRunning).toBe(false);
    expect(body.log).toEqual([]);
    expect(body.file).toContain("missing.yaml");
    expect(body.message).toContain("OS_BOT_ENABLED");
  });

  it("读取 bots.yaml 样例并带 nextRun", async () => {
    const dir = newTempDir("24os-bots-api2-");
    const file = path.join(dir, "bots.yaml");
    writeFileSync(
      file,
      `bots:\n  - id: daily-report\n    schedule: "09:00"\n    profile: default\n    prompt: "生成简报"\n    notify: [ops-push]\n    enabled: true\n  - id: off-bot\n    schedule: "10:00"\n    prompt: "x"\n    disable: true\n`,
      "utf8",
    );
    process.env.OS_BOTS_FILE = file;

    // 注入 now 以便 nextRun 稳定
    startScheduler({
      now: () => new Date("2026-09-24T08:00:00"),
      tickMs: 60_000,
    });

    const res = await app.inject({ method: "GET", url: "/api/bots" });
    const body = res.json() as {
      bots: Array<{
        id: string;
        enabled: boolean;
        nextRun: string | null;
        schedule: string;
      }>;
      schedulerRunning: boolean;
      file: string;
    };
    expect(body.bots).toHaveLength(2);
    const daily = body.bots.find((b) => b.id === "daily-report");
    const off = body.bots.find((b) => b.id === "off-bot");
    expect(daily?.enabled).toBe(true);
    expect(daily?.nextRun).toBeTruthy();
    expect(off?.enabled).toBe(false);
    expect(off?.nextRun).toBeNull();
    expect(body.schedulerRunning).toBe(true);
    expect(body.file).toBe(file);
  });
});

describe("POST /api/bots/:id/enable|disable", () => {
  it("未知 bot → 404；已知 → ok（内存态）", async () => {
    const dir = newTempDir("24os-bots-api3-");
    const file = path.join(dir, "bots.yaml");
    writeFileSync(
      file,
      `bots:\n  - id: a-bot\n    schedule: "09:00"\n    prompt: "p"\n`,
      "utf8",
    );
    process.env.OS_BOTS_FILE = file;

    const missing = await app.inject({
      method: "POST",
      url: "/api/bots/nope/disable",
    });
    expect(missing.statusCode).toBe(404);

    const disable = await app.inject({
      method: "POST",
      url: "/api/bots/a-bot/disable",
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ ok: true, id: "a-bot", enabled: false });

    const enable = await app.inject({
      method: "POST",
      url: "/api/bots/a-bot/enable",
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ enabled: true });
  });
});
