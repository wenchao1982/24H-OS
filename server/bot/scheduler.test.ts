import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig, DashboardEvent } from "@shared/types";
import { setBroadcast } from "../dashboard/bus";
import {
  getBotLog,
  isSchedulerRunning,
  listBotsForApi,
  resetSchedulerState,
  runBotOnce,
  schedulerTick,
  setBotEnabled,
  startScheduler,
  stopScheduler,
} from "./scheduler";

/**
 * Bot Mode 调度器测试（M7）：
 * - 假时钟到 09:00 → 触发 run（mock streamPrompt/completePrompt）
 * - 广播 bot.run + pushNotify 调用
 * - 同一分钟不重复跑
 * - enabled:false 不跑
 */

const savedEnv: Record<string, string | undefined> = {};

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "daily-report",
    schedule: "09:00",
    profile: "default",
    prompt: "生成简报",
    notify: ["ops-push"],
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetSchedulerState();
  setBroadcast(null);
  savedEnv.OS_BOTS_FILE = process.env.OS_BOTS_FILE;
});

afterEach(() => {
  resetSchedulerState();
  setBroadcast(null);
  if (savedEnv.OS_BOTS_FILE === undefined) delete process.env.OS_BOTS_FILE;
  else process.env.OS_BOTS_FILE = savedEnv.OS_BOTS_FILE;
  vi.restoreAllMocks();
});

