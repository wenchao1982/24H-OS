import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_BACKUPS,
  addMcpServer,
  backupFile,
  readAgentConfig,
  removeEnvVar,
  removeMcpServer,
  resolveAgentDir,
  restoreBackup,
  setEnvVar,
  updateAgentConfig,
  updateMcpServer,
} from "./configEdit";
import type { ConfigEditDeps } from "./configEdit";
import { makeFakeHermesCli } from "../testUtils/fakeHermesCli";

/**
 * M3 配置编辑层测试。
 * 全程使用临时目录注入 hermesHome / backupDir / metaDir，**绝不触碰真实 ~/.hermes**。
 */

const tempDirs: string[] = [];

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  id: string;
  hermesHome: string;
  profileDir: string;
  backupDir: string;
  metaDir: string;
  deps: ConfigEditDeps;
}

const CONFIG_WITH_COMMENTS = `# top comment
model: seed-model # inline model
display:
  theme: dark
# mcp section comment
mcp_servers:
  existing:
    command: node
    args:
      - a.js
skills:
  - alpha
`;

function setupFixture(files: Record<string, string> = {}): Fixture {
  const id = "agent-1";
  const hermesHome = newTempDir("24os-hermes-");
  const profileDir = path.join(hermesHome, "profiles", id);
  mkdirSync(profileDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(profileDir, name), content, "utf8");
  }
  const backupDir = newTempDir("24os-cfg-backups-");
  const metaDir = newTempDir("24os-cfg-meta-");
  return {
    id,
    hermesHome,
    profileDir,
    backupDir,
    metaDir,
    deps: { hermesHome, backupDir, metaDir, cliPath: null },
  };
}

function readConfigFile(fx: Fixture): Record<string, unknown> {
  const raw = readFileSync(path.join(fx.profileDir, "config.yaml"), "utf8");
  return parseYaml(raw) as Record<string, unknown>;
}

