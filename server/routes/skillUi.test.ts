import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelSpec, SkillUiInfo } from "@shared/types";
import { skillUiRoutes } from "./skillUi";

/**
 * Skill UI 路由测试（fastify.inject，隔离真实 ~/.hermes）：
 *   - GET /api/skill-uis 的 uiHost 判定；
 *   - GET /api/skill-uis/:id/panel 返回 PanelSpec / 404；
 *   - GET /skill-ui/:id/* 静态托管 panel.yaml 与 templates/。
 * 通过 OS_SKILL_ROOTS 指向临时目录。
 */

const tempDirs: string[] = [];
let app: FastifyInstance;
const savedRoots = process.env.OS_SKILL_ROOTS;
const savedMetaDir = process.env.OS_META_DIR;

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 声明式 skill（ui/panel.yaml）。 */
function writePanelSkill(root: string, id: string): void {
  const uiDir = path.join(root, id, "ui");
  mkdirSync(path.join(uiDir, "templates"), { recursive: true });
  writeFileSync(path.join(root, id, "SKILL.md"), `# ${id}\n`, "utf8");
  writeFileSync(
    path.join(uiDir, "panel.yaml"),
    [
      "protocol: 24os-skill-panel/1",
      `skill: ${id}`,
      `title: 面板 ${id}`,
      "fields:",
      "  - key: topic",
      "    label: 主题",
      "    type: text",
      "actions:",
      "  - id: run",
      "    label: 运行",
      "    kind: prompt",
      "    prompt: '主题：{{topic}}'",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(path.join(uiDir, "templates", "index.json"), '[{"id":"a","name":"A"}]', "utf8");
}

/** 命令式 skill（ui/manifest.json）。 */
function writeManifestSkill(root: string, id: string): void {
  const uiDir = path.join(root, id, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(path.join(root, id, "SKILL.md"), `# ${id}\n`, "utf8");
  writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>", "utf8");
  writeFileSync(
    path.join(uiDir, "manifest.json"),
    JSON.stringify({
      protocol: "24os-skill-ui/1",
      id,
      title: `UI ${id}`,
      entry: "index.html",
      host: "iframe",
      capabilities: ["emitEvent"],
      permissions: [],
    }),
    "utf8",
  );
}

/** 每个测试独立的 skills 根 / meta 根（禁用判定读盘，必须隔离真实 ~/.24os）。 */
let metaRoot: string;

beforeEach(async () => {
  const root = newTempDir("24os-skillui-routes-");
  writePanelSkill(root, "decl-panel");
  writeManifestSkill(root, "ifr-ui");
  // uiRoot 之外的敏感文件（用于穿越断言）。
  writeFileSync(path.join(root, "decl-panel", "secret.yaml"), "boom", "utf8");
  process.env.OS_SKILL_ROOTS = root;
  metaRoot = newTempDir("24os-skillui-meta-");
  process.env.OS_META_DIR = metaRoot;

  app = Fastify();
  await app.register(skillUiRoutes);
});

afterEach(async () => {
  await app.close();
  if (savedRoots === undefined) delete process.env.OS_SKILL_ROOTS;
  else process.env.OS_SKILL_ROOTS = savedRoots;
  if (savedMetaDir === undefined) delete process.env.OS_META_DIR;
  else process.env.OS_META_DIR = savedMetaDir;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/skill-uis", () => {
  it("同时发现声明式与命令式 skill，并标注 uiHost", async () => {
    const response = await app.inject({ method: "GET", url: "/api/skill-uis" });
    expect(response.statusCode).toBe(200);
    const body = response.json<SkillUiInfo[]>();
    const byId = new Map(body.map((item) => [item.id, item]));
    expect(byId.get("decl-panel")?.uiHost).toBe("declarative");
    expect(byId.get("decl-panel")?.panel?.skill).toBe("decl-panel");
    expect(byId.get("ifr-ui")?.uiHost).toBe("iframe");
    expect(byId.get("ifr-ui")?.manifest?.entry).toBe("index.html");
    // 默认无 meta 禁用记录 → 不标 disabled。
    expect(byId.get("decl-panel")?.disabled).toBeUndefined();
    expect(byId.get("ifr-ui")?.disabled).toBeUndefined();
  });

  it("meta.json 标记 enabled:false 后 skill-uis 标 disabled:true；重新启用恢复", async () => {
    const metaRoot = newTempDir("24os-skillui-meta-");
    const agentMetaDir = path.join(metaRoot, "agent-1");
    mkdirSync(agentMetaDir, { recursive: true });
    const metaFile = path.join(agentMetaDir, "meta.json");
    writeFileSync(
      metaFile,
      JSON.stringify({ skills: { "decl-panel": { enabled: false } } }),
      "utf8",
    );
    process.env.OS_META_DIR = metaRoot;

    const disabledRes = await app.inject({ method: "GET", url: "/api/skill-uis" });
    const disabledById = new Map(
      disabledRes.json<SkillUiInfo[]>().map((item) => [item.id, item]),
    );
    expect(disabledById.get("decl-panel")?.disabled).toBe(true);
    expect(disabledById.get("ifr-ui")?.disabled).toBeUndefined();

    const single = await app.inject({ method: "GET", url: "/api/skill-uis/decl-panel" });
    expect(single.json<SkillUiInfo>().disabled).toBe(true);

    // 重新启用 → 不再标 disabled。
    writeFileSync(
      metaFile,
      JSON.stringify({ skills: { "decl-panel": { enabled: true } } }),
      "utf8",
    );
    const reEnabled = await app.inject({ method: "GET", url: "/api/skill-uis" });
    const reById = new Map(
      reEnabled.json<SkillUiInfo[]>().map((item) => [item.id, item]),
    );
    expect(reById.get("decl-panel")?.disabled).toBeUndefined();
  });
});

describe("禁用拦截（403 SKILL_DISABLED）", () => {
  /** 在隔离 meta 根里把某 skill 标为 enabled:false / true。 */
  function setSkillEnabled(skillName: string, enabled: boolean): void {
    const agentDir = path.join(metaRoot, "agent-1");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "meta.json"),
      JSON.stringify({ skills: { [skillName]: { enabled } } }),
      "utf8",
    );
  }

  it("声明式：panel 与静态资源禁用 → 403 SKILL_DISABLED；重新启用恢复 200", async () => {
    setSkillEnabled("decl-panel", false);

    const panel = await app.inject({ method: "GET", url: "/api/skill-uis/decl-panel/panel" });
    expect(panel.statusCode).toBe(403);
    expect(panel.json<{ error: string }>().error).toBe("SKILL_DISABLED");

    const yaml = await app.inject({ method: "GET", url: "/skill-ui/decl-panel/panel.yaml" });
    expect(yaml.statusCode).toBe(403);
    expect(yaml.json<{ error: string }>().error).toBe("SKILL_DISABLED");

    // 列表仍可见（带 disabled 标注），但能力入口被拦。
    const list = await app.inject({ method: "GET", url: "/api/skill-uis/decl-panel" });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ disabled?: boolean }>().disabled).toBe(true);

    // 重新启用 → 恢复 200。
    setSkillEnabled("decl-panel", true);
    const panelAgain = await app.inject({
      method: "GET",
      url: "/api/skill-uis/decl-panel/panel",
    });
    expect(panelAgain.statusCode).toBe(200);
    const yamlAgain = await app.inject({ method: "GET", url: "/skill-ui/decl-panel/panel.yaml" });
    expect(yamlAgain.statusCode).toBe(200);
  });

  it("命令式：静态资源禁用 → 403；skill 不存在 → 404；启用后缺失文件 → 404", async () => {
    setSkillEnabled("ifr-ui", false);
    const disabled = await app.inject({ method: "GET", url: "/skill-ui/ifr-ui/index.html" });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json<{ error: string }>().error).toBe("SKILL_DISABLED");

    // skill 本身不存在 → 404（先判存在再判禁用的口径）。
    const missing = await app.inject({ method: "GET", url: "/skill-ui/nope/index.html" });
    expect(missing.statusCode).toBe(404);

    // 启用后：存在文件 200、缺失文件 404（与禁用 403 区分）。
    setSkillEnabled("ifr-ui", true);
    const ok = await app.inject({ method: "GET", url: "/skill-ui/ifr-ui/index.html" });
    expect(ok.statusCode).toBe(200);
    const missingFile = await app.inject({ method: "GET", url: "/skill-ui/ifr-ui/nope.js" });
    expect(missingFile.statusCode).toBe(404);
  });

  it("broker invoke：iframe 与 declarative 都拦（403 SKILL_DISABLED）", async () => {
    setSkillEnabled("ifr-ui", false);
    const invoke = await app.inject({
      method: "POST",
      url: "/api/skill-host/invoke",
      payload: { skillId: "ifr-ui", method: "emitEvent" },
    });
    expect(invoke.statusCode).toBe(403);
    expect(invoke.json<{ error?: string; ok?: boolean }>().ok).toBe(false);
    expect(invoke.json<{ error?: { code?: string } }>().error?.code).toBe("SKILL_DISABLED");

    setSkillEnabled("decl-panel", false);
    const invokePanel = await app.inject({
      method: "POST",
      url: "/api/skill-host/invoke",
      payload: { skillId: "decl-panel", method: "emitEvent" },
    });
    expect(invokePanel.statusCode).toBe(403);
    expect(invokePanel.json<{ error?: { code?: string } }>().error?.code).toBe("SKILL_DISABLED");

    setSkillEnabled("ifr-ui", true);
    const restored = await app.inject({
      method: "POST",
      url: "/api/skill-host/invoke",
      payload: { skillId: "ifr-ui", method: "emitEvent" },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ ok: boolean }>().ok).toBe(true);
  });
});

