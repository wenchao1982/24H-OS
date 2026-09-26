import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillUiInfo } from "@shared/types";
import { statusForCode } from "../hermes/errors";
import { isSkillDisabled, withDisabledFlags } from "./disabled";

/**
 * Skill 启停聚合判定测试：临时 OS_META_DIR，绝不触碰真实 ~/.hermes / ~/.24os。
 * 口径必须与 GET /api/skill-uis 的 disabled 完全一致（任一 agent enabled:false 即禁用）。
 */

const tempDirs: string[] = [];
const savedMetaDir = process.env.OS_META_DIR;
const savedHome = process.env.HERMES_HOME;
const savedOsHome = process.env.OS_HERMES_HOME;
let metaRoot: string;

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 写一个 agent 的 meta.json（覆盖 skills 段）。 */
function writeAgentMeta(agentId: string, skills: Record<string, unknown>): void {
  const dir = path.join(metaRoot, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "meta.json"),
    `${JSON.stringify({ skills }, null, 2)}\n`,
    "utf8",
  );
}

/** 构造最小 SkillUiInfo（disabled 判定只用 id / skillPath）。 */
function makeSkill(id: string, dirName = id): SkillUiInfo {
  return {
    id,
    title: id,
    skillPath: path.join("/tmp", "skills-root", dirName),
    uiRoot: path.join("/tmp", "skills-root", dirName, "ui"),
    uiHost: "declarative",
    hasUi: true,
  };
}

beforeEach(() => {
  metaRoot = newTempDir("24os-disabled-meta-");
  process.env.OS_META_DIR = metaRoot;
  // 官方读取仅在显式 home 时启用；测试默认隔离（避免误扫真实 ~/.hermes）。
  delete process.env.HERMES_HOME;
  delete process.env.OS_HERMES_HOME;
});

afterEach(() => {
  if (savedMetaDir === undefined) delete process.env.OS_META_DIR;
  else process.env.OS_META_DIR = savedMetaDir;
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  if (savedOsHome === undefined) delete process.env.OS_HERMES_HOME;
  else process.env.OS_HERMES_HOME = savedOsHome;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("isSkillDisabled —— 聚合口径", () => {
  it("无任何 meta 记录 → 不禁用", async () => {
    expect(await isSkillDisabled(makeSkill("solo"))).toBe(false);
  });

  it("A agent 禁用、B agent 未管 → 该 skill 禁用（任一即禁用）；未涉及的 skill 不禁用", async () => {
    writeAgentMeta("agent-a", { "skill-x": { enabled: false } });
    writeAgentMeta("agent-b", { "skill-y": { enabled: true } });

    expect(await isSkillDisabled(makeSkill("skill-x"))).toBe(true);
    // B 只管了 skill-y（启用），对 skill-x 不表态 → 聚合仍以 A 的禁用为准。
    expect(await isSkillDisabled(makeSkill("skill-y"))).toBe(false);
    // 完全未被任何 agent 管理的 skill 不禁用。
    expect(await isSkillDisabled(makeSkill("skill-z"))).toBe(false);
  });

  it("以 skill 目录名（basename）命中 → 禁用（与列表口径一致）", async () => {
    // meta 键是目录名，而 SkillUiInfo.id 可能不同（panel.skill vs 目录名）。
    writeAgentMeta("agent-a", { "outline-dir": { enabled: false } });
    expect(await isSkillDisabled(makeSkill("outline", "outline-dir"))).toBe(true);
  });

  it("enabled:true 不禁用；enabled 缺失不不禁用", async () => {
    writeAgentMeta("agent-a", {
      on: { enabled: true },
      bare: {},
    });
    expect(await isSkillDisabled(makeSkill("on"))).toBe(false);
    expect(await isSkillDisabled(makeSkill("bare"))).toBe(false);
  });
});

describe("withDisabledFlags —— 批量标注", () => {
  it("只给命中禁用集合的条目标 disabled:true", async () => {
    writeAgentMeta("agent-a", { off: { enabled: false } });
    const items = [makeSkill("off"), makeSkill("on")];
    const out = await withDisabledFlags(items);
    expect(out.find((item) => item.id === "off")?.disabled).toBe(true);
    expect(out.find((item) => item.id === "on")?.disabled).toBeUndefined();
    // 原数组不被就地修改。
    expect(items[0].disabled).toBeUndefined();
  });

  it("空禁用集合 → 原样返回", async () => {
    const items = [makeSkill("a")];
    const out = await withDisabledFlags(items);
    expect(out).toEqual(items);
    expect(out[0].disabled).toBeUndefined();
  });

  it("isSkillDisabled 与 withDisabledFlags 口径一致", async () => {
    writeAgentMeta("agent-a", { twin: { enabled: false } });
    const skill = makeSkill("twin");
    const [annotated] = await withDisabledFlags([skill]);
    expect(await isSkillDisabled(skill)).toBe(true);
    expect(annotated?.disabled).toBe(true);
  });
});

describe("SKILL_DISABLED 错误码注册", () => {
  it("statusForCode 映射 403", () => {
    expect(statusForCode("SKILL_DISABLED")).toBe(403);
  });
});

describe("M9 官方 disabled_skills 优先（meta 回退）", () => {
  it("官方 config.yaml skills.disabled 命中；同 agent 的 meta 记录被忽略", async () => {
    const home = newTempDir("24os-disabled-home-");
    const profileDir = path.join(home, "profiles", "agent-a");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      path.join(profileDir, "config.yaml"),
      "model: m\nskills:\n  disabled:\n    - official-skill\n",
      "utf8",
    );
    process.env.HERMES_HOME = home;
    // 同一 agent 的 meta 标了另一个 skill 禁用 → 官方已管理此 agent，meta 被忽略。
    writeAgentMeta("agent-a", { "meta-only": { enabled: false } });

    expect(await isSkillDisabled(makeSkill("official-skill"))).toBe(true);
    expect(await isSkillDisabled(makeSkill("meta-only"))).toBe(false);

    const [annotated] = await withDisabledFlags([makeSkill("official-skill")]);
    expect(annotated?.disabled).toBe(true);
  });

  it("无官方 skills 段的 agent 仍回退 meta（测试隔离时不影响既有口径）", async () => {
    // HERMES_HOME 已删除（beforeEach）→ 官方读取整体跳过，纯 meta 口径。
    writeAgentMeta("agent-a", { "meta-skill": { enabled: false } });
    expect(await isSkillDisabled(makeSkill("meta-skill"))).toBe(true);
  });
});
