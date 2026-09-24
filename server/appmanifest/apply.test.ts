import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppManifest } from "@shared/types";
import { APP_MANIFEST_PROTOCOL } from "@shared/types";
import { LifecycleError } from "../hermes/errors";
import {
  appEventType,
  clearAppEventListeners,
  onAppEvent,
  type AppEventPayload,
} from "./events";
import { applyAppManifest, type ApplyAppDeps } from "./apply";
import { computeSourceSha256, verifySign } from "./sign";
import {
  readInstalledApp,
  sanitizeManifestForStore,
  writeInstalledApp,
} from "./store";

/**
 * AppManifest 编排测试（M6）。
 * 假 hermes CLI + 全临时目录；绝不触碰真实 ~/.hermes。
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let fake: { dir: string; cliPath: string; calls(): string[][] };
let hermesHome: string;
let backupDir: string;
let appsDir: string;
let metaDir: string;
let sourceDir: string;
let deps: ApplyAppDeps;

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeManifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "demo-app",
    name: "Demo App",
    version: "1.0.0",
    source: { type: "path", path: sourceDir },
    profile: {
      model: { default: "kimi-k2.5" },
      env: { MY_API_KEY: "super-secret-value" },
      skills: ["demo-skill"],
    },
    ui: { skillId: "demo-skill", host: "iframe" },
    hooks: { oninstall: ["ui.open"], onupdate: ["notify"], ondelete: ["notify"] },
    ...overrides,
  };
}

/** 动态 import 假 CLI，避免循环。 */
async function loadFake() {
  const mod = await import("../testUtils/fakeHermesCli");
  return mod.makeFakeHermesCli();
}

beforeEach(async () => {
  clearAppEventListeners();
  fake = await loadFake();
  tempDirs.push(fake.dir);

  hermesHome = newTempDir("24os-m6-home-");
  backupDir = newTempDir("24os-m6-backups-");
  appsDir = newTempDir("24os-m6-apps-");
  metaDir = newTempDir("24os-m6-meta-");
  sourceDir = newTempDir("24os-m6-src-");

  // 源 skill 目录
  await mkdir(path.join(sourceDir, "skills", "demo-skill"), { recursive: true });
  await writeFile(
    path.join(sourceDir, "skills", "demo-skill", "SKILL.md"),
    "# demo skill\n",
    "utf8",
  );
  await writeFile(path.join(sourceDir, "README.md"), "source root\n", "utf8");

  savedEnv.HERMES_HOME = process.env.HERMES_HOME;
  savedEnv.OS_HERMES_HOME = process.env.OS_HERMES_HOME;
  savedEnv.OS_HERMES_CLI = process.env.OS_HERMES_CLI;
  savedEnv.OS_BACKUP_DIR = process.env.OS_BACKUP_DIR;
  savedEnv.OS_APPS_DIR = process.env.OS_APPS_DIR;
  savedEnv.OS_META_DIR = process.env.OS_META_DIR;
  savedEnv.OS_MARKET_FILE = process.env.OS_MARKET_FILE;
  savedEnv.OS_MARKET_APPS_DIR = process.env.OS_MARKET_APPS_DIR;

  process.env.HERMES_HOME = hermesHome;
  process.env.OS_HERMES_HOME = hermesHome;
  process.env.OS_HERMES_CLI = fake.cliPath;
  process.env.OS_BACKUP_DIR = backupDir;
  process.env.OS_APPS_DIR = appsDir;
  process.env.OS_META_DIR = metaDir;
  process.env.OS_MARKET_FILE = path.join(newTempDir("24os-m6-market-"), "missing.json");
  process.env.OS_MARKET_APPS_DIR = newTempDir("24os-m6-appsdir-");

  deps = {
    hermesHome,
    cliPath: fake.cliPath,
    backupDir,
    appsDir,
    metaDir,
    timeoutMs: 10_000,
  };
});

