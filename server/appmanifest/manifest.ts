import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { APP_ROOT } from "../paths";
import type {
  AppHookName,
  AppManifest,
  AppManifestHooks,
  AppManifestPlugin,
  AppManifestProfile,
  AppManifestSource,
  AppManifestUi,
  AppSourceType,
  SkillUiHostKind,
} from "@shared/types";
import { APP_HOOK_NAMES, APP_MANIFEST_PROTOCOL } from "@shared/types";
import { LifecycleError } from "../hermes/errors";

/**
 * AppManifest（`24os-appmanifest/1`）解析与校验（M6）。
 *
 * 设计取舍：
 * - 与 `skillui/panel.ts` 一致：**手写校验**，不引入新依赖；
 * - 非法 → 抛 `LifecycleError("INVALID_MANIFEST")`（路由映射为 400）；
 * - `parseAppManifest(yaml)` 负责 YAML 文本；`validateAppManifest(obj)` 负责结构。
 *
 * 校验规则：
 *   - protocol 必须为 `24os-appmanifest/1`；
 *   - id 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`；name/version 必填；
 *   - version 宽松 semver `^\d+\.\d+\.\d+$`；
 *   - source.type ∈ {builtin, path, url}；builtin/path 需 path，url 需 url；
 *   - ui.host ∈ {iframe, declarative}（若 ui 提供）；
 *   - hooks.* 每项 ∈ APP_HOOK_NAMES；plugins[].kind 恒为 http。
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SOURCE_TYPES: readonly AppSourceType[] = ["builtin", "path", "url"];
const UI_HOSTS: readonly SkillUiHostKind[] = ["iframe", "declarative"];
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmed(value: unknown): string | undefined {
  const s = asString(value)?.trim();
  return s ? s : undefined;
}

function invalid(message: string): LifecycleError {
  return new LifecycleError("INVALID_MANIFEST", message);
}

function validateHooks(raw: unknown, label: string): AppManifestHooks | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalid(`${label} 必须是对象`);

  const allowed = new Set<string>(APP_HOOK_NAMES);
  const out: AppManifestHooks = {};
  for (const key of ["oninstall", "onupdate", "ondelete"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw invalid(`${label}.${key} 必须是数组`);
    const names: AppHookName[] = [];
    for (const item of value) {
      const name = asTrimmed(item);
      if (!name || !allowed.has(name)) {
        throw invalid(`${label}.${key} 含未知 hook：${String(item)}`);
      }
      names.push(name as AppHookName);
    }
    out[key] = names;
  }
  return out;
}

function validateProfile(raw: unknown): AppManifestProfile | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalid("profile 必须是对象");
  const profile: AppManifestProfile = {};

  const template = asTrimmed(raw.template);
  if (template) profile.template = template;

  if (raw.model !== undefined) {
    if (!isRecord(raw.model)) throw invalid("profile.model 必须是对象");
    const def = asTrimmed(raw.model.default);
    if (def) profile.model = { default: def };
  }

  if (raw.mcp !== undefined) {
    if (!Array.isArray(raw.mcp)) throw invalid("profile.mcp 必须是数组");
    profile.mcp = raw.mcp.map((item, index) => {
      if (!isRecord(item)) throw invalid(`profile.mcp[${index}] 必须是对象`);
      const name = asTrimmed(item.name);
      if (!name || !MCP_NAME_PATTERN.test(name)) {
        throw invalid(`profile.mcp[${index}].name 非法：${String(item.name)}`);
      }
      const config = item.config;
      if (!isRecord(config)) {
        throw invalid(`profile.mcp[${index}].config 必须是对象`);
      }
      return { name, config: { ...config } };
    });
  }

  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) throw invalid("profile.env 必须是对象");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw invalid(`profile.env 键名非法：${key}（需匹配 ^[A-Z][A-Z0-9_]*$）`);
      }
      if (typeof value !== "string") {
        throw invalid(`profile.env.${key} 必须是字符串`);
      }
      env[key] = value;
    }
    profile.env = env;
  }

  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) throw invalid("profile.skills 必须是数组");
    profile.skills = raw.skills.map((item, index) => {
      const skill = asTrimmed(item);
      if (!skill) throw invalid(`profile.skills[${index}] 必须是非空字符串`);
      return skill;
    });
  }

  return profile;
}

function validateUi(raw: unknown): AppManifestUi | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw invalid("ui 必须是对象");
  const ui: AppManifestUi = {};
  const skillId = asTrimmed(raw.skillId);
  if (skillId) ui.skillId = skillId;
  if (raw.host !== undefined) {
    const host = asString(raw.host);
    if (!host || !(UI_HOSTS as readonly string[]).includes(host)) {
      throw invalid(`ui.host 非法：${String(raw.host)}（需为 iframe | declarative）`);
    }
    ui.host = host as SkillUiHostKind;
  }
  return ui;
}

function validatePlugins(raw: unknown): AppManifestPlugin[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw invalid("plugins 必须是数组");
  return raw.map((item, index) => {
    if (!isRecord(item)) throw invalid(`plugins[${index}] 必须是对象`);
    const name = asTrimmed(item.name);
    if (!name) throw invalid(`plugins[${index}] 缺少 name`);
    const kind = asString(item.kind);
    if (kind !== "http") {
      throw invalid(`plugins[${index}].kind 非法：${String(item.kind)}（目前仅支持 http）`);
    }
    const plugin: AppManifestPlugin = { name, kind: "http" };
    const endpoint = asTrimmed(item.endpoint);
    if (endpoint) plugin.endpoint = endpoint;
    const envKey = asTrimmed(item.envKey);
    if (envKey) {
      if (!ENV_KEY_PATTERN.test(envKey)) {
        throw invalid(`plugins[${index}].envKey 非法：${envKey}`);
      }
      plugin.envKey = envKey;
    }
    return plugin;
  });
}

function validateSource(raw: unknown): AppManifestSource {
  if (!isRecord(raw)) throw invalid("source 必须是对象");
  const type = asString(raw.type);
  if (!type || !(SOURCE_TYPES as readonly string[]).includes(type)) {
    throw invalid(`source.type 非法：${String(raw.type)}（需为 builtin | path | url）`);
  }
  const sourceType = type as AppSourceType;
  const source: AppManifestSource = { type: sourceType };

  const p = asTrimmed(raw.path);
  const url = asTrimmed(raw.url);
  if (sourceType === "builtin" || sourceType === "path") {
    if (!p) throw invalid(`source.type=${sourceType} 需要 source.path`);
    source.path = p;
  }
  if (sourceType === "url") {
    if (!url) throw invalid("source.type=url 需要 source.url");
    if (!/^(https?|ssh):\/\//i.test(url) && !/^git@/.test(url)) {
      throw invalid(`source.url 非法：${url}`);
    }
    source.url = url;
    if (p) source.path = p;
  }
  return source;
}

/** 校验并规范化一个 AppManifest 对象；非法抛 INVALID_MANIFEST。 */
export function validateAppManifest(raw: unknown): AppManifest {
  if (!isRecord(raw)) throw invalid("AppManifest 必须是对象");

  const protocol = asString(raw.protocol);
  if (protocol !== APP_MANIFEST_PROTOCOL) {
    throw invalid(
      `protocol 必须为 ${APP_MANIFEST_PROTOCOL}（实际：${String(raw.protocol)}）`,
    );
  }

  const id = asTrimmed(raw.id);
  if (!id || !ID_PATTERN.test(id)) {
    throw invalid(
      `id 非法：${String(raw.id)}（要求匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }

  const name = asTrimmed(raw.name);
  if (!name) throw invalid("name 必填");

  const version = asTrimmed(raw.version);
  if (!version || !VERSION_PATTERN.test(version)) {
    throw invalid(`version 非法：${String(raw.version)}（需匹配 ^\\d+\\.\\d+\\.\\d+$）`);
  }

  const manifest: AppManifest = {
    protocol,
    id,
    name,
    version,
    source: validateSource(raw.source),
  };

  const description = asTrimmed(raw.description);
  if (description) manifest.description = description;

  const profile = validateProfile(raw.profile);
  if (profile) manifest.profile = profile;

  const ui = validateUi(raw.ui);
  if (ui) manifest.ui = ui;

  const hooks = validateHooks(raw.hooks, "hooks");
  if (hooks) manifest.hooks = hooks;

  const plugins = validatePlugins(raw.plugins);
  if (plugins) manifest.plugins = plugins;

  if (raw.sign !== undefined) {
    if (!isRecord(raw.sign)) throw invalid("sign 必须是对象");
    const sha256 = asTrimmed(raw.sign.sha256);
    if (sha256 !== undefined && sha256 !== "" && !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw invalid("sign.sha256 必须是 64 位十六进制（或留空跳过校验）");
    }
    manifest.sign = sha256 ? { sha256: sha256.toLowerCase() } : { sha256: "" };
  }

  return manifest;
}

/** 解析 AppManifest YAML 文本并校验；非法抛 INVALID_MANIFEST。 */
export function parseAppManifest(yamlStr: string): AppManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlStr);
  } catch (error) {
    throw invalid(`YAML 解析失败：${(error as Error).message}`);
  }
  return validateAppManifest(raw);
}

/** 宽松包装：非法返回 null。 */
export function tryParseAppManifest(yamlStr: string): AppManifest | null {
  try {
    return parseAppManifest(yamlStr);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * builtin catalog：market/apps/*.app.yaml
 * ------------------------------------------------------------------ */

/** 仓库根目录（统一由 server/paths.ts 解析，兼容源码 / 打包形态）。 */
const REPO_ROOT = APP_ROOT;

/** builtin AppManifest 目录（可用 OS_MARKET_APPS_DIR 覆盖，便于测试）。 */
export function getMarketAppsDir(): string {
  const override = process.env.OS_MARKET_APPS_DIR?.trim();
  return override && override.length > 0 ? override : path.join(REPO_ROOT, "market", "apps");
}

/** 读取全部合法的 builtin AppManifest（损坏 / 非法文件跳过）。 */
export function listBuiltinAppManifests(): AppManifest[] {
  const dir = getMarketAppsDir();
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".app.yaml") || name.endsWith(".app.yml"))
      .sort();
  } catch {
    return [];
  }

  const out: AppManifest[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const manifest = tryParseAppManifest(readFileSync(file, "utf8"));
      if (manifest && !seen.has(manifest.id)) {
        seen.add(manifest.id);
        out.push(manifest);
      }
    } catch {
      // 跳过读取失败的文件。
    }
  }
  return out;
}

/** 按 id 查找 builtin AppManifest。 */
export function findBuiltinAppManifest(id: string): AppManifest | null {
  return listBuiltinAppManifests().find((item) => item.id === id) ?? null;
}

/**
 * 解析 source 目录（仅 type=builtin/path）。
 * builtin / 相对路径先相对仓库根，再回退 cwd。
 */
export function resolveAppSourceDir(
  manifest: AppManifest,
  repoRoot: string = REPO_ROOT,
): string | null {
  const p = manifest.source.path;
  if (!p) return null;
  if (path.isAbsolute(p)) return path.resolve(p);
  const fromRepo = path.resolve(repoRoot, p);
  if (existsSync(fromRepo)) return fromRepo;
  return path.resolve(p);
}
