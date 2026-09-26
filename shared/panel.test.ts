import { describe, expect, it } from "vitest";
import {
  findMissingKeys,
  interpolatePrompt,
  PanelInterpolationError,
} from "./panel";

/**
 * shared/panel.ts 的插值工具在前后端共用；server 侧只做了主路径覆盖，
 * 这里补足前端会遇到的边界：非法输入、对象值、重复键顺序、占位符语法。
 */

describe("interpolatePrompt —— 前端边界", () => {
  it("非字符串模板返回空串（防御 yaml 解析异常）", () => {
    expect(interpolatePrompt(undefined as unknown as string, { a: 1 })).toBe("");
    expect(interpolatePrompt(null as unknown as string)).toBe("");
  });

  it("对象/数组/布尔值按 String 原样替换", () => {
    expect(interpolatePrompt("{{a}}|{{b}}|{{c}}", { a: true, b: [1, 2], c: { x: 1 } })).toBe(
      "true|1,2|[object Object]",
    );
  });

  it("同一占位符多次出现全部替换", () => {
    expect(interpolatePrompt("{{k}}-{{k}}-{{k}}", { k: "x" })).toBe("x-x-x");
  });

  it("仅匹配合法标识符，{{1bad}} / {{a-b}} 保持原样", () => {
    expect(interpolatePrompt("{{1bad}} {{a-b}} {{ok}}", { ok: "yes" })).toBe(
      "{{1bad}} {{a-b}} yes",
    );
  });

  it("missing=keep 只保留缺失键，已有键照常替换", () => {
    expect(interpolatePrompt("{{a}} {{b}}", { a: "A" }, { missing: "keep" })).toBe("A {{b}}");
  });

  it("missing=error 抛出并携带缺失键列表（去重）", () => {
    try {
      interpolatePrompt("{{a}} {{b}} {{a}}", { c: 1 }, { missing: "error" });
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(PanelInterpolationError);
      expect((err as PanelInterpolationError).keys).toEqual(["a", "b"]);
    }
  });
});

describe("findMissingKeys —— 缺失检测", () => {
  it("非字符串模板返回空数组", () => {
    expect(findMissingKeys(undefined as unknown as string)).toEqual([]);
  });

  it("保持首次出现顺序并去重；null/undefined 视为缺失，0/false 不算", () => {
    expect(
      findMissingKeys("{{a}} {{b}} {{a}} {{z}}", { a: 0, b: null, z: false }),
    ).toEqual(["b"]);
    expect(findMissingKeys("{{a}}", { a: undefined })).toEqual(["a"]);
    expect(findMissingKeys("{{a}}", { a: [] })).toEqual([]);
  });
});
