import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_PROFILE_SUBCOMMANDS,
  formatCommand,
  isAllowedCommand,
  resolveHermesCli,
  runHermes,
} from "./cli";
import { makeFakeHermesCli, type FakeHermesCli } from "../testUtils/fakeHermesCli";

const dirs: string[] = [];
const fakeClis: FakeHermesCli[] = [];

function newFake(): FakeHermesCli {
  const cli = makeFakeHermesCli();
  fakeClis.push(cli);
  dirs.push(cli.dir);
  return cli;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  fakeClis.length = 0;
});

describe("isAllowedCommand —— 子命令白名单", () => {
  it("允许 profile 下的白名单子命令", () => {
    for (const sub of ALLOWED_PROFILE_SUBCOMMANDS) {
      expect(isAllowedCommand(["profile", sub])).toBe(true);
    }
    expect(isAllowedCommand(["profile", "install", "https://x/y.git", "--name", "a"])).toBe(
      true,
    );
    expect(isAllowedCommand(["profile", "export", "a", "-o", "/tmp/x.tar.gz"])).toBe(true);
  });

  it("允许 --version / --help", () => {
    expect(isAllowedCommand(["--version"])).toBe(true);
    expect(isAllowedCommand(["--help"])).toBe(true);
    expect(isAllowedCommand(["profile", "--help"])).toBe(true);
  });

  it("拒绝非白名单顶层命令与 profile 子命令", () => {
    expect(isAllowedCommand([])).toBe(false);
    expect(isAllowedCommand(["rm", "-rf", "/"])).toBe(false);
    expect(isAllowedCommand(["profile", "nuke"])).toBe(false);
    expect(isAllowedCommand(["serve"])).toBe(false);
    expect(isAllowedCommand(["--version", "extra"])).toBe(false);
  });

  it("拒绝含 NUL 的参数", () => {
    expect(isAllowedCommand(["profile", "list", "a\0b"])).toBe(false);
  });

  it("允许带 -p/--profile 选择器的 config set/unset（M5.x 官方写入）", () => {
    expect(isAllowedCommand(["-p", "agent-1", "config", "set", "model", "x"])).toBe(true);
    expect(
      isAllowedCommand(["-p", "agent-1", "config", "unset", "mcp_servers.foo"]),
    ).toBe(true);
    expect(
      isAllowedCommand(["--profile", "agent-1", "config", "set", "mcp_servers.foo", "{}"]),
    ).toBe(true);
    expect(isAllowedCommand(["--profile=agent-1", "config", "get", "model"])).toBe(true);
    expect(isAllowedCommand(["-p", "agent-1", "profile", "list"])).toBe(true);
  });

  it("拒绝非法 / 不完整的 profile 选择器", () => {
    expect(isAllowedCommand(["-p", "../evil", "config", "set", "model", "x"])).toBe(false);
    expect(isAllowedCommand(["-p", "UPPER", "config", "set", "model", "x"])).toBe(false);
    expect(isAllowedCommand(["-p"])).toBe(false);
    expect(isAllowedCommand(["-p", "agent-1"])).toBe(false);
    expect(isAllowedCommand(["-p", "agent-1", "rm", "-rf", "/"])).toBe(false);
  });
});

describe("formatCommand", () => {
  it("普通参数原样，含空格参数加引号", () => {
    expect(formatCommand("/usr/bin/hermes", ["profile", "list"])).toBe(
      "/usr/bin/hermes profile list",
    );
    expect(formatCommand("hermes", ["profile", "install", "/a b/c"])).toBe(
      "hermes profile install '/a b/c'",
    );
  });
});

describe("resolveHermesCli", () => {
  it("显式注入优先；null 表示不可用", async () => {
    expect(await resolveHermesCli("/custom/hermes")).toBe("/custom/hermes");
    expect(await resolveHermesCli(null)).toBeNull();
  });
});

describe("runHermes", () => {
  it("非法子命令被拒（COMMAND_NOT_ALLOWED）", async () => {
    await expect(
      runHermes(["profile", "nuke"], { cliPath: "/x/hermes" }),
    ).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    await expect(
      runHermes(["rm", "-rf", "/"], { cliPath: "/x/hermes" }),
    ).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
  });

  it("CLI 不可用（非 dryRun）抛 HERMES_CLI_UNAVAILABLE", async () => {
    await expect(
      runHermes(["profile", "list"], { cliPath: null }),
    ).rejects.toMatchObject({ code: "HERMES_CLI_UNAVAILABLE" });
  });

  it("正常执行返回结构化结果，且命令被传给假 CLI", async () => {
    const fake = newFake();
    const result = await runHermes(["profile", "list"], { cliPath: fake.cliPath });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.dryRun).toBeUndefined();
    expect(result.stdout).toContain("ok profile list");
    expect(result.command).toContain("profile list");
    expect(fake.calls()).toEqual([["profile", "list"]]);
  });

  it("dryRun 返回命令但不执行（假 CLI 未被调用）", async () => {
    const fake = newFake();
    const result = await runHermes(["profile", "list"], {
      cliPath: fake.cliPath,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.command).toContain("profile list");
    expect(fake.calls()).toEqual([]);
  });

  it("dryRun 在无 CLI 时也能预览命令（占位可执行名）", async () => {
    const result = await runHermes(["profile", "install", "https://x/y.git"], {
      cliPath: null,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.command).toBe("hermes profile install https://x/y.git");
  });

  it("命令非 0 退出时返回 ok:false", async () => {
    const fake = newFake();
    const result = await runHermes(["profile", "list"], {
      cliPath: fake.cliPath,
      env: { FAKE_HERMES_FAIL: "1" },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("fake hermes failure");
  });
});