describe("GET /api/skill-uis/:id/panel", () => {
  it("声明式 skill 返回 PanelSpec", async () => {
    const response = await app.inject({ method: "GET", url: "/api/skill-uis/decl-panel/panel" });
    expect(response.statusCode).toBe(200);
    const panel = response.json<PanelSpec>();
    expect(panel.skill).toBe("decl-panel");
    expect(panel.fields[0].key).toBe("topic");
    expect(panel.actions[0].kind).toBe("prompt");
  });

  it("命令式 / 不存在的 skill 返回 404", async () => {
    const iframe = await app.inject({ method: "GET", url: "/api/skill-uis/ifr-ui/panel" });
    expect(iframe.statusCode).toBe(404);
    expect(iframe.json<{ error: string }>().error).toBe("PANEL_NOT_FOUND");

    const missing = await app.inject({ method: "GET", url: "/api/skill-uis/nope/panel" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("GET /skill-ui/:id/*", () => {
  it("声明式 skill 的 panel.yaml 与 templates/index.json 可被托管", async () => {
    const yaml = await app.inject({ method: "GET", url: "/skill-ui/decl-panel/panel.yaml" });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers["content-type"]).toContain("text/yaml");
    expect(yaml.body).toContain("24os-skill-panel/1");

    const index = await app.inject({
      method: "GET",
      url: "/skill-ui/decl-panel/templates/index.json",
    });
    expect(index.statusCode).toBe(200);
    expect(index.json<Array<{ id: string }>>()[0].id).toBe("a");
  });

  it("穿越到 uiRoot 之外被拒（404）", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/skill-ui/decl-panel/..%2Fsecret.yaml",
    });
    expect(response.statusCode).toBe(404);
  });
});
