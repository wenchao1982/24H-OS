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

beforeEach(async () => {
  const root = newTempDir("24os-skillui-routes-");
  writePanelSkill(root, "decl-panel");
  writeManifestSkill(root, "ifr-ui");
  // uiRoot 之外的敏感文件（用于穿越断言）。
  writeFileSync(path.join(root, "decl-panel", "secret.yaml"), "boom", "utf8");
  process.env.OS_SKILL_ROOTS = root;

  app = Fastify();
  await app.register(skillUiRoutes);
});

afterEach(async () => {
  await app.close();
  if (savedRoots === undefined) delete process.env.OS_SKILL_ROOTS;
  else process.env.OS_SKILL_ROOTS = savedRoots;
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
