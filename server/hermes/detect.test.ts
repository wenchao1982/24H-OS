import { describe, expect, it } from "vitest";
import type { HermesDetection } from "./detect";
import { decideMode } from "./detect";

/** 构造一个探测结果，只覆盖关心的字段。 */
function detection(partial: Partial<HermesDetection>): HermesDetection {
  return {
    cliFound: false,
    version: null,
    cliPath: null,
    homeExists: false,
    profilesDirExists: false,
    homeConfigExists: false,
    ...partial,
  };
}

describe("decideMode —— live / mock 判定", () => {
  it("存在 profiles 目录 → live", () => {
    expect(decideMode(detection({ profilesDirExists: true }))).toBe("live");
  });

  it("~/.hermes 存在且有配置 → live", () => {
    expect(
      decideMode(detection({ homeExists: true, homeConfigExists: true })),
    ).toBe("live");
  });

  it("~/.hermes 存在但无配置 → mock", () => {
    expect(decideMode(detection({ homeExists: true }))).toBe("mock");
  });

  it("既无 profiles 也无配置 → mock", () => {
    expect(decideMode(detection({}))).toBe("mock");
  });

  it("仅有 CLI 但无任何配置 → mock", () => {
    expect(decideMode(detection({ cliFound: true, cliPath: "/usr/bin/hermes" }))).toBe(
      "mock",
    );
  });
});
