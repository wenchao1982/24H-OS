import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronActionResult, CronJobsResponse } from "@shared/types";
import { cronRoutes, type CronRouteDeps } from "./cron";
import { resetCronState, type CronRpcClient } from "../hermes/cron";

// 模拟「我们自己的 desktop ticker gateway 在跑」。
vi.mock("../hermes/gateway", () => ({
  getGatewaySnapshot: () => ({ running: true, connected: true, port: 1234, cliPath: "hermes", lastError: null }),
}));

/**
 * 官方 Cron 路由测试：confirm 门禁、参数透传、非法 name、GET 列表。
 * 全部 mock cron 实现 / gateway 客户端，绝不触碰真实 home 或 gateway。
 */

type CronImpl = NonNullable<CronRouteDeps["cron"]>;

async function buildApp(deps: CronRouteDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cronRoutes, deps);
  return app;
}

function makeClient(impl: () => unknown): CronRpcClient {
  return {
    async call<T = unknown>(): Promise<T> {
      const result = impl();
      if (result instanceof Error) throw result;
      return result as T;
    },
    onEvent() {
      return () => undefined;
    },
  };
}

let apps: FastifyInstance[] = [];

beforeEach(() => {
  resetCronState();
  apps = [];
});

afterEach(async () => {
  resetCronState();
  for (const app of apps.splice(0)) await app.close();
});

describe("GET /api/cron/jobs", () => {
  it("返回 jobs + ticker + message", async () => {
    const listMock = vi.fn(async () => ({
      jobs: [{ job_id: "j1", name: "probe", schedule: "30m", prompt_preview: "", enabled: true }],
      count: 1,
      scoped: null,
      includeDisabled: false,
      warning: null,
    }));
    const app = await buildApp({
      cron: { list: listMock } as unknown as CronImpl,
    });
    apps.push(app);

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CronJobsResponse;
    expect(body.jobs).toHaveLength(1);
    expect(body.ticker).toMatchObject({ enabled: expect.any(Boolean), gatewayRunning: expect.any(Boolean) });
    expect(body.message).toContain("1");
  });

  it("include_disabled 透传到实现", async () => {
    const listMock = vi.fn(async (_opts?: unknown) => ({
      jobs: [], count: 0, scoped: null, includeDisabled: true, warning: null,
    }));
    const app = await buildApp({ cron: { list: listMock } as unknown as CronImpl });
    apps.push(app);
    await app.inject({ method: "GET", url: "/api/cron/jobs?include_disabled=1" });
    expect(listMock.mock.calls[0][0]).toMatchObject({ includeDisabled: true });
  });

  it("自家 ticker gateway 在跑时抑制官方误导性 warning", async () => {
    const listMock = vi.fn(async () => ({
      jobs: [],
      count: 0,
      scoped: null,
      includeDisabled: true,
      warning: "The Hermes gateway is not running — these jobs will NOT fire.",
    }));
    const app = await buildApp({ cron: { list: listMock } as unknown as CronImpl });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/cron/jobs" });
    const body = res.json() as CronJobsResponse;
    expect(body.ticker.gatewayRunning).toBe(true);
    expect(body.warning).toBeNull();
  });
});

describe("写操作 confirm 门禁", () => {
  it("add 缺 confirm → 400 CONFIRM_REQUIRED 且不调用实现", async () => {
    const addMock = vi.fn();
    const app = await buildApp({ cron: { add: addMock } as unknown as CronImpl });
    apps.push(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: { name: "probe", schedule: "30m", prompt: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "CONFIRM_REQUIRED" });
    expect(addMock).not.toHaveBeenCalled();
  });

  it("add 带 confirm → 调用实现并返回结果", async () => {
    const addMock = vi.fn(async (input: { name: string }) => ({
      ok: true as const,
      action: "add" as const,
      name: input.name,
    }));
    const app = await buildApp({ cron: { add: addMock as unknown as CronImpl["add"] } });
    apps.push(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs",
      payload: { confirm: true, name: "probe", schedule: "30m", prompt: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, action: "add", name: "probe" });
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  for (const action of ["pause", "resume", "remove", "run"] as const) {
    it(`${action} 缺 confirm → CONFIRM_REQUIRED；带 confirm → 调用`, async () => {
      const actionMock = vi.fn(async (name: string): Promise<CronActionResult> => ({
        ok: true,
        action,
        name,
      }));
      const app = await buildApp({
        cron: { [action]: actionMock } as unknown as CronImpl,
      });
      apps.push(app);

      const denied = await app.inject({
        method: "POST",
        url: `/api/cron/jobs/probe/${action}`,
        payload: {},
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json()).toMatchObject({ error: "CONFIRM_REQUIRED" });
      expect(actionMock).not.toHaveBeenCalled();

      const ok = await app.inject({
        method: "POST",
        url: `/api/cron/jobs/probe/${action}`,
        payload: { confirm: true },
      });
      expect(ok.statusCode).toBe(200);
      expect(actionMock).toHaveBeenCalledWith("probe", expect.anything());
    });
  }
});

describe("真实实现 + 假客户端", () => {
  it("非法 name → 400 INVALID_NAME（不触发 RPC）", async () => {
    let called = false;
    const client = makeClient(() => {
      called = true;
      return { success: true };
    });
    const app = await buildApp({ client, skipBackup: true, useCache: false });
    apps.push(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/cron/jobs/BAD%20NAME/pause",
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "INVALID_NAME" });
    expect(called).toBe(false);
  });

  it("GET 走真实 listCronJobs 映射官方 jobs", async () => {
    const client = makeClient(() => ({
      success: true,
      count: 1,
      jobs: [{ job_id: "j9", name: "daily", schedule: "30m", prompt_preview: "p", enabled: false }],
    }));
    const app = await buildApp({ client, skipBackup: true, useCache: false });
    apps.push(app);

    const res = await app.inject({ method: "GET", url: "/api/cron/jobs?include_disabled=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CronJobsResponse;
    expect(body.jobs[0]).toMatchObject({ job_id: "j9", name: "daily", enabled: false });
  });
});
