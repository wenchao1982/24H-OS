import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