afterEach(async () => {
  clearAppEventListeners();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * confirm 门禁
 * ------------------------------------------------------------------ */

describe("confirm 门禁", () => {
  it("缺少 confirm → CONFIRM_REQUIRED 且不落盘", async () => {
    await expect(
      applyAppManifest(makeManifest(), { mode: "install" }, deps),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect(await readInstalledApp("demo-app", appsDir)).toBeNull();
    // 无任何 hermes 调用
    expect(fake.calls()).toEqual([]);
  });

  it("uninstall 缺 confirm 同样拒绝", async () => {
    await expect(
      applyAppManifest(makeManifest(), { mode: "uninstall" }, deps),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  });
});

/* ------------------------------------------------------------------ *
 * install
 * ------------------------------------------------------------------ */

describe("install", () => {
  it("安装成功：CLI config set、apps 记录 env 脱敏、emit app.install", async () => {
    const events: AppEventPayload[] = [];
    onAppEvent("app.install", (payload) => events.push(payload));

    const result = await applyAppManifest(
      makeManifest(),
      { mode: "install", confirm: true },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("install");
    expect(result.hooks).toEqual(["ui.open"]);

    // 调用了 config set（CLI 优先）
    const calls = fake.calls();
    const configSet = calls.find(
      (call) => call.includes("config") && call.includes("set") && call.includes("model"),
    );
    expect(configSet).toBeDefined();
    expect(configSet).toContain("-p");
    expect(configSet).toContain("demo-app");

    // env 也走 CLI set
    const envSet = calls.find(
      (call) => call.includes("config") && call.includes("set") && call.includes("MY_API_KEY"),
    );
    expect(envSet).toBeDefined();

    // apps/<id>.json 写入且 env 脱敏
    const record = await readInstalledApp("demo-app", appsDir);
    expect(record).not.toBeNull();
    expect(record!.manifest.profile!.env!.MY_API_KEY).toBe("***");
    expect(JSON.stringify(record)).not.toContain("super-secret-value");

    // skills 落到 home/skills
    const skillMd = path.join(hermesHome, "skills", "demo-skill", "SKILL.md");
    const { existsSync } = await import("node:fs");
    expect(existsSync(skillMd)).toBe(true);

    // emit
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("demo-app");
    expect(events[0]!.mode).toBe("install");
    expect(events[0]!.hooks).toEqual(["ui.open"]);
    expect(appEventType("install")).toBe("app.install");
  });

  it("profile install 使用本地 path + --name", async () => {
    await applyAppManifest(
      makeManifest(),
      { mode: "install", confirm: true },
      deps,
    );
    const installCall = fake.calls().find((call) => call[0] === "profile" && call[1] === "install");
    expect(installCall).toBeDefined();
    expect(installCall).toContain("--name");
    expect(installCall).toContain("demo-app");
    expect(installCall).toContain(sourceDir);
  });
});

/* ------------------------------------------------------------------ *
 * update / rollback
 * ------------------------------------------------------------------ */

describe("update / rollback", () => {
  it("update 先备份、写 version 迁移；rollback 恢复上一版 manifest 快照", async () => {
    const events: AppEventPayload[] = [];
    onAppEvent("app.update", (p) => events.push(p));
    const rollbackEvents: AppEventPayload[] = [];
    onAppEvent("app.rollback", (p) => rollbackEvents.push(p));

    // install v1
    await applyAppManifest(
      makeManifest(),
      { mode: "install", confirm: true },
      deps,
    );
    const v1 = await readInstalledApp("demo-app", appsDir);
    expect(v1!.version).toBe("1.0.0");

    // update → v1.1.0
    const updateResult = await applyAppManifest(
      makeManifest({ version: "1.1.0" }),
      { mode: "update", confirm: true },
      deps,
    );
    expect(updateResult.ok).toBe(true);
    expect(updateResult.backups.length).toBeGreaterThan(0);
    const backupPath = updateResult.backupPath!;
    const { existsSync } = await import("node:fs");
    expect(existsSync(backupPath)).toBe(true);

    const v2 = await readInstalledApp("demo-app", appsDir);
    expect(v2!.version).toBe("1.1.0");
    expect(v2!.history).toHaveLength(1);
    expect(v2!.history![0]!.version).toBe("1.0.0");
    expect(events).toHaveLength(1);

    // rollback → 回到 1.0.0 快照
    const rollbackResult = await applyAppManifest(
      makeManifest({ version: "1.1.0" }),
      { mode: "rollback", confirm: true },
      deps,
    );
    expect(rollbackResult.ok).toBe(true);
    expect(rollbackResult.version).toBe("1.0.0");

    const after = await readInstalledApp("demo-app", appsDir);
    expect(after!.version).toBe("1.0.0");
    expect(after!.manifest.version).toBe("1.0.0");
    // profile import 被调用（复用 lifecycle 备份机制）
    const importCall = fake.calls().find(
      (call) => call[0] === "profile" && call[1] === "import",
    );
    expect(importCall).toBeDefined();
    expect(rollbackEvents).toHaveLength(1);
  });

  it("无历史时 rollback → BACKUP_NOT_FOUND", async () => {
    await applyAppManifest(
      makeManifest(),
      { mode: "install", confirm: true },
      deps,
    );
    await expect(
      applyAppManifest(makeManifest(), { mode: "rollback", confirm: true }, deps),
    ).rejects.toMatchObject({ code: "BACKUP_NOT_FOUND" });
  });
});

/* ------------------------------------------------------------------ *
 * uninstall
 * ------------------------------------------------------------------ */

describe("uninstall", () => {
  it("先备份、删记录、emit app.uninstall", async () => {
    const events: AppEventPayload[] = [];
    onAppEvent("app.uninstall", (p) => events.push(p));

    await applyAppManifest(
      makeManifest(),
      { mode: "install", confirm: true },
      deps,
    );
    expect(await readInstalledApp("demo-app", appsDir)).not.toBeNull();

    const result = await applyAppManifest(
      makeManifest(),
      { mode: "uninstall", confirm: true },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.backups.length).toBeGreaterThan(0);

    // 删除前有 export 备份
    const calls = fake.calls();
    const exportIdx = calls.findIndex(
      (call) => call[0] === "profile" && call[1] === "export",
    );
    const deleteIdx = calls.findIndex(
      (call) => call[0] === "profile" && call[1] === "delete",
    );
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(exportIdx);

    expect(await readInstalledApp("demo-app", appsDir)).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]!.hooks).toEqual(["notify"]);
  });
});

/* ------------------------------------------------------------------ *
 * sign
 * ------------------------------------------------------------------ */

describe("sign", () => {
  it("无 sha256 → skipped", async () => {
    const status = await verifySign(makeManifest(), sourceDir);
    expect(status).toBe("skipped");
  });

  it("正确 sha256 → ok；篡改文件 → SIGN_MISMATCH", async () => {
    const sha = await computeSourceSha256(sourceDir);
    const manifest = makeManifest({ sign: { sha256: sha } });
    await expect(verifySign(manifest, sourceDir)).resolves.toBe("ok");

    // 篡改
    writeFileSync(path.join(sourceDir, "README.md"), "tampered!\n", "utf8");
    await expect(verifySign(manifest, sourceDir)).rejects.toMatchObject({
      code: "SIGN_MISMATCH",
    });
  });

  it("install 时签名校验失败中止且不写记录", async () => {
    const sha = await computeSourceSha256(sourceDir);
    const manifest = makeManifest({ sign: { sha256: sha } });
    writeFileSync(path.join(sourceDir, "README.md"), "tampered!\n", "utf8");

    await expect(
      applyAppManifest(manifest, { mode: "install", confirm: true }, deps),
    ).rejects.toMatchObject({ code: "SIGN_MISMATCH" });
    expect(await readInstalledApp("demo-app", appsDir)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * store 脱敏
 * ------------------------------------------------------------------ */

describe("store", () => {
  it("sanitizeManifestForStore 把非空 env 值脱敏为 ***", () => {
    const sanitized = sanitizeManifestForStore(makeManifest());
    expect(sanitized.profile!.env!.MY_API_KEY).toBe("***");
    // 空字符串保留
    const empty = makeManifest();
    empty.profile!.env = { EMPTY_KEY: "" };
    expect(sanitizeManifestForStore(empty).profile!.env!.EMPTY_KEY).toBe("");
  });

  it("writeInstalledApp 原子写且内容无明文 secret", async () => {
    await writeInstalledApp(
      {
        id: "demo-app",
        name: "Demo",
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        manifest: makeManifest(),
      },
      appsDir,
    );
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(path.join(appsDir, "demo-app.json"), "utf8");
    expect(raw).not.toContain("super-secret-value");
    expect(raw).toContain("***");
  });

  it("非法 id → INVALID_NAME", async () => {
    await expect(
      writeInstalledApp(
        {
          id: "../evil",
          name: "x",
          version: "1.0.0",
          installedAt: new Date().toISOString(),
          manifest: makeManifest(),
        },
        appsDir,
      ),
    ).rejects.toBeInstanceOf(LifecycleError);
  });
});
