import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isBotEffectivelyEnabled,
  loadRoster,
  nextRunOf,
  parseRoster,
  resolveBotsFile,
  validateBot,
} from "./roster";

/**
 * Bot Mode 花名册测试（M7）：id/schedule 校验、enabled/disable、路径覆盖。
 */

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  savedEnv.OS_BOTS_FILE = process.env.OS_BOTS_FILE;
});

afterEach(() => {
  if (savedEnv.OS_BOTS_FILE === undefined) delete process.env.OS_BOTS_FILE;
  else process.env.OS_BOTS_FILE = savedEnv.OS_BOTS_FILE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBotsFile", () => {
  it("override > OS_BOTS_FILE > ~/.24os/bots.yaml", () => {
    const dir = newTempDir("24os-bots-");
    const custom = path.join(dir, "a.yaml");
    expect(resolveBotsFile(custom)).toBe(path.resolve(custom));

    process.env.OS_BOTS_FILE = path.join(dir, "b.yaml");
    expect(resolveBotsFile()).toBe(path.resolve(process.env.OS_BOTS_FILE));

    delete process.env.OS_BOTS_FILE;
    expect(resolveBotsFile()).toContain(path.join(".24os", "bots.yaml"));
  });
});

describe("validateBot / parseRoster", () => {
  it("合法条目通过", () => {
    const bot = validateBot(
      {
        id: "daily-report",
        schedule: "09:00",
        profile: "default",
        prompt: "生成简报",
        notify: ["ops-push"],
        enabled: true,
      },
      0,
    );
    expect(bot).toMatchObject({
      id: "daily-report",
      schedule: "09:00",
      enabled: true,
      notify: ["ops-push"],
    });
  });

  it("disable: true → enabled false", () => {
    const bot = validateBot(
      { id: "x", schedule: "10:00", prompt: "p", disable: true },
      0,
    );
    expect(bot.enabled).toBe(false);
  });

  it("enabled: false → enabled false", () => {
    const bot = validateBot(
      { id: "x", schedule: "10:00", prompt: "p", enabled: false },
      0,
    );
    expect(bot.enabled).toBe(false);
  });

  it("非法 id / schedule / 空 prompt 抛错", () => {
    expect(() => validateBot({ id: "BAD", schedule: "09:00", prompt: "p" }, 0)).toThrow();
    expect(() => validateBot({ id: "ok", schedule: "9:00", prompt: "p" }, 0)).toThrow();
    expect(() => validateBot({ id: "ok", schedule: "25:00", prompt: "p" }, 0)).toThrow();
    expect(() => validateBot({ id: "ok", schedule: "09:00", prompt: "" }, 0)).toThrow();
  });

  it("parseRoster：跳过非法并收集 errors；重复 id 跳过", () => {
    const { bots, errors } = parseRoster(`
bots:
  - id: good
    schedule: "09:00"
    prompt: "hello"
  - id: BAD ID
    schedule: "09:00"
    prompt: "x"
  - id: good
    schedule: "10:00"
    prompt: "dup"
`);
    expect(bots).toHaveLength(1);
    expect(bots[0].id).toBe("good");
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadRoster", () => {
  it("读取文件；不存在 → 空", () => {
    const dir = newTempDir("24os-bots-load-");
    const missing = path.join(dir, "nope.yaml");
    const empty = loadRoster(missing);
    expect(empty.exists).toBe(false);
    expect(empty.bots).toEqual([]);

    const file = path.join(dir, "bots.yaml");
    writeFileSync(
      file,
      `bots:\n  - id: a\n    schedule: "08:30"\n    prompt: "hi"\n`,
      "utf8",
    );
    const loaded = loadRoster(file);
    expect(loaded.exists).toBe(true);
    expect(loaded.bots).toHaveLength(1);
    expect(loaded.bots[0].schedule).toBe("08:30");
  });
});

describe("isBotEffectivelyEnabled / nextRunOf", () => {
  it("内存覆盖优先", () => {
    const bot = { id: "a", schedule: "09:00", prompt: "p", enabled: true };
    const override = new Map([["a", false]]);
    expect(isBotEffectivelyEnabled(bot, override)).toBe(false);
    expect(isBotEffectivelyEnabled(bot)).toBe(true);
  });

  it("nextRunOf：今日已过 → 明天", () => {
    const now = new Date("2026-09-24T10:00:00");
    const next = nextRunOf("09:00", now);
    expect(next).toBeTruthy();
    const nextDate = new Date(next!);
    expect(nextDate.getDate()).toBe(25);
    expect(nextDate.getHours()).toBe(9);
  });

  it("nextRunOf：未到点 → 今日", () => {
    const now = new Date("2026-09-24T08:00:00");
    const next = new Date(nextRunOf("09:00", now)!);
    expect(next.getDate()).toBe(24);
    expect(next.getHours()).toBe(9);
  });
});
