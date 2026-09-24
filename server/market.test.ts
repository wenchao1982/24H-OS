import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMarket } from "./market";

/**
 * readMarket 文案数量一致性（隔离 OS_MARKET_FILE / OS_MARKET_APPS_DIR，绝不碰真实 ~/.hermes）。
 * 硬编码「市场共 0 个」曾导致 message 与实际 entries 数不符——此处锁定回归。
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeMarket(index: unknown, appsDir: string): void {
  const file = path.join(newTempDir("24os-market-file-"), "index.json");
  writeFileSync(file, JSON.stringify(index), "utf8");
  process.env.OS_MARKET_FILE = file;
  process.env.OS_MARKET_APPS_DIR = appsDir;
}

beforeEach(() => {
  for (const key of ["OS_MARKET_FILE", "OS_MARKET_APPS_DIR"]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("readMarket message 计数", () => {
  it("多条条目：message 数量与实际 entries 一致", () => {
    writeMarket(
      [
        { id: "a", name: "A", source: "https://example.com/a.git" },
        { id: "b", name: "B", source: "https://example.com/b.git" },
      ],
      newTempDir("24os-market-apps-"),
    );

    const { entries, message } = readMarket();
    expect(entries).toHaveLength(2);
    expect(message).toContain(`市场共 ${entries.length} 个可安装 distribution`);
  });

  it("0 条条目：message 明确为 0", () => {
    writeMarket([], newTempDir("24os-market-apps-"));

    const { entries, message } = readMarket();
    expect(entries).toHaveLength(0);
    expect(message).toBe("市场共 0 个可安装 distribution。");
  });

  it("合并 AppManifest 后 message 数量含追加条目", () => {
    const appsDir = newTempDir("24os-market-apps-");
    writeFileSync(
      path.join(appsDir, "extra.app.yaml"),
      `protocol: 24os-appmanifest/1
id: extra
name: 追加应用
version: 1.0.0
source:
  type: path
  path: ${newTempDir("24os-market-src-")}
`,
      "utf8",
    );
    writeMarket(
      [{ id: "a", name: "A", source: "https://example.com/a.git" }],
      appsDir,
    );

    const { entries, message } = readMarket();
    expect(entries).toHaveLength(2);
    expect(message).toContain(`市场共 ${entries.length} 个可安装 distribution`);
    expect(message).toContain("含 1 个 AppManifest");
  });
});
