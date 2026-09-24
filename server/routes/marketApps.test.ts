import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRoutes } from "./agents";
import { makeFakeHermesCli, type FakeHermesCli } from "../testUtils/fakeHermesCli";

/**
 * M6 市场 / AppManifest 路由测试（fastify.inject）。
 * 隔离 HERMES_HOME / OS_APPS_DIR / OS_MARKET_*，绝不碰真实 ~/.hermes。
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let app: FastifyInstance;
let fake: FakeHermesCli;
let hermesHome: string;
let appsDir: string;
let backupDir: string;
let metaDir: string;
let marketAppsDir: string;

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

  hermesHome = newTempDir("24os-r6-home-");
  appsDir = newTempDir("24os-r6-apps-");
  backupDir = newTempDir("24os-r6-backups-");
  metaDir = newTempDir("24os-r6-meta-");
  marketAppsDir = newTempDir("24os-r6-mapps-");

  // 写入一个测试用 AppManifest
  writeFileSync(
    path.join(marketAppsDir, "demo-app.app.yaml"),
    `protocol: 24os-appmanifest/1
id: demo-app
name: 路由演示
version: 1.0.0
description: 路由层测试 App
source:
  type: path
  path: ${path.join(newTempDir("24os-r6-src-"))}
profile:
  model:
    default: kimi-k2.5
  env:
    ROUTE_SECRET: "route-secret-xyz"
  skills: []
ui:
  skillId: demo-ui
  host: iframe
hooks:
  oninstall: [ui.open]
  ondelete: [notify]
`,
    "utf8",
  );

  for (const key of [
    "HERMES_HOME",
    "OS_HERMES_HOME",
    "OS_HERMES_CLI",
    "OS_BACKUP_DIR",
    "OS_APPS_DIR",
    "OS_META_DIR",
    "OS_MARKET_FILE",
    "OS_MARKET_APPS_DIR",
  ]) {
    savedEnv[key] = process.env[key];
  }

  process.env.HERMES_HOME = hermesHome;
  process.env.OS_HERMES_HOME = hermesHome;
  process.env.OS_HERMES_CLI = fake.cliPath;
  process.env.OS_BACKUP_DIR = backupDir;
  process.env.OS_APPS_DIR = appsDir;
  process.env.OS_META_DIR = metaDir;
  process.env.OS_MARKET_APPS_DIR = marketAppsDir;

  const marketFile = path.join(newTempDir("24os-r6-market-"), "index.json");
  writeFileSync(
    marketFile,
    JSON.stringify([
      {
        id: "demo-app",
        name: "静态条目",
        description: "index.json 条目",
        source: "https://example.com/demo.git",
        version: "0.1.0",
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

describe("GET /api/market（M6 合并 AppManifest）", () => {
  it("条目合并 uiHost / hooks / appManifest 元信息", async () => {
    const res = await app.inject({ method: "GET", url: "/api/market" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const entry = body.entries.find((item: { id: string }) => item.id === "demo-app");
    expect(entry).toBeDefined();
    expect(entry.uiHost).toBe("iframe");
    expect(entry.hooks.oninstall).toEqual(["ui.open"]);
    expect(entry.appManifest).toBe(true);
    expect(entry.version).toBe("1.0.0"); // 被 AppManifest 版本覆盖
  });
});

describe("GET /api/market/apps/:id", () => {
  it("返回解析后的 AppManifest", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/market/apps/demo-app",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocol).toBe("24os-appmanifest/1");
    expect(body.id).toBe("demo-app");
    expect(body.ui.host).toBe("iframe");
  });

  it("不存在 → 404 APP_NOT_FOUND", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/market/apps/nope",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("APP_NOT_FOUND");
  });
});

describe("POST /api/market/:id/apply", () => {
  it("不带 confirm → 400 CONFIRM_REQUIRED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/market/demo-app/apply",
      payload: { mode: "install" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
    // 不落盘
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(appsDir, "demo-app.json"))).toBe(false);
  });

  it("confirm 安装成功且记录无明文 secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/market/demo-app/apply",
      payload: { mode: "install", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("install");

    const { readFileSync, existsSync } = await import("node:fs");
    const recordPath = path.join(appsDir, "demo-app.json");
    expect(existsSync(recordPath)).toBe(true);
    const raw = readFileSync(recordPath, "utf8");
    expect(raw).not.toContain("route-secret-xyz");
    expect(raw).toContain("***");
  });

  it("uninstall 门禁 + 成功", async () => {
    await app.inject({
      method: "POST",
      url: "/api/market/demo-app/apply",
      payload: { mode: "install", confirm: true },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/market/demo-app/apply",
      payload: { mode: "uninstall", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(appsDir, "demo-app.json"))).toBe(false);
  });

  it("非法 mode → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/market/demo-app/apply",
      payload: { mode: "explode", confirm: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_VALUE");
  });

  it("未知 app → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/market/unknown-app/apply",
      payload: { mode: "install", confirm: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("APP_NOT_FOUND");
  });
});

describe("POST /api/agents/install（兼容入口）", () => {
  it("type=market 委托 apply，缺 confirm → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/install",
      payload: { type: "market", id: "demo-app", mode: "install" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CONFIRM_REQUIRED");
  });

  it("type=market + confirm 安装成功", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/install",
      payload: { type: "market", id: "demo-app", mode: "install", confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().id).toBe("demo-app");
  });

  it("非 market 类型仍走原 installAgent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/install",
      payload: { source: "https://github.com/a/b.git", dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dryRun).toBe(true);
    expect(res.json().command).toContain("profile install");
  });
});
