import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideMode,
  detectHermes,
  isValidHermesHome,
  listHermesHomes,
  resolveActiveHome,
  resolveActiveHomeSync,
  resolveCliHome,
  resolveCliPath,
  resolveCliPathSync,
  type HermesDetection,
} from "./detect";

/** 构造一个探测结果，只覆盖关心的字段。 */
function detection(partial: Partial<HermesDetection>): HermesDetection {
  return {
    cliFound: false,
    version: null,
    cliPath: null,
    cliSource: null,
    homeExists: false,
    profilesDirExists: false,
    homeConfigExists: false,
    activeHome: "/tmp/hermes",
    hermesHomes: [],
    ...partial,
  };
}

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 写一个可执行的假 hermes（--version 输出固定文本）。 */
function writeFakeCli(file: string, version = "hermes 0.21.3"): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env bash\necho "${version}"\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("decideMode —— live / mock 判定（M5.0）", () => {
  it("存在 profiles 目录 → live", () => {
    expect(decideMode(detection({ profilesDirExists: true }))).toBe("live");
  });

  it("~/.hermes 存在且有配置 → live", () => {
    expect(
      decideMode(detection({ homeExists: true, homeConfigExists: true })),
    ).toBe("live");
  });

  it("仅有 CLI（无任何配置）→ live（M5.0 起）", () => {
    expect(
      decideMode(detection({ cliFound: true, cliPath: "/usr/bin/hermes" })),
    ).toBe("live");
  });

  it("探测到有效 hermes home → live", () => {
    expect(decideMode(detection({ hermesHomes: ["/tmp/h1"] }))).toBe("live");
  });

  it("既无 CLI 也无有效 home → mock", () => {
    expect(decideMode(detection({ homeExists: true }))).toBe("mock");
    expect(decideMode(detection({}))).toBe("mock");
  });
});

describe("resolveCliPath —— CLI 候选顺序", () => {
  it("OS_HERMES_CLI 显式路径优先（env）", async () => {
    const home = makeTemp("24os-detect-home-");
    const cli = writeFakeCli(path.join(home, "custom", "hermes"));
    const resolved = await resolveCliPath({
      homeDir: home,
      env: { OS_HERMES_CLI: cli, PATH: "/nonexistent" },
    });
    expect(resolved.cliPath).toBe(cli);
    expect(resolved.cliSource).toBe("env");
  });

  it("~/.local/bin/hermes 次之（local-bin）", async () => {
    const home = makeTemp("24os-detect-home-");
    const cli = writeFakeCli(path.join(home, ".local", "bin", "hermes"));
    const resolved = await resolveCliPath({
      homeDir: home,
      env: { PATH: "/nonexistent" },
    });
    expect(resolved.cliPath).toBe(cli);
    expect(resolved.cliSource).toBe("local-bin");
  });

  it("<home>/bin/hermes 再次（hermes-bin）", async () => {
    const home = makeTemp("24os-detect-home-");
    const hermesHome = path.join(home, ".hermes");
    const cli = writeFakeCli(path.join(hermesHome, "bin", "hermes"));
    const resolved = await resolveCliPath({
      homeDir: home,
      env: { PATH: "/nonexistent" },
    });
    expect(resolved.cliPath).toBe(cli);
    expect(resolved.cliSource).toBe("hermes-bin");
  });

  it("PATH 命中（path）", async () => {
    const home = makeTemp("24os-detect-home-");
    const binDir = makeTemp("24os-detect-bin-");
    const cli = writeFakeCli(path.join(binDir, "hermes"));
    const resolved = await resolveCliPath({
      homeDir: home,
      env: { PATH: binDir },
    });
    expect(resolved.cliPath).toBe(cli);
    expect(resolved.cliSource).toBe("path");
  });

  it("全部不存在 → null", async () => {
    const home = makeTemp("24os-detect-home-");
    const resolved = await resolveCliPath({
      homeDir: home,
      env: { PATH: "/nonexistent" },
    });
    expect(resolved.cliPath).toBeNull();
    expect(resolved.cliSource).toBeNull();
  });

  it("OS_HERMES_CLI=/nope/here → CLI 不可用且不回退 PATH（env 即停）", async () => {
    const home = makeTemp("24os-detect-home-");
    const binDir = makeTemp("24os-detect-bin-");
    // PATH 上有可执行的 hermes——显式 env 无效时不允许命中它。
    writeFakeCli(path.join(binDir, "hermes"));

    const resolved = await resolveCliPath({
      homeDir: home,
      env: { OS_HERMES_CLI: "/nope/here", PATH: binDir },
    });
    expect(resolved.cliPath).toBeNull();
    expect(resolved.cliSource).toBe("env");

    const sync = resolveCliPathSync({
      homeDir: home,
      env: { OS_HERMES_CLI: "/nope/here", PATH: binDir },
    });
    expect(sync).toEqual({ cliPath: null, cliSource: "env" });
  });

  it("OS_HERMES_CLI 有效时仍优先（env），不看 PATH", async () => {
    const home = makeTemp("24os-detect-home-");
    const binDir = makeTemp("24os-detect-bin-");
    writeFakeCli(path.join(binDir, "hermes"));
    const cli = writeFakeCli(path.join(home, "custom", "hermes"));

    const resolved = await resolveCliPath({
      homeDir: home,
      env: { OS_HERMES_CLI: cli, PATH: binDir },
    });
    expect(resolved.cliPath).toBe(cli);
    expect(resolved.cliSource).toBe("env");
  });
});

