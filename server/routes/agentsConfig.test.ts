import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRoutes } from "./agents";

/**
 * M3 配置编辑路由层测试（fastify.inject）。
 * 通过环境变量把配置编辑指向临时目录，绝不写真实 ~/.hermes。
 */

const tempDirs: string[] = [];
let app: FastifyInstance;
let hermesHome: string;
let backupDir: string;
let metaDir: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  app = Fastify();
  await app.register(agentRoutes);

  hermesHome = newTempDir("24os-cfg-route-home-");
  backupDir = newTempDir("24os-cfg-route-backups-");
  metaDir = newTempDir("24os-cfg-route-meta-");
  const profileDir = path.join(hermesHome, "profiles", "agent-1");
  mkdirSync(profileDir, { recursive: true });
  configPath = path.join(profileDir, "config.yaml");
  writeFileSync(
    configPath,
    "# keep\nmodel: seed\nother: 1\nmcp_servers:\n  a:\n    command: node\n",
    "utf8",
  );
  writeFileSync(path.join(profileDir, ".env"), "EXISTING=1\n", "utf8");

  // 保存并设置隔离环境。
  for (const key of [
    "HERMES_HOME",
    "OS_HERMES_HOME",
    "OS_BACKUP_DIR",
    "OS_CONFIG_BACKUP_DIR",
    "OS_META_DIR",
    "OS_HERMES_CLI",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HERMES_HOME = hermesHome;
  delete process.env.OS_HERMES_HOME;
  process.env.OS_BACKUP_DIR = backupDir;
  delete process.env.OS_CONFIG_BACKUP_DIR;
  process.env.OS_META_DIR = metaDir;
  // 指向不存在的 CLI 路径 → resolveHermesCli 返回 null → env 直接编辑 .env。
  process.env.OS_HERMES_CLI = path.join(hermesHome, "no-such-hermes");
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

describe("GET /api/agents/:id/config", () => {
  it("返回结构化配置，env 只有键名", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/agent-1/config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe("seed");
    expect(body.envKeys).toEqual(["EXISTING"]);
    expect(body.mcpServers.map((s: { id: string }) => s.id)).toEqual(["a"]);
    expect(JSON.stringify(body)).not.toContain("EXISTING=1");
  });

  it("非法的 id → 400 INVALID_NAME", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/BadName/config" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_NAME");
  });
});

describe("PATCH /api/agents/:id/config", () => {
  it("未 confirm → 400 CONFIRM_REQUIRED，且不写盘", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agents/agent-1/config",
      payload: { model: "changed" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
    expect(readFileSync(configPath, "utf8")).toContain("model: seed");
  });

  it("带 confirm → 200，config.yaml 被改且生成备份", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agents/agent-1/config",
      payload: { model: "deepseek/flash", description: "d", tags: ["t"], confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.backups.length).toBeGreaterThan(0);
    expect(readFileSync(configPath, "utf8")).toContain("model: deepseek/flash");
    expect(readFileSync(configPath, "utf8")).toContain("# keep");
    expect(existsSync(body.backups[0])).toBe(true);
  });
});

describe("POST /api/agents/:id/mcp 与 DELETE", () => {
  it("新增后删除，config.yaml 正确更新", async () => {
    const add = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/mcp",
      payload: { name: "new-srv", spec: { command: "npx" }, confirm: true },
    });
    expect(add.statusCode).toBe(200);
    expect(readFileSync(configPath, "utf8")).toContain("new-srv");

    const del = await app.inject({
      method: "DELETE",
      url: "/api/agents/agent-1/mcp/new-srv",
      payload: { confirm: true },
    });
    expect(del.statusCode).toBe(200);
    expect(readFileSync(configPath, "utf8")).not.toContain("new-srv");
  });

  it("未 confirm 的新增 → 400 CONFIRM_REQUIRED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/mcp",
      payload: { name: "new-srv", spec: { command: "npx" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
  });
});

describe("POST /api/agents/:id/env", () => {
  it("写入 .env 且响应不含明文", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/agent-1/env",
      payload: { key: "NEW_SECRET", value: "supersecretvalue", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain("supersecretvalue");
    expect(readFileSync(path.join(hermesHome, "profiles/agent-1/.env"), "utf8")).toContain(
      "NEW_SECRET=supersecretvalue",
    );
  });
});
