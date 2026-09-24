import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSnapshot, invalidateAgentsCache, refreshSnapshot } from "./index";
import { updateAgentConfig } from "./configEdit";

/**
 * agents 快照缓存失效测试（M2 杂项）。
 * 全程临时 HERMES_HOME / meta / backups + 无效 OS_HERMES_CLI，绝不触碰真实 ~/.hermes。
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let hermesHome: string;
let backupDir: string;
let metaDir: string;

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function saveEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

function restoreEnv(key: string): void {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key] as string;
}

beforeEach(() => {
  hermesHome = newTempDir("24os-cache-home-");
  backupDir = newTempDir("24os-cache-backups-");
  metaDir = newTempDir("24os-cache-meta-");

  for (const key of ["HERMES_HOME", "OS_HERMES_HOME", "OS_HERMES_CLI", "PATH"]) {
    saveEnv(key);
  }
  process.env.HERMES_HOME = hermesHome;
  delete process.env.OS_HERMES_HOME;
  // 无效 CLI 覆盖 → 不回退 PATH，避免探测到真实 hermes。
  process.env.OS_HERMES_CLI = path.join(newTempDir("24os-cache-nocli-"), "missing");
  process.env.PATH = "/nonexistent";

  const profileDir = path.join(hermesHome, "profiles", "alpha");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, "config.yaml"), "model: seed\n", "utf8");

  invalidateAgentsCache();
});

afterEach(() => {
  for (const key of ["HERMES_HOME", "OS_HERMES_HOME", "OS_HERMES_CLI", "PATH"]) {
    restoreEnv(key);
  }
  invalidateAgentsCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("invalidateAgentsCache —— 写操作后立即刷新", () => {
  it("TTL 内缓存命中（磁盘变更不可见）→ 一次写操作后下一次读立即反映", async () => {
    const first = await getSnapshot();
    expect(first.agents.map((agent) => agent.id)).toEqual(["alpha"]);

    // 磁盘新增 profile，但仍在 TTL 内 → 缓存命中，看不到 beta。
    const betaDir = path.join(hermesHome, "profiles", "beta");
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(path.join(betaDir, "config.yaml"), "model: beta\n", "utf8");

    const cached = await getSnapshot();
    expect(cached.agents.map((agent) => agent.id)).toEqual(["alpha"]);

    // 执行一次写操作（configEdit description）→ 内部 invalidateAgentsCache。
    await updateAgentConfig(
      "alpha",
      { description: "d", confirm: true },
      { hermesHome, backupDir, metaDir, cliPath: null },
    );

    // 不等 TTL：下一次 getSnapshot 立即重算，看到 beta（meta 合并发生在路由层，快照只含 profile 数据）。
    const after = await getSnapshot();
    expect(after.agents.map((agent) => agent.id).sort()).toEqual(["alpha", "beta"]);
    expect(after.status.profileCount).toBe(2);
  });

  it("invalidateAgentsCache 单独调用也能打破 TTL 缓存", async () => {
    const first = await getSnapshot();
    expect(first.agents.map((agent) => agent.id)).toEqual(["alpha"]);

    const betaDir = path.join(hermesHome, "profiles", "beta");
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(path.join(betaDir, "config.yaml"), "model: beta\n", "utf8");

    // TTL 内仍是缓存。
    expect((await getSnapshot()).agents).toHaveLength(1);

    invalidateAgentsCache();
    expect((await getSnapshot()).agents.map((agent) => agent.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("refreshSnapshot 清空并立即重算", async () => {
    await getSnapshot();
    const betaDir = path.join(hermesHome, "profiles", "beta");
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(path.join(betaDir, "config.yaml"), "model: beta\n", "utf8");

    const refreshed = await refreshSnapshot();
    expect(refreshed.agents.map((agent) => agent.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