describe("hermes home 探测", () => {
  it("isValidHermesHome：含 config.yaml 才算有效", () => {
    const home = makeTemp("24os-detect-home-");
    const plain = path.join(home, "plain");
    const withConfig = path.join(home, "with-config");
    mkdirSync(plain, { recursive: true });
    mkdirSync(withConfig, { recursive: true });
    writeFileSync(path.join(withConfig, "config.yaml"), "model: x\n", "utf8");
    expect(isValidHermesHome(plain)).toBe(false);
    expect(isValidHermesHome(withConfig)).toBe(true);
    expect(isValidHermesHome(path.join(home, "nope"))).toBe(false);
  });

  it("listHermesHomes 汇总 ~/.hermes 与 ~/hermes-desktop/home", () => {
    const home = makeTemp("24os-detect-home-");
    const dotHermes = path.join(home, ".hermes");
    const desktop = path.join(home, "hermes-desktop", "home");
    mkdirSync(dotHermes, { recursive: true });
    mkdirSync(desktop, { recursive: true });
    writeFileSync(path.join(dotHermes, "config.yaml"), "model: x\n", "utf8");
    writeFileSync(path.join(desktop, "config.yaml"), "model: x\n", "utf8");

    const homes = listHermesHomes({ homeDir: home, env: { PATH: "/nonexistent" } });
    expect(homes).toEqual([dotHermes, desktop]);
  });

  it("resolveActiveHome：env 指定的 home 存在时优先", () => {
    const home = makeTemp("24os-detect-home-");
    const custom = path.join(home, "custom-home");
    mkdirSync(custom, { recursive: true });
    writeFileSync(path.join(custom, "config.yaml"), "model: x\n", "utf8");
    expect(
      resolveActiveHome({
        homeDir: home,
        env: { HERMES_HOME: custom, PATH: "/nonexistent" },
      }),
    ).toBe(custom);
  });

  it("resolveActiveHome：env 未设置时回退到有效候选", () => {
    const home = makeTemp("24os-detect-home-");
    const desktop = path.join(home, "hermes-desktop", "home");
    mkdirSync(desktop, { recursive: true });
    writeFileSync(path.join(desktop, "config.yaml"), "model: x\n", "utf8");
    expect(
      resolveActiveHome({ homeDir: home, env: { PATH: "/nonexistent" } }),
    ).toBe(desktop);
  });

  it("resolveActiveHome：env 指定的 home 不存在时无效即停，不静默换家", () => {
    const home = makeTemp("24os-detect-home-");
    // 即使 ~/.hermes 有效，显式 HERMES_HOME 指向不存在目录时也不回退。
    const dotHermes = path.join(home, ".hermes");
    mkdirSync(dotHermes, { recursive: true });
    writeFileSync(path.join(dotHermes, "config.yaml"), "model: x\n", "utf8");

    expect(
      resolveActiveHome({
        homeDir: home,
        env: { HERMES_HOME: path.join(home, "missing-home"), PATH: "/nonexistent" },
      }),
    ).toBe(path.join(home, "missing-home"));
  });

  it("resolveActiveHomeSync：OS_HERMES_CLI 无效时不采用其它 CLI 的 home", () => {
    const home = makeTemp("24os-detect-home-");
    // PATH 上有包装脚本声明的 home——显式 OS_HERMES_CLI 无效时不得读取它。
    const pathHome = path.join(home, "path-hermes-home");
    mkdirSync(pathHome, { recursive: true });
    writeFileSync(path.join(pathHome, "config.yaml"), "model: path\n", "utf8");
    const binDir = makeTemp("24os-detect-bin-");
    const pathCli = path.join(binDir, "hermes");
    writeFileSync(
      pathCli,
      `#!/usr/bin/env bash\nexport HERMES_HOME="${pathHome}"\n`,
      "utf8",
    );
    chmodSync(pathCli, 0o755);

    // 无显式 home env、OS_HERMES_CLI 无效 → CLI home 链停止，回退默认候选（无有效候选时为 ~/.hermes）。
    expect(
      resolveActiveHomeSync({
        homeDir: home,
        env: { OS_HERMES_CLI: "/nope/here", PATH: binDir },
      }),
    ).toBe(path.join(home, ".hermes"));
  });
});

