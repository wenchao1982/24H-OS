import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillUiManifest } from "@shared/types";
import { invokeSkill } from "./broker";

/** 原始环境变量，测试后恢复。 */
const ORIGINAL_ROOTS = process.env.OS_SKILL_ROOTS;
const ORIGINAL_WORKSPACE = process.env.OS_WORKSPACE_ROOT;
const ORIGINAL_META_DIR = process.env.OS_META_DIR;

const tempDirs: string[] = [];

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 写一个 agent meta（skill 启停段），键 = skill id / 目录名。 */
function writeAgentMeta(metaRoot: string, agentId: string, skills: Record<string, unknown>): void {
  const dir = path.join(metaRoot, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ skills }, null, 2), "utf8");
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

/** 每个测试用独立的 skills 根 + 工作区根 + meta 根（禁用判定读盘隔离）。 */
let skillsRoot: string;
let workspaceRoot: string;
let metaRoot: string;

beforeEach(() => {
  skillsRoot = makeTemp("24os-broker-skills-");
  workspaceRoot = makeTemp("24os-broker-ws-");
  metaRoot = makeTemp("24os-broker-meta-");
  process.env.OS_SKILL_ROOTS = skillsRoot;
  process.env.OS_WORKSPACE_ROOT = workspaceRoot;
  process.env.OS_META_DIR = metaRoot;
});

afterEach(() => {
  if (ORIGINAL_ROOTS === undefined) delete process.env.OS_SKILL_ROOTS;
  else process.env.OS_SKILL_ROOTS = ORIGINAL_ROOTS;
  if (ORIGINAL_WORKSPACE === undefined) delete process.env.OS_WORKSPACE_ROOT;
  else process.env.OS_WORKSPACE_ROOT = ORIGINAL_WORKSPACE;
  if (ORIGINAL_META_DIR === undefined) delete process.env.OS_META_DIR;
  else process.env.OS_META_DIR = ORIGINAL_META_DIR;
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

describe("invokeSkill —— SKILL_DISABLED 门禁（与 skill-uis.disabled 同口径）", () => {
  beforeEach(() => {
    writeSkill(skillsRoot, "t-off", { capabilities: ["emitEvent"], permissions: [] });
    writeSkill(skillsRoot, "t-on", { capabilities: ["emitEvent"], permissions: [] });
    writeAgentMeta(metaRoot, "agent-a", {
      "t-off": { enabled: false },
      "t-on": { enabled: true },
    });
    // 另一 agent 未管理 t-off：聚合仍以 A 的禁用为准。
    writeAgentMeta(metaRoot, "agent-b", { "t-other": { enabled: true } });
  });

  it("禁用 skill → 403 SKILL_DISABLED；重新启用后恢复 200", async () => {
    const disabled = await invokeSkill({ skillId: "t-off", method: "emitEvent" });
    expect(disabled.status).toBe(403);
    expect(disabled.body.ok).toBe(false);
    expect(disabled.body.error?.code).toBe("SKILL_DISABLED");

    writeAgentMeta(metaRoot, "agent-a", { "t-off": { enabled: true } });
    const restored = await invokeSkill({ skillId: "t-off", method: "emitEvent" });
    expect(restored.status).toBe(200);
    expect(restored.body.ok).toBe(true);
  });

  it("未被禁用的 skill 不受影响（A 禁他、B 未管 → 只有 t-off 拦）", async () => {
    const on = await invokeSkill({ skillId: "t-on", method: "emitEvent" });
    expect(on.status).toBe(200);
    // 不存在的 skill 仍是 404（先判存在）。
    const missing = await invokeSkill({ skillId: "t-ghost", method: "emitEvent" });
    expect(missing.status).toBe(404);
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

  it("callModel 经 completePrompt（注入 stub），透传 prompt/profile 与 via", async () => {
    writeSkill(skillsRoot, "t-model", {
      capabilities: ["callModel"],
      permissions: ["model:call"],
    });
    const calls: Array<{ prompt: string; profile?: string }> = [];
    const outcome = await invokeSkill(
      {
        skillId: "t-model",
        method: "callModel",
        params: { prompt: "精简这段文字", profile: "writer" },
      },
      {
        complete: async (prompt, options) => {
          calls.push({ prompt, profile: options?.profile });
          return { text: "精简后的文字", via: "gateway" };
        },
      },
    );
    expect(outcome.status).toBe(200);
    expect(calls).toEqual([{ prompt: "精简这段文字", profile: "writer" }]);
    const result = outcome.body.result as { text: string; via: string; stub: boolean };
    expect(result.text).toBe("精简后的文字");
    expect(result.via).toBe("gateway");
    expect(result.stub).toBe(false);
  });

  it("callModel 未声明 model:call 权限 → 403 PERMISSION_NOT_DECLARED", async () => {
    writeSkill(skillsRoot, "t-model-noauth", {
      capabilities: ["callModel"],
      permissions: [],
    });
    const outcome = await invokeSkill({
      skillId: "t-model-noauth",
      method: "callModel",
      params: { prompt: "hi" },
    });
    expect(outcome.status).toBe(403);
    expect(outcome.body.error?.code).toBe("PERMISSION_NOT_DECLARED");
  });

  it("emitEvent 为 no-op 且返回 ok", async () => {
    writeSkill(skillsRoot, "t-event", { capabilities: ["emitEvent"] });
    const outcome = await invokeSkill({ skillId: "t-event", method: "emitEvent" });
    expect(outcome.status).toBe(200);
    expect(outcome.body.ok).toBe(true);
  });

  it("chatStream 收集 delta 文本（注入 streamPrompt）并透传 status/events", async () => {
    writeSkill(skillsRoot, "t-chat", {
      capabilities: ["chatStream"],
      permissions: ["model:chat"],
    });
    const outcome = await invokeSkill(
      {
        skillId: "t-chat",
        method: "chatStream",
        params: { prompt: "你好", profile: "writer" },
      },
      {
        chatStream: async (options) => {
          options.onEvent?.({ type: "delta", text: "你" });
          options.onEvent?.({ type: "delta", text: "好" });
          options.onEvent?.({ type: "done", text: "你好", status: "complete" });
          return { sessionId: "s1", status: "done", chatId: "c-test" };
        },
      },
    );
    expect(outcome.status).toBe(200);
    const result = outcome.body.result as { text: string; status: string; events: unknown[] };
    expect(result.text).toBe("你好");
    expect(result.status).toBe("done");
    expect(result.events).toHaveLength(3);
  });

  it("chatStream 未声明 model:chat 权限 → 403 PERMISSION_NOT_DECLARED", async () => {
    writeSkill(skillsRoot, "t-chat-noauth", {
      capabilities: ["chatStream"],
      permissions: [],
    });
    const outcome = await invokeSkill({
      skillId: "t-chat-noauth",
      method: "chatStream",
      params: { prompt: "hi" },
    });
    expect(outcome.status).toBe(403);
    expect(outcome.body.error?.code).toBe("PERMISSION_NOT_DECLARED");
  });
});
