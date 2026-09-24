import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupAgent,
  buildBackupPath,
  deleteAgent,
  installAgent,
  updateAgent,
  validateName,
  validateSource,
} from "./lifecycle";
import type { LifecycleDeps } from "./lifecycle";
import { makeFakeHermesCli, type FakeHermesCli } from "../testUtils/fakeHermesCli";

const tempDirs: string[] = [];
const fakeClis: FakeHermesCli[] = [];

function newFake(): FakeHermesCli {
  const cli = makeFakeHermesCli();
  fakeClis.push(cli);
  tempDirs.push(cli.dir);
  return cli;
}

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function deps(fake: FakeHermesCli): LifecycleDeps {
  return { cliPath: fake.cliPath, backupDir: newTempDir("24os-backups-") };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  fakeClis.length = 0;
});

describe("validateSource / validateName", () => {
  it("接受 http(s) / git@ / ssh URL 与已存在目录", () => {
    expect(validateSource("https://github.com/a/b.git")).toContain("https://");
    expect(validateSource("git@github.com:a/b.git")).toContain("git@");
    expect(validateSource("ssh://git@host/a/b.git")).toContain("ssh://");
    const dir = newTempDir("24os-src-");
    expect(validateSource(dir)).toBe(dir);
  });

  it("拒绝空 / 非法 source", () => {
    expect(() => validateSource("")).toThrow();
    expect(() => validateSource("./not-exist-xyz")).toThrow();
    expect(() => validateSource("file:///etc/passwd")).toThrow();
  });

  it("name 必须匹配 ^[a-z0-9][a-z0-9_-]{0,63}$", () => {
    expect(validateName("my-agent_1")).toBe("my-agent_1");
    expect(() => validateName("BadName")).toThrow();
    expect(() => validateName("-leading")).toThrow();
    expect(() => validateName("with space")).toThrow();
  });
});

describe("installAgent", () => {
  it("未 confirm 且非 dryRun → CONFIRM_REQUIRED", async () => {
    const fake = newFake();
    await expect(
      installAgent({ source: "https://x/y.git" }, deps(fake)),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect(fake.calls()).toEqual([]);
  });

  it("非法 source → INVALID_SOURCE", async () => {
    const fake = newFake();
    await expect(
      installAgent({ source: "not-a-source", confirm: true }, deps(fake)),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("非法 name → INVALID_NAME", async () => {
    const fake = newFake();
    await expect(
      installAgent(
        { source: "https://x/y.git", name: "BadName", confirm: true },
        deps(fake),
      ),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("CLI 不可用 → HERMES_CLI_UNAVAILABLE", async () => {
    await expect(
      installAgent(
        { source: "https://x/y.git", confirm: true },
        { cliPath: null },
      ),
    ).rejects.toMatchObject({ code: "HERMES_CLI_UNAVAILABLE" });
  });

  it("正常安装：子命令与 name/alias 正确传给假 CLI", async () => {
    const fake = newFake();
    const result = await installAgent(
      {
        source: "https://github.com/a/b.git",
        name: "my-agent",
        alias: true,
        confirm: true,
      },
      deps(fake),
    );

    expect(result.ok).toBe(true);
    expect(result.action).toBe("install");
    expect(result.command).toContain("profile install");
    expect(result.stdout).toContain("ok profile install");
    expect(fake.calls()).toEqual([
      [
        "profile",
        "install",
        "https://github.com/a/b.git",
        "--name",
        "my-agent",
        "--alias",
      ],
    ]);
  });

  it("dryRun 不执行（假 CLI 未被调用）", async () => {
    const fake = newFake();
    const result = await installAgent(
      { source: "https://x/y.git", confirm: true, dryRun: true },
      deps(fake),
    );
    expect(result.dryRun).toBe(true);
    expect(result.command).toContain("profile install https://x/y.git");
    expect(fake.calls()).toEqual([]);
  });
});

describe("updateAgent", () => {
  it("未 confirm → CONFIRM_REQUIRED", async () => {
    const fake = newFake();
    await expect(updateAgent("agent-1", {}, deps(fake))).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
  });

  it("正常更新：调用 profile update <id>", async () => {
    const fake = newFake();
    const result = await updateAgent("agent-1", { confirm: true }, deps(fake));
    expect(result.ok).toBe(true);
    expect(result.action).toBe("update");
    expect(fake.calls()).toEqual([["profile", "update", "agent-1"]]);
  });
});

describe("backupAgent", () => {
  it("导出 profile 并返回存在的 backupPath", async () => {
    const fake = newFake();
    const result = await backupAgent("agent-1", deps(fake));
    expect(result.ok).toBe(true);
    expect(result.action).toBe("backup");
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath as string)).toBe(true);
    const [call] = fake.calls();
    expect(call.slice(0, 4)).toEqual(["profile", "export", "agent-1", "-o"]);
  });
});

describe("deleteAgent", () => {
  it("未 confirm → CONFIRM_REQUIRED", async () => {
    const fake = newFake();
    await expect(deleteAgent("agent-1", {}, deps(fake))).rejects.toMatchObject({
      code: "CONFIRM_REQUIRED",
    });
  });

  it("CLI 不可用（非 dryRun）→ HERMES_CLI_UNAVAILABLE", async () => {
    await expect(
      deleteAgent("agent-1", { confirm: true }, { cliPath: null }),
    ).rejects.toMatchObject({ code: "HERMES_CLI_UNAVAILABLE" });
  });

  it("默认先 export 备份再 delete，并返回 backupPath", async () => {
    const fake = newFake();
    const baseDeps = deps(fake);
    const result = await deleteAgent("agent-1", { confirm: true }, baseDeps);

    expect(result.ok).toBe(true);
    expect(result.action).toBe("delete");
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath as string)).toBe(true);

    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 4)).toEqual(["profile", "export", "agent-1", "-o"]);
    expect(calls[1]).toEqual(["profile", "delete", "agent-1"]);
  });

  it("backup:false 时跳过 export，只 delete", async () => {
    const fake = newFake();
    const result = await deleteAgent(
      "agent-1",
      { confirm: true, backup: false },
      deps(fake),
    );
    expect(result.backupPath).toBeUndefined();
    expect(fake.calls()).toEqual([["profile", "delete", "agent-1"]]);
  });

  it("dryRun 展示 export && delete 两条命令且不执行", async () => {
    const fake = newFake();
    const result = await deleteAgent(
      "agent-1",
      { confirm: true, dryRun: true },
      deps(fake),
    );
    expect(result.dryRun).toBe(true);
    expect(result.command).toContain("profile export agent-1 -o");
    expect(result.command).toContain("&&");
    expect(result.command).toContain("profile delete agent-1");
    expect(fake.calls()).toEqual([]);
  });

  it("备份失败则中止删除（CLI 无法启动 → COMMAND_FAILED）", async () => {
    const missingCli = path.join(newTempDir("24os-missing-"), "nope-hermes");
    await expect(
      deleteAgent(
        "agent-1",
        { confirm: true },
        { cliPath: missingCli, backupDir: newTempDir("24os-backups-") },
      ),
    ).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });
});

describe("buildBackupPath", () => {
  it("落在指定目录下且以 id 开头、.tar.gz 结尾", () => {
    const dir = newTempDir("24os-bp-");
    const p = buildBackupPath("agent-1", dir);
    expect(path.dirname(p)).toBe(dir);
    expect(path.basename(p)).toMatch(/^agent-1-.*\.tar\.gz$/);
  });
});