describe("resolveCliHome —— 解析包装脚本的 HERMES_HOME（M5.x）", () => {
  it("包装脚本 export HERMES_HOME=<abs> → 提取绝对路径", () => {
    const home = makeTemp("24os-detect-home-");
    const cli = path.join(home, "bin", "hermes");
    const declared = path.join(home, "hermes-desktop", "home");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, `#!/usr/bin/env bash\nexport HERMES_HOME="${declared}"\nexec python "$@"\n`, "utf8");

    expect(resolveCliHome(cli, { homeDir: home })).toBe(declared);
  });

  it("支持 ${HERMES_HOME:-/default} 默认值与 ~ 展开", () => {
    const home = makeTemp("24os-detect-home-");
    const cli = path.join(home, "hermes-default");
    writeFileSync(cli, '#!/usr/bin/env bash\nexport HERMES_HOME="${HERMES_HOME:-/opt/hermes/home}"\n', "utf8");
    expect(resolveCliHome(cli, { homeDir: home })).toBe("/opt/hermes/home");

    const cli2 = path.join(home, "hermes-tilde");
    writeFileSync(cli2, "#!/usr/bin/env bash\nHERMES_HOME=~/custom-home\n", "utf8");
    expect(resolveCliHome(cli2, { homeDir: home })).toBe(path.join(home, "custom-home"));
  });

  it("非脚本（无 HERMES_HOME / 二进制 / 不存在）→ null（undefined 语义）", () => {
    const home = makeTemp("24os-detect-home-");
    const plain = path.join(home, "not-a-wrapper");
    writeFileSync(plain, "#!/usr/bin/env bash\necho hello\n", "utf8");
    expect(resolveCliHome(plain, { homeDir: home })).toBeNull();
    expect(resolveCliHome(path.join(home, "missing"), { homeDir: home })).toBeNull();

    const binary = path.join(home, "binary");
    writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    expect(resolveCliHome(binary, { homeDir: home })).toBeNull();
  });

  it("resolveCliPathSync 与异步版本一致", async () => {
    const home = makeTemp("24os-detect-home-");
    const cli = writeFakeCli(path.join(home, ".local", "bin", "hermes"));
    const sync = resolveCliPathSync({ homeDir: home, env: { PATH: "/nonexistent" } });
    const asyncRes = await resolveCliPath({ homeDir: home, env: { PATH: "/nonexistent" } });
    expect(sync).toEqual(await asyncRes);
    expect(sync.cliPath).toBe(cli);
  });
});

