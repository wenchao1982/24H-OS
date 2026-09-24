import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Agent, McpServer, Skill } from "@shared/types";
import { HERMES_HOME } from "./detect";

/**
 * 读取真实 Hermes profile，产出 Agent 列表。
 *
 * 约定：一个 Hermes profile = 一个 agent。
 * 数据来源：
 *   1) ~/.hermes/profiles/<name>/          —— 命名 profile
 *   2) ~/.hermes 本身（无 profiles 时）    —— 视为名为 "default" 的 profile
 *
 * config.yaml 使用成熟的 `yaml` 库解析（纯 JS，无原生编译），
 * 并对缩进做了预处理，以容忍 tab / 混合缩进（YAML 规范本身不允许 tab 缩进）。
 */

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

/** 文件读取，失败返回 null。 */
function safeRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 在给定目录里找到第一个存在的候选文件。 */
function firstExisting(dir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * 把每行行首的 tab 展开为两个空格。
 * 目的：容忍用 tab 缩进的 config.yaml（YAML 规范不允许 tab，直接 parse 会抛错）。
 */
function expandLeadingTabs(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const prefix = line.match(/^[ \t]*/)?.[0] ?? "";
      if (!prefix.includes("\t")) return line;
      return prefix.replace(/\t/g, "  ") + line.slice(prefix.length);
    })
    .join("\n");
}

/** 解析 YAML 字符串为对象；失败或非对象返回 null（防御性）。 */
export function parseConfigObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(expandLeadingTabs(raw));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 从已解析的 config 中取模型：`model`（字符串）或 `model.default`。 */
export function extractModel(config: Record<string, unknown> | null): string | null {
  if (!config) return null;
  const model = config.model;
  if (typeof model === "string" && model.trim()) return model.trim();
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const def = (model as Record<string, unknown>).default;
    if (typeof def === "string" && def.trim()) return def.trim();
  }
  return null;
}

/** 把 mcp_servers 的原始值（对象）规范化为结构化的 McpServer[]。 */
function normalizeMcpServers(raw: unknown): McpServer[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([id, value]) => {
    const spec =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const command = typeof spec.command === "string" ? spec.command : undefined;
    const args = Array.isArray(spec.args)
      ? spec.args.filter((item): item is string => typeof item === "string")
      : undefined;
    const url = typeof spec.url === "string" ? spec.url : undefined;
    const headers =
      spec.headers && typeof spec.headers === "object" && !Array.isArray(spec.headers)
        ? Object.fromEntries(
            Object.entries(spec.headers as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    const enabled = typeof spec.enabled === "boolean" ? spec.enabled : undefined;
    const transport: "stdio" | "http" | undefined = command
      ? "stdio"
      : url
        ? "http"
        : undefined;
    return { id, name: id, command, args, url, headers, transport, enabled };
  });
}

/** 从 config 顶层 `mcp_servers`（或 `mcpServers`）取 MCP server 列表。 */
export function extractMcpServers(config: Record<string, unknown> | null): McpServer[] {
  if (!config) return [];
  const raw = config.mcp_servers ?? config.mcpServers;
  return normalizeMcpServers(raw);
}

/** 把 JSON 中的 skills 字段规范化为 Skill[]（字符串或对象都支持）。 */
function normalizeSkills(raw: unknown): Skill[] {
  if (!Array.isArray(raw)) return [];
  const result: Skill[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      result.push({ id: item.trim(), name: item.trim() });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof obj.id === "string"
            ? obj.id
            : null;
      if (!name) continue;
      result.push({
        id: typeof obj.id === "string" ? obj.id : name,
        name,
        description: typeof obj.description === "string" ? obj.description : undefined,
        path: typeof obj.path === "string" ? obj.path : undefined,
        enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
      });
    }
  }
  return result;
}

/**
 * 从 markdown 中提取描述：取第一个**非标题、非空**的正文段落。
 * 跳过 `#` 开头的标题行与空行；段落遇到空行即结束。
 */
export function extractDescription(text: string): string {
  const paragraph: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      if (paragraph.length > 0) break; // 段落结束
      continue; // 跳过开头空行
    }
    if (line.startsWith("#")) continue; // 跳过标题
    paragraph.push(line);
  }
  return paragraph.join(" ").slice(0, 240);
}

/** 解析单个目录为一个 Agent（best-effort）。 */
export function parseAgentDir(id: string, dir: string): Agent {
  let description = "";
  let model = "";
  let skills: Skill[] = [];
  let mcpServers: McpServer[] = [];

  // 1) 结构化 JSON（若有）：最可靠。
  const jsonPath = firstExisting(dir, ["agent.json", "config.json", "profile.json"]);
  if (jsonPath) {
    const raw = safeRead(jsonPath);
    if (raw) {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (typeof data.description === "string") description = data.description;
        const jsonModel = extractModel(data);
        if (jsonModel) model = jsonModel;
        skills = normalizeSkills(data.skills);
        const mcpField = data.mcp_servers ?? data.mcpServers;
        mcpServers = normalizeMcpServers(mcpField);
      } catch {
        // 忽略损坏的 JSON，继续走下面的兜底。
      }
    }
  }

  // 2) markdown 描述兜底。
  if (!description) {
    const mdPath = firstExisting(dir, ["AGENT.md", "README.md", "PROFILE.md"]);
    if (mdPath) {
      const raw = safeRead(mdPath);
      if (raw) description = extractDescription(raw);
    }
  }

  // 3) YAML 兜底：模型 + mcp servers。
  const yamlPath = firstExisting(dir, ["config.yaml", "config.yml"]);
  if (yamlPath) {
    const raw = safeRead(yamlPath);
    if (raw) {
      const config = parseConfigObject(raw);
      if (!model) model = extractModel(config) ?? "";
      if (mcpServers.length === 0) mcpServers = extractMcpServers(config);
    }
  }

  // 4) skills 目录兜底：~/.hermes/profiles/<id>/skills/*。
  if (skills.length === 0) {
    const skillsDir = path.join(dir, "skills");
    skills = safeListDirs(skillsDir).map((name) => ({
      id: name,
      name,
      path: path.join(skillsDir, name),
      enabled: true,
    }));
  }

  return {
    id,
    name: id,
    description: description || `Hermes profile「${id}」`,
    model: model || "unknown",
    skills,
    mcpServers,
    path: dir,
    source: "profiles",
  };
}

/** 把 home 本身当作默认 profile（无命名 profiles 时使用）。 */
function parseHomeAgent(home: string): Agent | null {
  const yamlPath = firstExisting(home, ["config.yaml", "config.yml"]);
  const jsonPath = firstExisting(home, ["config.json"]);
  if (!yamlPath && !jsonPath) return null;

  const agent = parseAgentDir("default", home);
  agent.description = `Hermes 根目录（${home}）对应的默认 profile。`;
  return agent;
}

/**
 * 读取所有真实 profile，返回 Agent 列表。
 * `home` 应传入探测得到的 activeHome（与 configEdit / CLI 保持一致）；
 * 缺省时退回模块加载期解析的 HERMES_HOME（默认 ~/.hermes）。
 */
export function readProfiles(home: string = HERMES_HOME): Agent[] {
  const profilesDir = path.join(home, "profiles");
  const names = safeListDirs(profilesDir);

  if (names.length > 0) {
    return names.map((name) => parseAgentDir(name, path.join(profilesDir, name)));
  }

  // 没有命名 profile 时，退回到 home 本身的默认配置。
  const homeAgent = parseHomeAgent(home);
  return homeAgent ? [homeAgent] : [];
}