function backupsFor(fx: Fixture, base: string): string[] {
  const dir = path.join(fx.backupDir, fx.id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak"))
    .sort();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("readAgentConfig", () => {
  it("读取模型、MCP、元数据，并只返回 env 键名（不含值）", async () => {
    const fx = setupFixture({
      "config.yaml": CONFIG_WITH_COMMENTS,
      ".env": "API_KEY=supersecretvalue\n# comment\nOTHER=xyz\n",
    });
    mkdirSync(path.join(fx.metaDir, fx.id), { recursive: true });
    writeFileSync(
      path.join(fx.metaDir, fx.id, "meta.json"),
      JSON.stringify({ description: "工作台描述", tags: ["a", "b"] }),
      "utf8",
    );

    const config = await readAgentConfig(fx.id, fx.deps);
    expect(config.model).toBe("seed-model");
    expect(config.mcpServers.map((server) => server.id)).toEqual(["existing"]);
    expect(config.mcpServers[0].command).toBe("node");
    expect(config.description).toBe("工作台描述");
    expect(config.tags).toEqual(["a", "b"]);
    expect(config.envKeys).toEqual(["API_KEY", "OTHER"]);
    expect(config.configPath).toBe(path.join(fx.profileDir, "config.yaml"));

    // 绝不回显明文值。
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("supersecretvalue");
    expect(serialized).not.toContain("xyz");
  });

  it("agent 目录不存在 → AGENT_NOT_FOUND", async () => {
    const hermesHome = newTempDir("24os-empty-");
    await expect(
      readAgentConfig("missing", { hermesHome, backupDir: newTempDir("b-"), metaDir: newTempDir("m-") }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});

describe("updateAgentConfig", () => {
  it("未 confirm → CONFIRM_REQUIRED，且不写盘", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await expect(
      updateAgentConfig(fx.id, { model: "new-model" }, fx.deps),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
    expect(readConfigFile(fx).model).toBe("seed-model");
    expect(backupsFor(fx, "config.yaml")).toEqual([]);
  });

  it("非法 id → INVALID_NAME", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await expect(
      updateAgentConfig("../evil", { model: "x", confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
    await expect(
      readAgentConfig("../evil", fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_NAME" });
  });

  it("写 model 后其它键与注释保留，且生成备份", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const result = await updateAgentConfig(
      fx.id,
      { model: "deepseek/deepseek-flash", confirm: true },
      fx.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.backups).toHaveLength(1);
    expect(existsSync(result.backups[0])).toBe(true);

    const raw = readFileSync(path.join(fx.profileDir, "config.yaml"), "utf8");
    expect(raw).toContain("# top comment");
    expect(raw).toContain("# mcp section comment");
    expect(raw).toContain("display:");
    expect(raw).toContain("theme: dark");
    expect(raw).toContain("- alpha");

    const parsed = readConfigFile(fx);
    expect(parsed.model).toBe("deepseek/deepseek-flash");
    expect((parsed.display as Record<string, unknown>).theme).toBe("dark");
    expect(parsed.mcp_servers).toEqual({
      existing: { command: "node", args: ["a.js"] },
    });
  });

  it("model 为 mapping 时只改 model.default，保留其它子字段", async () => {
    const fx = setupFixture({
      "config.yaml": "model:\n  provider: deepseek\n  default: old\nkeep: 1\n",
    });
    await updateAgentConfig(fx.id, { model: "new", confirm: true }, fx.deps);
    const parsed = readConfigFile(fx);
    expect(parsed.model).toEqual({ provider: "deepseek", default: "new" });
    expect(parsed.keep).toBe(1);
  });

  it("description / tags 写入工作台 meta.json（原子写 + 备份）", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const result = await updateAgentConfig(
      fx.id,
      { description: "新描述", tags: ["x", "y"], confirm: true },
      fx.deps,
    );
    const metaPath = path.join(fx.metaDir, fx.id, "meta.json");
    expect(result.files).toContain(metaPath);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    expect(meta.description).toBe("新描述");
    expect(meta.tags).toEqual(["x", "y"]);
  });

  it("没有可更新字段 → INVALID_VALUE", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await expect(
      updateAgentConfig(fx.id, { confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_VALUE" });
  });
});

describe("MCP servers 增 / 改 / 删", () => {
  it("add 正确写入且保留其它字段", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await addMcpServer(
      fx.id,
      { name: "new-srv", spec: { command: "npx", args: ["-y", "foo"] }, confirm: true },
      fx.deps,
    );
    const parsed = readConfigFile(fx);
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers.existing).toEqual({ command: "node", args: ["a.js"] });
    expect(servers["new-srv"]).toEqual({ command: "npx", args: ["-y", "foo"] });
    expect(parsed.display).toEqual({ theme: "dark" });
  });

  it("add 支持 http spec（url + headers）", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await addMcpServer(
      fx.id,
      {
        name: "remote",
        spec: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
        confirm: true,
      },
      fx.deps,
    );
    const servers = readConfigFile(fx).mcp_servers as Record<string, unknown>;
    expect(servers.remote).toEqual({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("add 重复名 → MCP_SERVER_EXISTS；非法 spec → INVALID_MCP_SERVER", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await expect(
      addMcpServer(fx.id, { name: "existing", spec: { command: "node" }, confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "MCP_SERVER_EXISTS" });
    await expect(
      addMcpServer(fx.id, { name: "bad", spec: { foo: 1 } as never, confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_MCP_SERVER" });
    await expect(
      addMcpServer(fx.id, { name: "bad name", spec: { command: "node" }, confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_MCP_SERVER" });
  });

  it("update 替换 spec；remove 删除对应键，均保留其它 server", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    await addMcpServer(
      fx.id,
      { name: "new-srv", spec: { command: "npx" }, confirm: true },
      fx.deps,
    );
    await updateMcpServer(
      fx.id,
      "new-srv",
      { spec: { url: "https://x/mcp" }, confirm: true },
      fx.deps,
    );
    let servers = readConfigFile(fx).mcp_servers as Record<string, unknown>;
    expect(servers["new-srv"]).toEqual({ url: "https://x/mcp" });
    expect(servers.existing).toEqual({ command: "node", args: ["a.js"] });

    await removeMcpServer(fx.id, "existing", { confirm: true }, fx.deps);
    servers = readConfigFile(fx).mcp_servers as Record<string, unknown>;
    expect(servers.existing).toBeUndefined();
    expect(servers["new-srv"]).toEqual({ url: "https://x/mcp" });

    await expect(
      updateMcpServer(fx.id, "nope", { spec: { command: "x" }, confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "MCP_SERVER_NOT_FOUND" });
    await expect(
      removeMcpServer(fx.id, "nope", { confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "MCP_SERVER_NOT_FOUND" });
  });
});

describe("环境变量 set / remove", () => {
  it("set 新增键、保留其它行；返回值不含明文", async () => {
    const fx = setupFixture({
      "config.yaml": CONFIG_WITH_COMMENTS,
      ".env": "API_KEY=old\n# keep me\nOTHER=xyz\n",
    });
    const result = await setEnvVar(
      fx.id,
      { key: "NEW_SECRET", value: "supersecretvalue", confirm: true },
      fx.deps,
    );
    const raw = readFileSync(path.join(fx.profileDir, ".env"), "utf8");
    expect(raw).toContain("NEW_SECRET=supersecretvalue");
    expect(raw).toContain("# keep me");
    expect(raw).toContain("API_KEY=old");
    expect(raw).toContain("OTHER=xyz");
    expect(JSON.stringify(result)).not.toContain("supersecretvalue");
    expect(result.message).not.toContain("supersecretvalue");
    expect(result.backups).toHaveLength(1);
  });

  it("set 已存在键则替换该行，其它行不变", async () => {
    const fx = setupFixture({
      "config.yaml": CONFIG_WITH_COMMENTS,
      ".env": "API_KEY=old\nOTHER=xyz\n",
    });
    await setEnvVar(fx.id, { key: "API_KEY", value: "new", confirm: true }, fx.deps);
    const raw = readFileSync(path.join(fx.profileDir, ".env"), "utf8");
    expect(raw).toContain("API_KEY=new");
    expect(raw).not.toContain("API_KEY=old");
    expect(raw).toContain("OTHER=xyz");
  });

  it("remove 删除对应行并保留其它行", async () => {
    const fx = setupFixture({
      "config.yaml": CONFIG_WITH_COMMENTS,
      ".env": "API_KEY=old\n# keep me\nOTHER=xyz\n",
    });
    await removeEnvVar(fx.id, "API_KEY", { confirm: true }, fx.deps);
    const raw = readFileSync(path.join(fx.profileDir, ".env"), "utf8");
    expect(raw).not.toContain("API_KEY");
    expect(raw).toContain("# keep me");
    expect(raw).toContain("OTHER=xyz");
  });

  it("非法 key → INVALID_KEY；含换行的值 → INVALID_VALUE；未 confirm → CONFIRM_REQUIRED", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS, ".env": "" });
    await expect(
      setEnvVar(fx.id, { key: "lowercase", value: "v", confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(
      setEnvVar(fx.id, { key: "1BAD", value: "v", confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(
      setEnvVar(fx.id, { key: "GOOD", value: "a\nb", confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "INVALID_VALUE" });
    await expect(
      setEnvVar(fx.id, { key: "GOOD", value: "v" }, fx.deps),
    ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  });
});

describe("备份与回滚", () => {
  it("每个文件最多保留 10 份备份，最旧的被删除", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    for (let i = 0; i < 11; i += 1) {
      await delay(3);
      await updateAgentConfig(fx.id, { model: `model-${i}`, confirm: true }, fx.deps);
    }
    const backups = backupsFor(fx, "config.yaml");
    expect(backups).toHaveLength(MAX_BACKUPS);

    // 第一份备份（内容为 seed-model）应已随最旧被删除。
    const contents = backups.map((name) =>
      readFileSync(path.join(fx.backupDir, fx.id, name), "utf8"),
    );
    expect(contents.some((text) => text.includes("seed-model"))).toBe(false);
  });

  it("backupFile 生成 .bak 且路径在备份目录内", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const backup = await backupFile(
      fx.id,
      path.join(fx.profileDir, "config.yaml"),
      fx.deps,
    );
    expect(backup).not.toBeNull();
    expect(existsSync(backup as string)).toBe(true);
    expect(backup as string).toContain(path.join(fx.backupDir, fx.id));
  });

  it("restoreBackup 还原内容并拒绝路径穿越", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const result = await updateAgentConfig(
      fx.id,
      { model: "changed", confirm: true },
      fx.deps,
    );
    const backupName = path.basename(result.backups[0]);

    await updateAgentConfig(fx.id, { model: "changed-again", confirm: true }, fx.deps);
    await restoreBackup(fx.id, backupName, { confirm: true }, fx.deps);
    expect(readConfigFile(fx).model).toBe("seed-model");

    await expect(
      restoreBackup(fx.id, "../../etc/passwd.bak", { confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "PATH_TRAVERSAL" });
    await expect(
      restoreBackup(fx.id, "not-a-backup.txt", { confirm: true }, fx.deps),
    ).rejects.toMatchObject({ code: "PATH_TRAVERSAL" });
  });
});

describe("M5.x 官方命令优先（-p 规则 / via / 回退）", () => {
  /** 一个总是以非 0 退出的假 CLI。 */
  function makeFailingCli(): string {
    const dir = newTempDir("24os-fail-cli-");
    const cliPath = path.join(dir, "hermes");
    writeFileSync(cliPath, "#!/usr/bin/env bash\necho boom >&2\nexit 3\n", "utf8");
    chmodSync(cliPath, 0o755);
    return cliPath;
  }

  it("model：CLI 可用 → hermes -p <id> config set model，via:cli 且不写文件", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const fake = makeFakeHermesCli();
    tempDirs.push(fake.dir);

    const result = await updateAgentConfig(
      fx.id,
      { model: "deepseek/flash", confirm: true },
      { ...fx.deps, cliPath: fake.cliPath },
    );

    expect(result.via).toBe("cli");
    expect(result.files).toEqual([]);
    expect(result.backups).toEqual([]);
    expect(fake.calls()).toEqual([
      ["-p", fx.id, "config", "set", "model", "deepseek/flash"],
    ]);
    expect(readConfigFile(fx).model).toBe("seed-model");
    expect(backupsFor(fx, "config.yaml")).toEqual([]);
  });

  it("default：解析目录 == activeHome，不加 -p", async () => {
    const hermesHome = newTempDir("24os-default-home-");
    writeFileSync(path.join(hermesHome, "config.yaml"), CONFIG_WITH_COMMENTS, "utf8");
    const backupDir = newTempDir("24os-default-backups-");
    const metaDir = newTempDir("24os-default-meta-");
    const fake = makeFakeHermesCli();
    tempDirs.push(fake.dir);
    const deps: ConfigEditDeps = { hermesHome, backupDir, metaDir, cliPath: fake.cliPath };

    const result = await updateAgentConfig("default", { model: "m1", confirm: true }, deps);
    expect(result.via).toBe("cli");
    expect(fake.calls()).toEqual([["config", "set", "model", "m1"]]);
  });

  it("MCP add/update/remove：CLI 可用走 config set/unset mcp_servers.<name>", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const fake = makeFakeHermesCli();
    tempDirs.push(fake.dir);
    const deps = { ...fx.deps, cliPath: fake.cliPath };
    const spec = { command: "npx", args: ["-y", "foo"] };

    const add = await addMcpServer(fx.id, { name: "new-srv", spec, confirm: true }, deps);
    expect(add.via).toBe("cli");

    const upd = await updateMcpServer(
      fx.id,
      "existing",
      { spec: { url: "https://x/mcp" }, confirm: true },
      deps,
    );
    expect(upd.via).toBe("cli");

    const del = await removeMcpServer(fx.id, "existing", { confirm: true }, deps);
    expect(del.via).toBe("cli");

    expect(fake.calls()).toEqual([
      ["-p", fx.id, "config", "set", "mcp_servers.new-srv", JSON.stringify(spec)],
      [
        "-p",
        fx.id,
        "config",
        "set",
        "mcp_servers.existing",
        JSON.stringify({ url: "https://x/mcp" }),
      ],
      ["-p", fx.id, "config", "unset", "mcp_servers.existing"],
    ]);

    // 全程未改文件、无备份。
    const parsed = readConfigFile(fx);
    expect(parsed.model).toBe("seed-model");
    expect(parsed.mcp_servers).toEqual({
      existing: { command: "node", args: ["a.js"] },
    });
    expect(backupsFor(fx, "config.yaml")).toEqual([]);
  });

  it("env set：CLI 可用 → config set KEY VALUE（含 -p），via:cli，不回显明文", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS, ".env": "API_KEY=old\n" });
    const fake = makeFakeHermesCli();
    tempDirs.push(fake.dir);
    const secret = "supersecretvalue";

    const result = await setEnvVar(
      fx.id,
      { key: "NEW_SECRET", value: secret, confirm: true },
      { ...fx.deps, cliPath: fake.cliPath },
    );

    expect(result.via).toBe("cli");
    expect(result.files).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fake.calls()).toEqual([["-p", fx.id, "config", "set", "NEW_SECRET", secret]]);
    // .env 未被直接写入（仍只有旧内容）。
    expect(readFileSync(path.join(fx.profileDir, ".env"), "utf8")).toBe("API_KEY=old\n");
  });

  it("env remove：CLI 可用 → config unset KEY，via:cli", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS, ".env": "API_KEY=old\n" });
    const fake = makeFakeHermesCli();
    tempDirs.push(fake.dir);

    const result = await removeEnvVar(
      fx.id,
      "API_KEY",
      { confirm: true },
      { ...fx.deps, cliPath: fake.cliPath },
    );
    expect(result.via).toBe("cli");
    expect(fake.calls()).toEqual([["-p", fx.id, "config", "unset", "API_KEY"]]);
    expect(readFileSync(path.join(fx.profileDir, ".env"), "utf8")).toBe("API_KEY=old\n");
  });

  it("CLI 不存在 → 回退文件写，via:file（备份/原子写仍生效）", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const result = await updateAgentConfig(
      fx.id,
      { model: "file-model", confirm: true },
      fx.deps, // cliPath: null
    );
    expect(result.via).toBe("file");
    expect(result.files).toContain(path.join(fx.profileDir, "config.yaml"));
    expect(result.backups).toHaveLength(1);
    expect(readConfigFile(fx).model).toBe("file-model");
  });

  it("CLI 命令失败（非 0）→ 回退文件写，via:file", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const deps = { ...fx.deps, cliPath: makeFailingCli() };
    const result = await updateAgentConfig(
      fx.id,
      { model: "fallback-model", confirm: true },
      deps,
    );
    expect(result.via).toBe("file");
    expect(readConfigFile(fx).model).toBe("fallback-model");
    expect(backupsFor(fx, "config.yaml")).toHaveLength(1);
  });

  it("meta-only 更新恒为 via:file（非 Hermes 字段，不走 CLI）", async () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const fake = makeFakeHermesCli();
    tempDirs.push(fake.dir);
    const result = await updateAgentConfig(
      fx.id,
      { description: "d", tags: ["t"], confirm: true },
      { ...fx.deps, cliPath: fake.cliPath },
    );
    expect(result.via).toBe("file");
    expect(fake.calls()).toEqual([]);
  });
});

describe("路径安全", () => {
  it("resolveAgentDir 解析结果始终位于 hermesHome 内", () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    const dir = resolveAgentDir(fx.id, fx.deps);
    expect(dir).toBe(path.join(fx.hermesHome, "profiles", fx.id));
  });

  it("拒绝带路径分隔符 / .. 的 id", () => {
    const fx = setupFixture({ "config.yaml": CONFIG_WITH_COMMENTS });
    for (const bad of ["../evil", "a/b", "a\\b", "..", "UPPER"]) {
      expect(() => resolveAgentDir(bad, fx.deps)).toThrow();
    }
  });
});
