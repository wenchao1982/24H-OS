import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleError } from "./errors";
import {
  addCronJob,
  attachCronListener,
  backupCronStoreFile,
  invalidateCronCache,
  isCronTickerEnabled,
  listCronJobs,
  pauseCronJob,
  removeCronJob,
  resetCronState,
  resumeCronJob,
  runCronJob,
  validateCronName,
  type CronDeps,
  type CronRpcClient,
} from "./cron";

/**
 * 官方 Cron 薄封装单测：mock gateway 客户端，绝不连真实 gateway / 不触碰真实 home。
 */

type CallImpl = (
  method: string,
  params: Record<string, unknown>,
) => unknown;

interface FakeGateway {
  client: CronRpcClient;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  emit: (params: Record<string, unknown>) => void;
  onEventCount: () => number;
}

function makeFakeGateway(impl: CallImpl = () => ({})): FakeGateway {
  const calls: FakeGateway["calls"] = [];
  const handlers = new Set<(p: Record<string, unknown>) => void>();
  const client: CronRpcClient = {
    async call<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      calls.push({ method, params });
      const result = impl(method, params);
      if (result instanceof Error) throw result;
      return result as T;
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    client,
    calls,
    emit: (params) => {
      for (const handler of [...handlers]) handler(params);
    },
    onEventCount: () => handlers.size,
  };
}

const tempDirs: string[] = [];

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetCronState();
});

