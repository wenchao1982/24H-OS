import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRoutes } from "./agents";
import { makeFakeHermesCli, type FakeHermesCli } from "../testUtils/fakeHermesCli";

/**
 * 路由层测试（fastify.inject，不真正监听端口）。
 * 覆盖 /api/agents 的安装/更新/删除/备份与 /api/market。
 * 通过环境变量 OS_HERMES_CLI / OS_BACKUP_DIR / OS_MARKET_FILE 注入。
 */

const tempDirs: string[] = [];
let app: FastifyInstance;
let fake: FakeHermesCli;
const savedEnv: Record<string, string | undefined> = {};

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  app = Fastify();
  await app.register(agentRoutes);
  fake = makeFakeHermesCli();
  tempDirs.push(fake.dir);

  // 默认：无 CLI（显式指向不存在的路径，避免探测到真实 ~/.local/bin/hermes）、
  // market 用临时文件、备份到临时目录。
  savedEnv.OS_HERMES_CLI = process.env.OS_HERMES_CLI;
  savedEnv.OS_BACKUP_DIR = process.env.OS_BACKUP_DIR;
  savedEnv.OS_MARKET_FILE = process.env.OS_MARKET_FILE;
  process.env.OS_HERMES_CLI = path.join(newTempDir("24os-nocli-"), "missing-hermes");
  process.env.OS_BACKUP_DIR = newTempDir("24os-route-backups-");

  const marketFile = path.join(newTempDir("24os-market-"), "index.json");
  writeFileSync(
    marketFile,
    JSON.stringify([
      {
        id: "demo",
        name: "Demo Agent",
        description: "示例",
        source: "https://example.com/demo.git",
        version: "1.0.0",
        tags: ["demo"],
      },
    ]),
    "utf8",
  );
  process.env.OS_MARKET_FILE = marketFile;
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

describe("GET /api/market", () => {
  it("返回市场清单条目", async () => {
    const res = await app.inject({ method: "GET", url: "/api/market" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].id).toBe("demo");
    expect(body.entries[0].source).toContain("https://");
  });

  it("清单缺失时返回空数组 + 说明", async () => {
    process.env.OS_MARKET_FILE = path.join(newTempDir("24os-nomarket-"), "missing.json");
    const res = await app.inject({ method: "GET", url: "/api/market" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
    expect(body.message).toContain("未找到");
  });
});

describe("POST /api/agents（安装）", () => {
  it("dryRun 返回将执行的命令，不真正执行", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { source: "https://github.com/a/b.git", dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.command).toContain("profile install https://github.com/a/b.git");
    expect(fake.calls()).toEqual([]);
  });

  it("未 confirm 且非 dryRun → 400 CONFIRM_REQUIRED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { source: "https://github.com/a/b.git" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
  });

  it("非法 source → 400 INVALID_SOURCE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { source: "nope", confirm: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_SOURCE");
  });

  it("CLI 不可用（confirm 且非 dryRun）→ 503 HERMES_CLI_UNAVAILABLE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { source: "https://github.com/a/b.git", confirm: true },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("HERMES_CLI_UNAVAILABLE");
  });

  it("注入假 CLI 后真实安装成功", async () => {
    process.env.OS_HERMES_CLI = fake.cliPath;
    const res = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { source: "https://github.com/a/b.git", name: "my-agent", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(fake.calls()[0]).toEqual([
      "profile",
      "install",
      "https://github.com/a/b.git",
      "--name",
      "my-agent",
    ]);
  });
});

describe("POST /api/agents/:id/update", () => {
  it("未 confirm → 400 CONFIRM_REQUIRED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/update",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
  });

  it("注入假 CLI 后更新成功", async () => {
    process.env.OS_HERMES_CLI = fake.cliPath;
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/update",
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    // 变更后 refreshSnapshot 会再次探测 CLI 版本（--version），过滤掉该探针调用。
    expect(fake.calls().filter((call) => call[0] !== "--version")).toEqual([
      ["profile", "update", "agent-1"],
    ]);
  });
});

describe("DELETE /api/agents/:id", () => {
  it("未 confirm → 400 CONFIRM_REQUIRED", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/agents/agent-1",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
  });

  it("注入假 CLI 后删除成功（先备份）", async () => {
    process.env.OS_HERMES_CLI = fake.cliPath;
    const res = await app.inject({
      method: "DELETE",
      url: "/api/agents/agent-1",
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backupPath).toBeDefined();
    const calls = fake.calls();
    expect(calls[0].slice(0, 2)).toEqual(["profile", "export"]);
    expect(calls[1]).toEqual(["profile", "delete", "agent-1"]);
  });
});

describe("POST /api/agents/:id/backup", () => {
  it("无 CLI 时优雅返回 503 HERMES_CLI_UNAVAILABLE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/backup",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("HERMES_CLI_UNAVAILABLE");
  });

  it("注入假 CLI 后导出成功", async () => {
    process.env.OS_HERMES_CLI = fake.cliPath;
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/backup",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().backupPath).toContain("agent-1-");
  });
});
