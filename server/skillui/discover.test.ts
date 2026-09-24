import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillUis, findSkillUi, parseManifest } from "./discover";

/** 在临时根目录下写一个 skill（可选是否带 ui/manifest.json）。 */
function writeSkill(
  root: string,
  dirName: string,
  manifest: unknown | null,
): void {
  const skillDir = path.join(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), `# ${dirName}\n`, "utf8");
  if (manifest !== null) {
    const uiDir = path.join(skillDir, "ui");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(
      path.join(uiDir, "manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      "utf8",
    );
    writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>", "utf8");
  }
}

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "24os-skillui-"));
  tempDirs.push(dir);
  return dir;
}

function validManifest(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    protocol: "24os-skill-ui/1",
    id,
    title: `UI ${id}`,
    entry: "index.html",
    host: "iframe",
    capabilities: ["emitEvent"],
    permissions: [],
    ...extra,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverSkillUis —— 发现自带 UI 的 skill", () => {
  it("只发现含合法 ui/manifest.json 的 skill，忽略无 UI 或协议不匹配者", () => {
    const root = makeRoot();
    writeSkill(root, "alpha", validManifest("alpha"));
    writeSkill(root, "no-ui", null); // 没有 ui/
    writeSkill(root, "beta", { ...(validManifest("beta") as object), protocol: "other/9" });
    writeSkill(root, "broken", "{ not json"); // 损坏 JSON

    const found = discoverSkillUis([root]);
    expect(found.map((item) => item.id)).toEqual(["alpha"]);

    const alpha = found[0];
    expect(alpha.hasUi).toBe(true);
    expect(alpha.title).toBe("UI alpha");
    expect(alpha.uiRoot).toBe(path.join(root, "alpha", "ui"));
    expect(alpha.manifest.entry).toBe("index.html");
  });

  it("同名 id 以先出现的根为准", () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    writeSkill(rootA, "dup", validManifest("dup", { title: "来自 A" }));
    writeSkill(rootB, "dup", validManifest("dup", { title: "来自 B" }));

    const found = discoverSkillUis([rootA, rootB]);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("来自 A");
  });

  it("findSkillUi 命中 / 未命中", () => {
    const root = makeRoot();
    writeSkill(root, "gamma", validManifest("gamma"));
    expect(findSkillUi("gamma", [root])?.id).toBe("gamma");
    expect(findSkillUi("missing", [root])).toBeNull();
  });
});

describe("parseManifest —— 校验", () => {
  it("拒绝非对象、错误协议、缺字段、非 html entry、非 iframe host", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("x")).toBeNull();
    expect(parseManifest({ protocol: "wrong/1", id: "a", title: "t", entry: "index.html", host: "iframe" })).toBeNull();
    expect(parseManifest({ protocol: "24os-skill-ui/1", id: "", title: "t", entry: "index.html", host: "iframe" })).toBeNull();
    expect(parseManifest({ protocol: "24os-skill-ui/1", id: "a", title: "t", entry: "main.js", host: "iframe" })).toBeNull();
    expect(parseManifest({ protocol: "24os-skill-ui/1", id: "a", title: "t", entry: "index.html", host: "popup" })).toBeNull();
  });

  it("过滤非法 capability，保留合法者", () => {
    const parsed = parseManifest({
      protocol: "24os-skill-ui/1",
      id: "a",
      title: "t",
      entry: "index.html",
      host: "iframe",
      capabilities: ["readFile", "hack", 7],
      permissions: ["fs:read:workspace", 3],
    });
    expect(parsed?.capabilities).toEqual(["readFile"]);
    expect(parsed?.permissions).toEqual(["fs:read:workspace"]);
  });
});
