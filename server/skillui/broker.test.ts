import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillUiManifest } from "@shared/types";
import { invokeSkill } from "./broker";

/** 原始环境变量，测试后恢复。 */
const ORIGINAL_ROOTS = process.env.OS_SKILL_ROOTS;
const ORIGINAL_WORKSPACE = process.env.OS_WORKSPACE_ROOT;

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 在临时 skills 根下写一个带 manifest 的 skill。 */
function writeSkill(root: string, id: string, manifest: Partial<SkillUiManifest>): void {
  const uiDir = path.join(root, id, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>", "utf8");
  writeFileSync(
    path.join(uiDir, "manifest.json"),
    JSON.stringify({
      protocol: "24os-skill-ui/1",
      id,
      title: id,
      entry: "index.html",
      host: "iframe",
      capabilities: [],
      permissions: [],
      ...manifest,
    }),
    "utf8",
  );
}

/** 每个测试用独立的 skills 根 + 工作区根。 */
let skillsRoot: string;
let workspaceRoot: string;

beforeEach(() => {
  skillsRoot = makeTemp("24os-broker-skills-");
  workspaceRoot = makeTemp("24os-broker-ws-");
  process.env.OS_SKILL_ROOTS = skillsRoot;
  process.env.OS_WORKSPACE_ROOT = workspaceRoot;
});

afterEach(() => {
  if (ORIGINAL_ROOTS === undefined) delete process.env.OS_SKILL_ROOTS;
  else process.env.OS_SKILL_ROOTS = ORIGINAL_ROOTS;
  if (ORIGINAL_WORKSPACE === undefined) delete process.env.OS_WORKSPACE_ROOT;
  else process.env.OS_WORKSPACE_ROOT = ORIGINAL_WORKSPACE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("invokeSkill —— capability 门禁", () => {
  it("未声明 capability 的方法返回 403", async () => {
    writeSkill(skillsRoot, "t-limited", { capabilities: ["emitEvent"], permissions: [] });
    const outcome = await invokeSkill({
      skillId: "t-limited",
      method: "readFile",
      params: { path: "a.txt" },
    });
    expect(outcome.status).toBe(403);
    expect(outcome.body.ok).toBe(false);
    expect(outcome.body.error?.code).toBe("CAPABILITY_NOT_DECLARED");
  });

  it("未知 skill 返回 404，非法 id 返回 400", async () => {
    const missing = await invokeSkill({ skillId: "t-nope", method: "emitEvent" });
    expect(missing.status).toBe(404);

    const bad = await invokeSkill({ skillId: "../evil", method: "emitEvent" });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("BAD_SKILL_ID");
  });

  it("未声明 runTool 权限时返回 403", async () => {
    writeSkill(skillsRoot, "t-run-noauth", { capabilities: ["runTool"], permissions: [] });
    const outcome = await invokeSkill({
      skillId: "t-run-noauth",
      method: "runTool",
      params: { tool: "ppt.export" },
    });
    expect(outcome.status).toBe(403);
    expect(outcome.body.error?.code).toBe("PERMISSION_NOT_DECLARED");
  });

  it("工具不在白名单时返回 400 TOOL_NOT_ALLOWED", async () => {
    writeSkill(skillsRoot, "t-run-allowed", {
      capabilities: ["runTool"],
      permissions: ["tool:danger.exec"],
    });
    const outcome = await invokeSkill({
      skillId: "t-run-allowed",
      method: "runTool",
      params: { tool: "danger.exec" },
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body.error?.code).toBe("TOOL_NOT_ALLOWED");
  });
});

describe("invokeSkill —— 工作区沙箱（readFile / writeFile）", () => {
  beforeEach(() => {
    writeSkill(skillsRoot, "t-files", {
      capabilities: ["readFile", "writeFile"],
      permissions: ["fs:read:workspace", "fs:write:workspace"],
    });
  });

  it("写入后可读回，且落在 workspace 内", async () => {
    const write = await invokeSkill({
      skillId: "t-files",
      method: "writeFile",
      params: { path: "notes/a.txt", content: "hello 24os" },
    });
    expect(write.status).toBe(200);
    expect(write.body.ok).toBe(true);
    const written = write.body.result as { path: string; bytes: number };
    expect(written.bytes).toBe(Buffer.byteLength("hello 24os"));
    expect(written.path.startsWith(path.join(workspaceRoot, "t-files"))).toBe(true);
    expect(existsSync(written.path)).toBe(true);

    const read = await invokeSkill({
      skillId: "t-files",
      method: "readFile",
      params: { path: "notes/a.txt" },
    });
    expect(read.status).toBe(200);
    expect((read.body.result as { content: string }).content).toBe("hello 24os");
  });

  it("越出 workspace 的路径被拒绝（403）", async () => {
    const escape = await invokeSkill({
      skillId: "t-files",
      method: "readFile",
      params: { path: "../../secret.env" },
    });
    expect(escape.status).toBe(403);
    expect(escape.body.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");

    const writeEscape = await invokeSkill({
      skillId: "t-files",
      method: "writeFile",
      params: { path: "../evil.txt", content: "x" },
    });
    expect(writeEscape.status).toBe(403);
    expect(writeEscape.body.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });
});

describe("invokeSkill —— 工具 / 模型桩", () => {
  it("ppt.export 生成非空 pptx（使用仓库 examples/skills/ppt）", async () => {
    // 注意：discover 默认根包含仓库 examples/skills，故此处可直接用 id "ppt"。
    const outcome = await invokeSkill({
      skillId: "ppt",
      method: "runTool",
      params: {
        tool: "ppt.export",
        deck: {
          title: "冒烟测试",
          themeColor: "4C8DFF",
          slides: [
            { title: "第一页", subtitle: "来自 broker 测试", bullets: ["要点一", "要点二"] },
            { title: "第二页", bullets: ["更多要点"] },
          ],
        },
      },
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.ok).toBe(true);
    const result = outcome.body.result as { path: string };
    expect(existsSync(result.path)).toBe(true);
    expect(statSync(result.path).size).toBeGreaterThan(0);
    expect(result.path.endsWith("deck.pptx")).toBe(true);
  });

  it("callModel 为桩实现，返回 [stub] 文本", async () => {
    writeSkill(skillsRoot, "t-model", {
      capabilities: ["callModel"],
      permissions: ["model:call"],
    });
    const outcome = await invokeSkill({
      skillId: "t-model",
      method: "callModel",
      params: { prompt: "精简这段文字" },
    });
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as { text: string };
    expect(result.text).toContain("[stub]");
    expect(result.text).toContain("精简这段文字");
  });

  it("emitEvent 为 no-op 且返回 ok", async () => {
    writeSkill(skillsRoot, "t-event", { capabilities: ["emitEvent"] });
    const outcome = await invokeSkill({ skillId: "t-event", method: "emitEvent" });
    expect(outcome.status).toBe(200);
    expect(outcome.body.ok).toBe(true);
  });
});