describe("schedulerTick", () => {
  it("到 09:00 → 执行 runPrompt、pushNotify、广播 bot.run", async () => {
    const events: DashboardEvent[] = [];
    setBroadcast((e) => events.push(e));

    const runPrompt = vi.fn(async () => ({ text: "简报正文ABC" }));
    const pushNotify = vi.fn(async () => ({ status: "ok" as const }));
    const now = new Date("2026-09-24T09:00:05");

    const deps = {
      now: () => now,
      loadRoster: () => ({ bots: [bot()], errors: [], file: "/tmp/bots.yaml" }),
      runPrompt,
      pushNotify,
      broadcast: (e: { type: string; at?: string; payload?: Record<string, unknown> }) =>
        events.push({ type: e.type, at: e.at ?? "", payload: e.payload }),
      // resolveNotifyTargets 用真实 store（无安装记录 → 无目标），
      // 因此这里不依赖 notify 解析；run 本身仍应成功。
    };

    schedulerTick(deps);

    await vi.waitFor(() => {
      expect(runPrompt).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "bot.run")).toBe(true);
    });

    const runEvent = events.find((e) => e.type === "bot.run");
    expect(runEvent?.payload).toMatchObject({ botId: "daily-report", status: "ok" });
    // 正文长度在 payload，绝无正文本身
    expect(runEvent?.payload).not.toHaveProperty("text");
    expect(String(runEvent?.payload?.len)).toBe("7"); // "简报正文ABC".length === 7

    const log = getBotLog();
    expect(log[0]).toMatchObject({ botId: "daily-report", status: "ok", len: 7 });
  });

  it("同一分钟不重复跑", async () => {
    const runPrompt = vi.fn(async () => ({ text: "x" }));
    const now = new Date("2026-09-24T09:00:10");
    const deps = {
      now: () => now,
      loadRoster: () => ({ bots: [bot()], errors: [], file: "f" }),
      runPrompt,
      pushNotify: vi.fn(async () => ({ status: "ok" as const })),
    };

    schedulerTick(deps);
    schedulerTick(deps);
    schedulerTick(deps);

    await vi.waitFor(() => {
      expect(runPrompt).toHaveBeenCalledTimes(1);
    });
    // 再 tick 仍不重复
    schedulerTick(deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  it("enabled:false 不跑", async () => {
    const runPrompt = vi.fn(async () => ({ text: "x" }));
    const now = new Date("2026-09-24T09:00:00");
    schedulerTick({
      now: () => now,
      loadRoster: () => ({
        bots: [bot({ enabled: false })],
        errors: [],
        file: "f",
      }),
      runPrompt,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it("内存 disable 后不跑", async () => {
    const runPrompt = vi.fn(async () => ({ text: "x" }));
    const roster = { bots: [bot()], errors: [], file: "f" };
    // 注入 loadRoster 供 setBotEnabled 查找
    startScheduler({
      now: () => new Date("2026-09-24T09:00:00"),
      tickMs: 60_000,
      loadRoster: () => roster,
      runPrompt,
    });
    expect(setBotEnabled("daily-report", false)).toBe(true);
    expect(setBotEnabled("missing", false)).toBe(false);

    schedulerTick({
      now: () => new Date("2026-09-24T09:00:00"),
      loadRoster: () => roster,
      runPrompt,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(runPrompt).not.toHaveBeenCalled();

    // enable 后可跑
    expect(setBotEnabled("daily-report", true)).toBe(true);
    schedulerTick({
      now: () => new Date("2026-09-24T09:00:00"),
      loadRoster: () => roster,
      runPrompt,
    });
    await vi.waitFor(() => {
      expect(runPrompt).toHaveBeenCalledTimes(1);
    });
    stopScheduler();
  });

  it("非调度时刻不跑", async () => {
    const runPrompt = vi.fn(async () => ({ text: "x" }));
    schedulerTick({
      now: () => new Date("2026-09-24T08:59:00"),
      loadRoster: () => ({ bots: [bot()], errors: [], file: "f" }),
      runPrompt,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(runPrompt).not.toHaveBeenCalled();
  });
});

describe("runBotOnce 错误路径", () => {
  it("runPrompt 抛错 → status:error 广播 + 日志，不抛穿", async () => {
    const events: DashboardEvent[] = [];
    const result = await runBotOnce(
      bot(),
      {
        runPrompt: async () => {
          throw new Error("model-down");
        },
        broadcast: (e) =>
          events.push({ type: e.type, at: e.at ?? "", payload: e.payload }),
      },
      new Date("2026-09-24T09:00:00"),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("model-down");
    expect(events.some((e) => e.type === "bot.run" && e.payload?.status === "error")).toBe(true);
    expect(getBotLog()[0].status).toBe("error");
  });
});

describe("start/stopScheduler", () => {
  it("start 后 running，stop 后不 running；tick 定时触发", async () => {
    const runPrompt = vi.fn(async () => ({ text: "x" }));
    // 使用极短 tick + 假时钟固定 09:00
    const now = new Date("2026-09-24T09:00:00");
    startScheduler({
      now: () => now,
      tickMs: 30,
      loadRoster: () => ({ bots: [bot()], errors: [], file: "f" }),
      runPrompt,
      pushNotify: async () => ({ status: "ok" as const }),
    });
    expect(isSchedulerRunning()).toBe(true);
    await vi.waitFor(() => {
      expect(runPrompt).toHaveBeenCalled();
    });
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });
});

describe("listBotsForApi", () => {
  it("返回 nextRun / lastRun", async () => {
    const roster = { bots: [bot()], errors: [], file: "/tmp/b.yaml" };
    // 先跑一次写入 lastRun
    await runBotOnce(
      bot(),
      {
        runPrompt: async () => ({ text: "hello" }),
        broadcast: () => undefined,
      },
      new Date("2026-09-24T09:00:00"),
    );

    // listBotsForApi 使用 currentDeps；start 一下注入
    startScheduler({
      now: () => new Date("2026-09-24T10:00:00"),
      tickMs: 60_000,
      loadRoster: () => roster,
    });
    const { bots, file } = listBotsForApi();
    expect(file).toBe("/tmp/b.yaml");
    expect(bots).toHaveLength(1);
    expect(bots[0].nextRun).toBeTruthy();
    expect(bots[0].lastRun?.status).toBe("ok");
    expect(bots[0].lastRun?.len).toBe(5);
    stopScheduler();
  });
});
