import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PanelSpec,
  SkillUiCapability,
  SkillUiInfo,
  SkillUiManifest,
} from "@shared/types";
import { SKILL_UI_CAPABILITIES } from "@shared/types";
import { resolveActiveHomeSync } from "../hermes/detect";
import { parsePanelYaml } from "./panel";

/**
 * Skill UI 发现层。
 *
 * 扫描 skills 根目录，找出含 UI 的功能型 skill：
 *   - `ui/manifest.json` → 命令式 UI（协议 24os-skill-ui/1，`uiHost:"iframe"`）；
 *   - `ui/panel.yaml`    → 声明式 UI（协议 24os-skill-panel/1，`uiHost:"declarative"`）；
 *   - 两者都有时优先 `manifest.json`。
 * 发现顺序（先出现者优先）：
 *   1) OS_SKILL_ROOTS（逗号分隔的绝对路径）
 *   2) 仓库内 examples/skills（demo）
 *   3) <activeHome>/skills
 *   4) <activeHome>/profiles/<profile>/skills
 *
 * M5.0b：`<activeHome>` 由 detect 解析（env → CLI 包装脚本 home → 默认探测），
 * 与 agent 的来源保持一致（不再硬编码 ~/.hermes）；可用 activeHome 参数覆盖（测试用）。
 */

const PROTOCOL = "24os-skill-ui/1";

/** 仓库根目录（server/skillui/discover.ts → ../../）。 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** 目录读取，失败返回空数组（防御性）。 */
function safeListDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 路径去重（保留首次出现顺序）。 */
function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const abs = path.resolve(item);
    if (seen.has(abs)) continue;
    seen.add(abs);
    result.push(abs);
  }
  return result;
}

/**
 * 解析 skills 根目录（按优先级）。
 * 默认 activeHome 由 detect 同步解析；传 activeHome 可覆盖（测试用）。
 */
export function getSkillRoots(activeHome?: string): string[] {
  const roots: string[] = [];
  const home = activeHome ?? resolveActiveHomeSync();

  const fromEnv = process.env.OS_SKILL_ROOTS;
  if (fromEnv) {
    for (const part of fromEnv.split(",")) {
      const trimmed = part.trim();
      if (trimmed) roots.push(trimmed);
    }
  }

  roots.push(path.join(REPO_ROOT, "examples", "skills"));
  roots.push(path.join(home, "skills"));

  const profilesDir = path.join(home, "profiles");
  for (const profile of safeListDirs(profilesDir)) {
    roots.push(path.join(profilesDir, profile, "skills"));
  }

  return unique(roots);
}

/** 判断是否为合法的 capability。 */
function isCapability(value: unknown): value is SkillUiCapability {
  return (
    typeof value === "string" &&
    (SKILL_UI_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * 校验并规范化 manifest。返回 null 表示该 ui/manifest.json 不可用，应跳过。
 * 仅接受 protocol === "24os-skill-ui/1"。
 */
export function parseManifest(raw: unknown): SkillUiManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const protocol = typeof obj.protocol === "string" ? obj.protocol : "";
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const entry = typeof obj.entry === "string" ? obj.entry.trim() : "";
  const host = obj.host;

  if (protocol !== PROTOCOL) return null;
  if (!id || !title) return null;
  if (!entry || !entry.toLowerCase().endsWith(".html")) return null;
  if (host !== "iframe") return null;

  const capabilities = Array.isArray(obj.capabilities)
    ? obj.capabilities.filter(isCapability)
    : [];
  const permissions = Array.isArray(obj.permissions)
    ? obj.permissions.filter((p): p is string => typeof p === "string")
    : [];

  let size: SkillUiManifest["size"];
  if (obj.size && typeof obj.size === "object" && !Array.isArray(obj.size)) {
    const s = obj.size as Record<string, unknown>;
    const width = typeof s.width === "number" ? s.width : undefined;
    const height = typeof s.height === "number" ? s.height : undefined;
    if (width !== undefined && height !== undefined) size = { width, height };
  }

  return {
    protocol,
    id,
    title,
    entry,
    host,
    capabilities,
    permissions,
    ...(size ? { size } : {}),
  };
}

/** 尝试读取并解析某个 skill 目录下的 ui/manifest.json（命令式 UI）。 */
function readSkillManifest(skillDir: string): SkillUiInfo | null {
  const uiRoot = path.join(skillDir, "ui");
  const manifestPath = path.join(uiRoot, "manifest.json");
  if (!existsSync(manifestPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }

  const manifest = parseManifest(raw);
  if (!manifest) return null;

  return {
    id: manifest.id,
    title: manifest.title,
    skillPath: skillDir,
    uiRoot,
    uiHost: "iframe",
    manifest,
    hasUi: true,
  };
}

/**
 * 尝试读取并解析某个 skill 目录下的 ui/panel.yaml（声明式 UI）。
 * 解析失败 / 协议不匹配 → null（视为无声明式 UI）。
 */
function readSkillPanel(
  skillDir: string,
): { id: string; title: string; uiRoot: string; panel: PanelSpec } | null {
  const uiRoot = path.join(skillDir, "ui");
  const panelPath = path.join(uiRoot, "panel.yaml");
  if (!existsSync(panelPath)) return null;

  let text: string;
  try {
    text = readFileSync(panelPath, "utf8");
  } catch {
    return null;
  }

  const result = parsePanelYaml(text);
  if (!result.ok) return null;

  return {
    id: result.spec.skill,
    title: result.spec.title,
    uiRoot,
    panel: result.spec,
  };
}

/**
 * 读取一个 skill 的 UI：优先 `ui/manifest.json`（命令式），
 * 否则回退 `ui/panel.yaml`（声明式）；两者都没有则返回 null。
 */
function readSkillUi(skillDir: string): SkillUiInfo | null {
  const fromManifest = readSkillManifest(skillDir);
  if (fromManifest) return fromManifest;

  const fromPanel = readSkillPanel(skillDir);
  if (!fromPanel) return null;

  return {
    id: fromPanel.id,
    title: fromPanel.title,
    skillPath: skillDir,
    uiRoot: fromPanel.uiRoot,
    uiHost: "declarative",
    panel: fromPanel.panel,
    hasUi: true,
  };
}

/**
 * 发现所有自带 UI 的 skill。传入 roots 可覆盖默认根目录（测试用）。
 * 同名 id 以先出现的根为准。
 */
export function discoverSkillUis(roots?: string[]): SkillUiInfo[] {
  const scanRoots = roots ?? getSkillRoots();
  const byId = new Map<string, SkillUiInfo>();

  for (const root of scanRoots) {
    for (const name of safeListDirs(root)) {
      const info = readSkillUi(path.join(root, name));
      if (!info) continue;
      if (!byId.has(info.id)) byId.set(info.id, info);
    }
  }

  return [...byId.values()];
}

/** 按 id 查找单个 Skill UI。 */
export function findSkillUi(id: string, roots?: string[]): SkillUiInfo | null {
  return discoverSkillUis(roots).find((item) => item.id === id) ?? null;
}

/**
 * 构建「skill 标识 → UI id」索引，同时登记 manifest.id 与 skill 目录名，
 * 供 agent skills 富化（hasUi / uiId）。
 */
export function buildSkillUiIndex(roots?: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const ui of discoverSkillUis(roots)) {
    index.set(ui.id, ui.id);
    index.set(path.basename(ui.skillPath), ui.id);
  }
  return index;
}
