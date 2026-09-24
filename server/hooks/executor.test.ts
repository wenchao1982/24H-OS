import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppManifest, DashboardEvent } from "@shared/types";
import { APP_MANIFEST_PROTOCOL } from "@shared/types";
import {
  clearAppEventListeners,
  emitAppEvent,
} from "../appmanifest/events";
import {
  configureHookExecutor,
  getHookLog,
  resetHookExecutor,
  runHook,
  startHookExecutor,
} from "./executor";
import { signPushBody } from "./outbound";

/**
 * hooks 执行体测试（M7）：
 * - app.install → ui.open 广播被调
 * - notify → pushNotify 收到签名正确的请求（mock fetch 复算 HMAC）
 * - 异常 hook 被 catch 记入 log（不抛穿）
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeManifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "demo-app",
    name: "Demo",
    version: "1.0.0",
    source: { type: "path", path: newTempDir("24os-m7-src-") },
    ui: { skillId: "demo-ui", host: "iframe" },
    hooks: { oninstall: ["ui.open", "notify"] },
    plugins: [
      {
        name: "ops-push",
        kind: "http",
        endpoint: "http://example.test/hook",
        envKey: "OPS_TOKEN",
      },
    ],
    profile: {
      env: { OPS_TOKEN: "secret-token-abc" },
      model: { default: "kimi-k2.5" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearAppEventListeners();
  resetHookExecutor();
});

afterEach(() => {
  resetHookExecutor();
  clearAppEventListeners();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("runHook · ui.open", () => {
  it("广播 hook.ui.open（含 skillId / appId）", async () => {
    const events: DashboardEvent[] = [];
    configureHookExecutor({
      broadcast: (e) => events.push({ type: e.type, at: e.at ?? "", payload: e.payload }),
    });

    const manifest = makeManifest();
    const entry = await runHook("ui.open", manifest, {
      ui: { skillId: "demo-ui" },
    });

    expect(entry.status).toBe("ok");
    expect(entry.hook).toBe("ui.open");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hook.ui.open");
    expect(events[0].payload).toMatchObject({
      skillId: "demo-ui",
      appId: "demo-app",
    });
    expect(getHookLog()[0]).toMatchObject({ hook: "ui.open", status: "ok" });
  });
});

describe("runHook · notify", () => {
  it("pushNotify 收到签名正确的请求（mock fetch 复算 HMAC）", async () => {
    const token = "secret-token-abc";
    let captured: { headers: Record<string, string>; body: string } | null =
      null;

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const events: DashboardEvent[] = [];
    configureHookExecutor({
      broadcast: (e) => events.push({ type: e.type, at: e.at ?? "", payload: e.payload }),
      pushNotify: async (plugin, body, options) => {
        const { pushNotify } = await import("./outbound");
        return pushNotify(plugin, body, { ...options, fetchImpl });
      },
      readEnv: async () => ({ OPS_TOKEN: token }),
    });

    const manifest = makeManifest();
    const entry = await runHook("notify", manifest, {
      env: { OPS_TOKEN: token },
      version: "1.0.0",
      mode: "install",
    });

    expect(entry.status).toBe("ok");
    expect(captured).not.toBeNull();
    const { headers, body } = captured!;
    expect(headers["content-type"]).toBe("application/json");
    const ts = Number(headers["x-24os-timestamp"]);
    const provided = headers["x-24os-signature"];
    const recomputed = signPushBody(token, ts, body);
    expect(provided).toBe(`sha256=${recomputed}`);

    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.appId).toBe("demo-app");
    expect(parsed.event).toBe("app.hook");

    const notifyEvent = events.find((e) => e.type === "hook.notify");
    expect(notifyEvent).toBeTruthy();
    expect(notifyEvent?.payload?.results).toEqual([
      expect.objectContaining({ plugin: "ops-push", status: "ok" }),
    ]);
  });
});

describe("runHook · 异常被 catch 记入 log", () => {
  it("config.apply 失败 → status:error 且不抛穿", async () => {
    configureHookExecutor({
      reapplyProfileConfig: async () => {
        throw new Error("boom-config");
      },
    });

    const entry = await runHook("config.apply", makeManifest());
    expect(entry.status).toBe("error");
    expect(entry.error).toContain("boom-config");

    const log = getHookLog();
    expect(log[0]).toMatchObject({
      hook: "config.apply",
      status: "error",
      appId: "demo-app",
    });
  });

  it("notify 推送实现抛错 → error 记录", async () => {
    configureHookExecutor({
      pushNotify: async () => {
        throw new Error("push-fail");
      },
    });
    const entry = await runHook("notify", makeManifest());
    expect(entry.status).toBe("error");
    expect(entry.error).toContain("push-fail");
  });
});

describe("事件总线订阅（app.install）", () => {
  it("emit app.install → executor 执行 ui.open + notify 并广播生命周期", async () => {
    const events: DashboardEvent[] = [];
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    configureHookExecutor({
      broadcast: (e) => events.push({ type: e.type, at: e.at ?? "", payload: e.payload }),
      pushNotify: async (plugin, body, options) => {
        const { pushNotify } = await import("./outbound");
        return pushNotify(plugin, body, { ...options, fetchImpl });
      },
    });
    startHookExecutor();

    const manifest = makeManifest({
      hooks: { oninstall: ["ui.open", "notify"] },
    });

    emitAppEvent("app.install", {
      id: manifest.id,
      version: manifest.version,
      mode: "install",
      hooks: ["ui.open", "notify"],
      ui: manifest.ui,
      at: new Date().toISOString(),
      manifest,
    });

    // 异步 fire-and-forget：轮询等待
    await vi.waitFor(() => {
      expect(getHookLog().length).toBeGreaterThanOrEqual(2);
    });

    expect(events.some((e) => e.type === "app.install")).toBe(true);
    expect(events.some((e) => e.type === "hook.ui.open")).toBe(true);
    expect(events.some((e) => e.type === "hook.notify")).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
  });
});