afterEach(() => {
  resetCronState();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("listCronJobs", () => {
  it("调用 cron.manage{action:list} 并归一化 jobs", async () => {
    const gw = makeFakeGateway(() => ({
      success: true,
      count: 1,
      jobs: [
        {
          job_id: "j1",
          name: "probe",
          schedule: "30m",
          prompt_preview: "hello",
          next_run_at: "2026-09-25T10:00:00+08:00",
          enabled: true,
        },
      ],
    }));
    const result = await listCronJobs({ deps: { client: gw.client, useCache: false } });

    expect(gw.calls[0]).toMatchObject({
      method: "cron.manage",
      params: { action: "list", include_disabled: false },
    });
    expect(result.count).toBe(1);
    expect(result.jobs[0]).toMatchObject({ job_id: "j1", id: "j1", name: "probe" });
  });

  it("includeDisabled/profile 透传；scoped 回填", async () => {
    const gw = makeFakeGateway(() => ({ success: true, jobs: [], count: 0, scoped: "ops" }));
    const result = await listCronJobs({
      includeDisabled: true,
      profile: "ops",
      deps: { client: gw.client, useCache: false },
    });
    expect(gw.calls[0].params).toMatchObject({
      action: "list",
      include_disabled: true,
      profile: "ops",
    });
    expect(result.scoped).toBe("ops");
  });

  it("TTL 缓存：二次调用命中缓存，cron.changed 后失效重取", async () => {
    const gw = makeFakeGateway(() => ({ success: true, jobs: [], count: 0 }));
    const broadcasts: Array<{ type: string }> = [];
    const deps: CronDeps = {
      client: gw.client,
      now: () => 1000,
      cacheTtlMs: 5000,
      broadcast: (event) => broadcasts.push(event),
    };

    await listCronJobs({ deps });
    expect(gw.calls).toHaveLength(1);

    await listCronJobs({ deps });
    expect(gw.calls).toHaveLength(1); // 命中缓存

    // 手工失效（等价 cron.changed 处理）
    invalidateCronCache();
    await listCronJobs({ deps });
    expect(gw.calls).toHaveLength(2);

    // 事件订阅：emit cron.changed → 失效 + 广播
    attachCronListener(gw.client, deps);
    expect(gw.onEventCount()).toBe(1);
    gw.emit({ type: "cron.changed" });
    expect(broadcasts).toEqual([{ type: "cron.changed", payload: { source: "hermes" } }]);

    await listCronJobs({ deps });
    expect(gw.calls).toHaveLength(3); // emit 已失效 → 重取
  });
});

describe("写操作", () => {
  it("add 透传参数并映射结果", async () => {
    const gw = makeFakeGateway(() => ({
      success: true,
      job_id: "new1",
      name: "daily",
      schedule: "every 2h",
      next_run_at: "2026-09-25T12:00:00+08:00",
      warning: "gateway not running",
    }));
    const result = await addCronJob(
      { name: "daily", schedule: "every 2h", prompt: "do it", deliver: "local" },
      { client: gw.client, skipBackup: true },
    );
    expect(gw.calls[0]).toMatchObject({
      method: "cron.manage",
      params: { action: "add", name: "daily", schedule: "every 2h", prompt: "do it", deliver: "local" },
    });
    expect(result).toMatchObject({
      ok: true,
      action: "add",
      jobId: "new1",
      nextRunAt: "2026-09-25T12:00:00+08:00",
      warning: "gateway not running",
    });
  });

  it("非法 name / 空 schedule / 空 prompt → 结构化错误，且不调用 RPC", async () => {
    const gw = makeFakeGateway(() => ({}));
    await expect(
      addCronJob({ name: "BAD NAME", schedule: "30m", prompt: "x" }, { client: gw.client }),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
    await expect(
      addCronJob({ name: "ok", schedule: "", prompt: "x" }, { client: gw.client }),
    ).rejects.toMatchObject({ code: "INVALID_VALUE" });
    await expect(
      addCronJob({ name: "ok", schedule: "30m", prompt: "  " }, { client: gw.client }),
    ).rejects.toMatchObject({ code: "INVALID_VALUE" });
    expect(gw.calls).toHaveLength(0);
  });

  it("重复 readdir 备份保留最多 10 份", () => {
    const home = newTempDir("24os-cron-backup-");
    mkdirSync(path.join(home, "cron"), { recursive: true });
    writeFileSync(path.join(home, "cron", "jobs.json"), "{}", "utf8");
    const backupDir = path.join(home, "backups");
    for (let i = 0; i < 12; i += 1) {
      backupCronStoreFile({ home, backupDir, now: () => 1000 + i });
    }
    const files = readdirSync(path.join(backupDir, "cron"));
    expect(files.length).toBeLessThanOrEqual(10);
    expect(files.length).toBeGreaterThan(0);
  });

  it("remove/pause/resume 透传 name 并映射 removed_job/job", async () => {
    const gw = makeFakeGateway((_m, params) => {
      const action = params.action;
      if (action === "remove") return { success: true, removed_job: { id: "r1", name: "old" } };
      return { success: true, job: { job_id: "j2", name: "old", enabled: action === "resume" } };
    });
    const removed = await removeCronJob("old", { client: gw.client, skipBackup: true });
    expect(removed).toMatchObject({ action: "remove", jobId: "r1", name: "old" });
    const paused = await pauseCronJob("old", { client: gw.client, skipBackup: true });
    expect(paused).toMatchObject({ action: "pause", name: "old" });
    const resumed = await resumeCronJob("old", { client: gw.client, skipBackup: true });
    expect(resumed).toMatchObject({ action: "resume", name: "old" });
    expect(gw.calls.map((c) => (c.params as { action: string }).action)).toEqual([
      "remove",
      "pause",
      "resume",
    ]);
  });

  it("run 走注入的 runCli（不 spawn）", async () => {
    const gw = makeFakeGateway(() => ({}));
    const ran: string[] = [];
    const result = await runCronJob("probe", {
      client: gw.client,
      skipBackup: true,
      runCli: async (name) => {
        ran.push(name);
      },
    });
    expect(ran).toEqual(["probe"]);
    expect(result).toMatchObject({ action: "run", name: "probe" });
  });
});

describe("错误映射", () => {
  it("GATEWAY_RPC_ERROR → CRON_RPC_ERROR；GATEWAY_UNAVAILABLE → CRON_UNAVAILABLE", async () => {
    const rpc = makeFakeGateway(() => new LifecycleError("GATEWAY_RPC_ERROR", "boom"));
    await expect(
      listCronJobs({ deps: { client: rpc.client, useCache: false } }),
    ).rejects.toMatchObject({ code: "CRON_RPC_ERROR" });

    const down = makeFakeGateway(() => new LifecycleError("GATEWAY_UNAVAILABLE", "down"));
    await expect(
      listCronJobs({ deps: { client: down.client, useCache: false } }),
    ).rejects.toMatchObject({ code: "CRON_UNAVAILABLE" });
  });

  it("官方 tool-level 失败：not found → CRON_JOB_NOT_FOUND，其它 → CRON_RPC_ERROR", async () => {
    const notFound = makeFakeGateway(() => ({ success: false, error: "Job 'x' not found" }));
    await expect(
      removeCronJob("x", { client: notFound.client, skipBackup: true }),
    ).rejects.toMatchObject({ code: "CRON_JOB_NOT_FOUND" });

    const other = makeFakeGateway(() => ({ success: false, error: "some failure" }));
    await expect(
      pauseCronJob("x", { client: other.client, skipBackup: true }),
    ).rejects.toMatchObject({ code: "CRON_RPC_ERROR" });
  });
});

describe("validateCronName / isCronTickerEnabled", () => {
  it("合法名字通过，非法抛 INVALID_NAME", () => {
    expect(validateCronName("daily-report")).toBe("daily-report");
    expect(() => validateCronName("has space")).toThrow(LifecycleError);
    expect(() => validateCronName("-lead")).toThrow(LifecycleError);
  });

  it("OS_CRON_TICKER 默认启用，=0 时关闭", () => {
    expect(isCronTickerEnabled({})).toBe(true);
    expect(isCronTickerEnabled({ OS_CRON_TICKER: "1" })).toBe(true);
    expect(isCronTickerEnabled({ OS_CRON_TICKER: "0" })).toBe(false);
  });
});
