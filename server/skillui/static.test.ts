import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentTypeFor, resolveUiAsset, SKILL_UI_CSP } from "./static";

const tempDirs: string[] = [];

/** 创建一个 uiRoot 与一个位于其外层的敏感文件。 */
function makeUiRoot(): { uiRoot: string; outsideFile: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "24os-static-"));
  tempDirs.push(base);
  const uiRoot = path.join(base, "ui");
  mkdirSync(uiRoot, { recursive: true });
  writeFileSync(path.join(uiRoot, "index.html"), "<!doctype html>", "utf8");
  writeFileSync(path.join(uiRoot, "main.js"), "console.log(1)", "utf8");
  writeFileSync(path.join(uiRoot, "styles.css"), "body{}", "utf8");
  writeFileSync(path.join(uiRoot, "notes.txt"), "secret", "utf8");
  writeFileSync(path.join(uiRoot, "pic.svg"), "<svg/>", "utf8");
  writeFileSync(path.join(uiRoot, "panel.yaml"), "protocol: 24os-skill-panel/1", "utf8");
  writeFileSync(path.join(uiRoot, "README.md"), "# ui", "utf8");
  mkdirSync(path.join(uiRoot, "templates"), { recursive: true });
  writeFileSync(path.join(uiRoot, "templates", "index.json"), "[]", "utf8");
  mkdirSync(path.join(uiRoot, "sub"), { recursive: true });
  writeFileSync(path.join(uiRoot, "sub", "index.html"), "<!doctype html>", "utf8");
  const outsideFile = path.join(base, "secret.env");
  writeFileSync(outsideFile, "TOKEN=1", "utf8");
  return { uiRoot, outsideFile };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveUiAsset —— 防目录穿越与扩展名白名单", () => {
  it("正常文件可解析，空路径回退到 index.html", () => {
    const { uiRoot } = makeUiRoot();
    expect(resolveUiAsset(uiRoot, "main.js")?.absolute).toBe(path.join(uiRoot, "main.js"));
    expect(resolveUiAsset(uiRoot, "")?.absolute).toBe(path.join(uiRoot, "index.html"));
    expect(resolveUiAsset(uiRoot, "sub/")?.absolute).toBe(path.join(uiRoot, "sub", "index.html"));
  });

  it("拒绝 ../ 目录穿越", () => {
    const { uiRoot } = makeUiRoot();
    expect(resolveUiAsset(uiRoot, "../secret.env")).toBeNull();
    expect(resolveUiAsset(uiRoot, "../../etc/passwd")).toBeNull();
    expect(resolveUiAsset(uiRoot, "a/../../secret.env")).toBeNull();
  });

  it("拒绝非白名单扩展名（即使文件存在）", () => {
    const { uiRoot } = makeUiRoot();
    expect(resolveUiAsset(uiRoot, "notes.txt")).toBeNull();
    expect(resolveUiAsset(uiRoot, "secret.env")).toBeNull();
    // 白名单内的仍然可用。
    expect(resolveUiAsset(uiRoot, "pic.svg")?.ext).toBe(".svg");
  });

  it("拒绝不存在的文件与 NUL 字节", () => {
    const { uiRoot } = makeUiRoot();
    expect(resolveUiAsset(uiRoot, "nope.html")).toBeNull();
    expect(resolveUiAsset(uiRoot, "a\0b.html")).toBeNull();
  });

  it("M4.1：放行 yaml/yml/md 与 templates/ 子目录", () => {
    const { uiRoot } = makeUiRoot();
    expect(resolveUiAsset(uiRoot, "panel.yaml")?.ext).toBe(".yaml");
    expect(resolveUiAsset(uiRoot, "README.md")?.ext).toBe(".md");
    expect(resolveUiAsset(uiRoot, "templates/index.json")?.absolute).toBe(
      path.join(uiRoot, "templates", "index.json"),
    );
  });

  it("M4.1：新增扩展名不放松穿越防护", () => {
    const { uiRoot } = makeUiRoot();
    expect(resolveUiAsset(uiRoot, "../panel.yaml")).toBeNull();
    expect(resolveUiAsset(uiRoot, "templates/../../panel.yaml")).toBeNull();
  });
});

describe("响应头与 MIME", () => {
  it("CSP 为严格策略且 connect-src 被禁用", () => {
    expect(SKILL_UI_CSP).toContain("default-src 'none'");
    expect(SKILL_UI_CSP).toContain("script-src 'self'");
    expect(SKILL_UI_CSP).toContain("connect-src 'none'");
  });

  it("扩展名映射 Content-Type", () => {
    expect(contentTypeFor(".html")).toContain("text/html");
    expect(contentTypeFor(".js")).toContain("text/javascript");
    expect(contentTypeFor(".woff2")).toBe("font/woff2");
    expect(contentTypeFor(".yaml")).toContain("text/yaml");
    expect(contentTypeFor(".yml")).toContain("text/yaml");
    expect(contentTypeFor(".md")).toContain("text/markdown");
  });
});
