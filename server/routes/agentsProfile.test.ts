import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAvatar, AgentAvatarUploadResult } from "@shared/types";
import { LifecycleError } from "../hermes/errors";
import { agentRoutes } from "./agents";

/**
 * M9 头像路由测试（fastify.inject）：注入 profileRpc，绝不连真实 gateway / 不触碰真实 home。
 * `validateAvatarData` 用真实实现（校验大小 / 类型）。
 */

const tempDirs: string[] = [];
let app: FastifyInstance;
const savedEnv: Record<string, string | undefined> = {};

/** 1x1 PNG。 */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const getAsset = vi.fn();
const setAsset = vi.fn();

beforeEach(async () => {
  for (const key of ["OS_HERMES_CLI", "HERMES_HOME", "OS_HERMES_HOME"]) {
    savedEnv[key] = process.env[key];
  }
  const isolatedHome = newTempDir("24os-avatar-home-");
  process.env.OS_HERMES_CLI = path.join(isolatedHome, "missing-hermes");
  process.env.HERMES_HOME = isolatedHome;
  delete process.env.OS_HERMES_HOME;

  getAsset.mockReset();
  setAsset.mockReset();

  app = Fastify();
  await app.register(agentRoutes, {
    profileRpc: { getAsset, setAsset },
  });
});

afterEach(async () => {
  await app.close();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/agents/:id/avatar", () => {
  it("转发 profiles.get_asset；found:true 回传 data URL", async () => {
    getAsset.mockResolvedValue({
      found: true,
      mime: "image/png",
      size: 68,
      data: `data:image/png;base64,${PNG_1X1}`,
    });
    const res = await app.inject({ method: "GET", url: "/api/agents/alpha/avatar" });
    expect(res.statusCode).toBe(200);
    expect(getAsset).toHaveBeenCalledWith("alpha");
    const body = res.json<AgentAvatar>();
    expect(body.found).toBe(true);
    expect(body.data?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("未设置 → found:false", async () => {
    getAsset.mockResolvedValue({ found: false, mime: null, size: null, data: null });
    const res = await app.inject({ method: "GET", url: "/api/agents/alpha/avatar" });
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentAvatar>().found).toBe(false);
  });

  it("PROFILE_NOT_FOUND → 404", async () => {
    getAsset.mockRejectedValue(new LifecycleError("PROFILE_NOT_FOUND", "nope"));
    const res = await app.inject({ method: "GET", url: "/api/agents/ghost/avatar" });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("PROFILE_NOT_FOUND");
  });
});

describe("POST /api/agents/:id/avatar", () => {
  it("未 confirm → 400 CONFIRM_REQUIRED，不调用 set_asset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/alpha/avatar",
      payload: { data: `data:image/png;base64,${PNG_1X1}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("CONFIRM_REQUIRED");
    expect(setAsset).not.toHaveBeenCalled();
  });

  it("合法 PNG + confirm → 200，set_asset 收到规范化 data URL", async () => {
    setAsset.mockResolvedValue({ ok: true, asset: "avatar", size: 68, removed: null });
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/alpha/avatar",
      payload: { data: `data:image/png;base64,${PNG_1X1}`, confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AgentAvatarUploadResult>();
    expect(body.ok).toBe(true);
    expect(body.size).toBe(68);
    const [id, dataUrl] = setAsset.mock.calls[0] as [string, string];
    expect(id).toBe("alpha");
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("非图片 / 过大 → 400 INVALID_ASSET，不调用 set_asset", async () => {
    const notImage = Buffer.from("hello world").toString("base64");
    const bad = await app.inject({
      method: "POST",
      url: "/api/agents/alpha/avatar",
      payload: { data: notImage, confirm: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("INVALID_ASSET");

    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(256 * 1024),
    ]).toString("base64");
    const tooBig = await app.inject({
      method: "POST",
      url: "/api/agents/alpha/avatar",
      payload: { data: big, confirm: true },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json<{ error: string }>().error).toBe("INVALID_ASSET");
    expect(setAsset).not.toHaveBeenCalled();
  });

  it("set_asset 传输层失败 → 503；官方业务错误 → 502", async () => {
    setAsset.mockRejectedValueOnce(
      new LifecycleError("HERMES_CLI_UNAVAILABLE", "no cli"),
    );
    const down = await app.inject({
      method: "POST",
      url: "/api/agents/alpha/avatar",
      payload: { data: PNG_1X1, confirm: true },
    });
    expect(down.statusCode).toBe(503);

    setAsset.mockRejectedValueOnce(new LifecycleError("PROFILE_RPC_ERROR", "boom"));
    const rpc = await app.inject({
      method: "POST",
      url: "/api/agents/alpha/avatar",
      payload: { data: PNG_1X1, confirm: true },
    });
    expect(rpc.statusCode).toBe(502);
  });
});
