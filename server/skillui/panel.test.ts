import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findMissingKeys, interpolatePrompt, PanelInterpolationError } from "@shared/panel";
import { parsePanel, parsePanelYaml, validatePanel } from "./panel";

/** 一个最小合法面板对象。 */
function validPanel(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "24os-skill-panel/1",
    skill: "demo",
    title: "示例",
    view: "form",
    fields: [
      { key: "topic", label: "主题", type: "text", required: true },
      { key: "pages", label: "页数", type: "slider", min: 3, max: 20, default: 8 },
      {
        key: "template",
        label: "模板",
        type: "select",
        options_from: "templates/index.json",
      },
    ],
    actions: [{ id: "run", label: "生成", kind: "prompt", prompt: "主题：{{topic}}" }],
    ...extra,
  };
}

describe("validatePanel —— 声明式面板校验", () => {
  it("合法面板通过，并规范化缺省 view / actions", () => {
    const result = validatePanel({
      protocol: "24os-skill-panel/1",
      skill: "demo",
      title: "示例",
      fields: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.view).toBe("form");
      expect(result.spec.actions).toEqual([]);
      expect(result.spec.fields).toEqual([]);
    }
  });

  it("wizard 视图被接受（前端降级为 form）", () => {
    const result = validatePanel(validPanel({ view: "wizard" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.view).toBe("wizard");
  });

  it("拒绝错误 protocol", () => {
    const result = validatePanel(validPanel({ protocol: "24os-skill-panel/2" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("protocol");
  });

  it("拒绝未知字段 type", () => {
    const result = validatePanel(
      validPanel({ fields: [{ key: "a", label: "A", type: "color" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("type");
  });

  it("select 缺 options 与 options_from 被拒", () => {
    const result = validatePanel(
      validPanel({ fields: [{ key: "a", label: "A", type: "select" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("options");
  });

  it("action 缺 prompt / kind 非 prompt 被拒", () => {
    const noPrompt = validatePanel(
      validPanel({ actions: [{ id: "run", label: "跑", kind: "prompt" }] }),
    );
    expect(noPrompt.ok).toBe(false);

    const badKind = validatePanel(
      validPanel({ actions: [{ id: "run", label: "跑", kind: "shell", prompt: "x" }] }),
    );
    expect(badKind.ok).toBe(false);
  });

  it("列表项非对象 / 字段 key 重复 / min>max 被拒", () => {
    expect(validatePanel(validPanel({ fields: ["x"] })).ok).toBe(false);
    expect(
      validatePanel(
        validPanel({
          fields: [
            { key: "a", label: "A", type: "text" },
            { key: "a", label: "B", type: "text" },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validatePanel(
        validPanel({ fields: [{ key: "n", label: "N", type: "slider", min: 10, max: 1 }] }),
      ).ok,
    ).toBe(false);
  });

  it("preview.kind=iframe 缺 source 被拒", () => {
    const result = validatePanel(validPanel({ preview: { kind: "iframe" } }));
    expect(result.ok).toBe(false);
  });

  it("parsePanel 对非法输入返回 null，合法返回规范", () => {
    expect(parsePanel(null)).toBeNull();
    expect(parsePanel({ protocol: "x" })).toBeNull();
    expect(parsePanel(validPanel())?.skill).toBe("demo");
  });
});

describe("parsePanelYaml —— YAML 文本解析", () => {
  it("仓库示例 outline/ui/panel.yaml 可解析且合法", () => {
    const file = fileURLToPath(
      new URL("../../examples/skills/outline/ui/panel.yaml", import.meta.url),
    );
    const result = parsePanelYaml(readFileSync(file, "utf8"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.skill).toBe("outline");
      expect(result.spec.fields.map((f) => f.type)).toEqual([
        "text",
        "select",
        "slider",
        "select",
        "textarea",
      ]);
      expect(result.spec.actions[0].kind).toBe("prompt");
    }
  });

  it("非法 YAML 文本返回失败", () => {
    const result = parsePanelYaml("protocol: [unclosed");
    expect(result.ok).toBe(false);
  });
});

describe("interpolatePrompt —— {{key}} 插值", () => {
  it("替换多个字段，含空格写法", () => {
    const out = interpolatePrompt("主题：{{topic}}，页数：{{ pages }}", {
      topic: "AI 规划",
      pages: 8,
    });
    expect(out).toBe("主题：AI 规划，页数：8");
  });

  it("默认缺失键替换为空串", () => {
    expect(interpolatePrompt("A{{missing}}B", {})).toBe("AB");
  });

  it("missing=keep 保留占位符", () => {
    expect(interpolatePrompt("A{{missing}}B", {}, { missing: "keep" })).toBe("A{{missing}}B");
  });

  it("missing=error 抛 PanelInterpolationError 并列出键", () => {
    expect(() => interpolatePrompt("{{a}} {{b}}", { a: "x" }, { missing: "error" })).toThrow(
      PanelInterpolationError,
    );
    try {
      interpolatePrompt("{{a}} {{b}}", { a: "x" }, { missing: "error" });
    } catch (err) {
      expect((err as PanelInterpolationError).keys).toEqual(["b"]);
    }
  });

  it("0 / false / 空串视为有效值，不算缺失", () => {
    expect(interpolatePrompt("{{n}}-{{f}}-{{e}}", { n: 0, f: false, e: "" })).toBe("0-false-");
    expect(findMissingKeys("{{n}}", { n: 0 })).toEqual([]);
    expect(findMissingKeys("{{a}} {{a}} {{b}}", {})).toEqual(["a", "b"]);
  });
});