describe("detectHermes —— 集成", () => {
  it("非 PATH 的 hermes + 多 home：返回 cliSource/activeHome/hermesHomes", async () => {
    const home = makeTemp("24os-detect-home-");
    const dotHermes = path.join(home, ".hermes");
    mkdirSync(dotHermes, { recursive: true });
    writeFileSync(path.join(dotHermes, "config.yaml"), "model: demo\n", "utf8");
    writeFakeCli(path.join(home, ".local", "bin", "hermes"), "hermes 9.9.9");

    const det = await detectHermes({ homeDir: home, env: { PATH: "/nonexistent" } });
    expect(det.cliFound).toBe(true);
    expect(det.cliSource).toBe("local-bin");
    expect(det.version).toBe("hermes 9.9.9");
    expect(det.activeHome).toBe(dotHermes);
    expect(det.hermesHomes).toContain(dotHermes);
    expect(det.homeConfigExists).toBe(true);
    expect(decideMode(det)).toBe("live");
  });

  it("CLI 包装脚本指定 home → activeHome 指向该 home 并纳入 hermesHomes", async () => {
    const home = makeTemp("24os-detect-home-");
    // 两个有效 home：~/.hermes 与 CLI 包装脚本声明的 ~/hermes-desktop/home。
    const dotHermes = path.join(home, ".hermes");
    mkdirSync(dotHermes, { recursive: true });
    writeFileSync(path.join(dotHermes, "config.yaml"), "model: dot\n", "utf8");
    const cliHome = path.join(home, "hermes-desktop", "home");
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(path.join(cliHome, "config.yaml"), "model: cli\n", "utf8");
    const cli = path.join(home, ".local", "bin", "hermes");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      `#!/usr/bin/env bash\nexport HERMES_HOME="${cliHome}"\necho "hermes 9.9.9"\n`,
      "utf8",
    );
    chmodSync(cli, 0o755);

    const det = await detectHermes({ homeDir: home, env: { PATH: "/nonexistent" } });
    expect(det.cliFound).toBe(true);
    expect(det.activeHome).toBe(cliHome);
    expect(det.hermesHomes).toContain(cliHome);
    expect(det.homeConfigExists).toBe(true);

    // 显式 HERMES_HOME 覆盖仍优先于包装脚本。
    const dotHermesAbs = path.resolve(dotHermes);
    const det2 = await detectHermes({
      homeDir: home,
      env: { PATH: "/nonexistent", HERMES_HOME: dotHermesAbs },
    });
    expect(det2.activeHome).toBe(dotHermesAbs);
  });

  it("OS_HERMES_CLI 无效 → CLI 不可用（cliSource:env）且有有效 home 仍 live", async () => {
    const home = makeTemp("24os-detect-home-");
    const binDir = makeTemp("24os-detect-bin-");
    writeFakeCli(path.join(binDir, "hermes"), "hermes 9.9.9"); // PATH 上有 hermes，不得回退命中。

    const dotHermes = path.join(home, ".hermes");
    mkdirSync(dotHermes, { recursive: true });
    writeFileSync(path.join(dotHermes, "config.yaml"), "model: demo\n", "utf8");

    const det = await detectHermes({
      homeDir: home,
      env: { OS_HERMES_CLI: "/nope/here", PATH: binDir },
    });
    expect(det.cliFound).toBe(false);
    expect(det.cliPath).toBeNull();
    expect(det.cliSource).toBe("env");
    expect(det.version).toBeNull();
    expect(det.activeHome).toBe(dotHermes);
    expect(decideMode(det)).toBe("live"); // 无 CLI 但有有效 home → 仍 live（既有规则）。
  });
});
