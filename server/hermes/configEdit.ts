import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, parseDocument } from "yaml";
import type {
  AddMcpServerRequest,
  AgentConfig,
  ConfigEditResult,
  McpServer,
  McpServerSpec,
  SetEnvRequest,
  UpdateAgentConfigRequest,
  UpdateMcpServerRequest,
} from "@shared/types";
import { resolveHermesCli, runHermes } from "./cli";
import { LifecycleError } from "./errors";
import { extractMcpServers, extractModel, parseConfigObject } from "./profiles";

/**
 * Agent 配置编辑层（M3）。
 *
 * 目标：让工作台把用户在 UI 里的修改**安全地落盘**到 Hermes profile。
 * 覆盖四类配置：
 *   - 模型：`<profile>/config.yaml` 顶层 `model`（若为 mapping 则写 `model.default`）；
 *   - 功能描述 / 标签：工作台自有元数据 `~/.24os/agents/<id>/meta.json`
 *     （与 Hermes 无关，避免猜测 Hermes 内部字段）；
 *   - MCP servers：`config.yaml` 顶层 `mcp_servers`；
 *   - 环境变量（密钥）：`<profile>/.env`（若 CLI 可用则优先 `hermes config set`）。
 *
 * 安全基线（所有写操作共同保证）：
 *   1. confirm：未显式 `confirm:true` → CONFIRM_REQUIRED，不触碰磁盘；
 *   2. 备份：写前把目标文件复制到 `~/.24os/backups/<id>/<file>.<ISO>.bak`，
 *      每个文件最多保留 10 份（超出删最旧）；
 *   3. 原子写：先写同目录临时文件再 `rename`，避免写入中断产生半截文件；
 *   4. 路径安全：id 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，解析后目录必须位于
 *      `~/.hermes/profiles/` 或等于 `~/.hermes`；备份文件名禁止任何路径分隔符；
 *   5. 密钥不回显：env 相关返回值只含键名，绝不包含明文值；CLI 命令字符串不外泄。
 *
 * 可测试性：所有函数通过 deps 注入 hermesHome / backupDir / metaDir / cliPath，
 * 测试始终使用临时目录，绝不触碰真实 `~/.hermes`。
 */

/** 配置编辑依赖注入（全部可选，便于测试隔离）。 */
export interface ConfigEditDeps {
  /** Hermes 主目录（默认 HERMES_HOME/OS_HERMES_HOME 或 ~/.hermes）。 */
  hermesHome?: string;
  /** 备份根目录（默认 OS_CONFIG_BACKUP_DIR / OS_BACKUP_DIR 或 ~/.24os/backups）。 */
  backupDir?: string;
  /** 工作台元数据根目录（默认 OS_META_DIR 或 ~/.24os/agents）。 */
  metaDir?: string;
  /** 显式 CLI 路径（null = 不可用）；不传则自动探测。 */
  cliPath?: string | null;
  /** 单条 CLI 命令超时（毫秒）。 */
  timeoutMs?: number;
}

/** id / profile 名合法格式。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** MCP server 名合法格式（比 id 宽松：允许大写）。 */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** 环境变量名合法格式。 */
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** 每个文件保留的备份份数上限。 */
export const MAX_BACKUPS = 10;

/** `.env` 里合法的赋值行（允许可选的 `export` 前缀）。 */
const ENV_LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** 允许通过 restoreBackup 还原的目标文件名白名单。 */
const RESTORABLE_FILES = new Set([
  ".env",
  "config.yaml",
  "config.yml",
  "config.json",
  "meta.json",
]);

/* ------------------------------------------------------------------ *
 * 路径解析与校验
 * ------------------------------------------------------------------ */

/** 解析 Hermes 主目录（在调用时读取 env，便于测试注入）。 */
export function resolveHermesHome(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.OS_HERMES_HOME ?? process.env.HERMES_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".hermes");
}

/** 备份根目录。 */
export function resolveBackupRoot(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.OS_CONFIG_BACKUP_DIR ?? process.env.OS_BACKUP_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".24os", "backups");
}

/** 工作台元数据根目录。 */
export function resolveMetaRoot(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.OS_META_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".24os", "agents");
}

/** target 是否位于 root 之内（含 root 本身）。 */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 校验 agent id，非法抛 INVALID_NAME。 */
export function validateAgentId(id: unknown): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new LifecycleError(
      "INVALID_NAME",
      `非法的 id：${String(id)}（要求匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }
  return id;
}

/** 校验 MCP server 名，非法抛 INVALID_MCP_SERVER。 */
export function validateMcpName(name: unknown): string {
  if (typeof name !== "string" || !MCP_NAME_PATTERN.test(name)) {
    throw new LifecycleError(
      "INVALID_MCP_SERVER",
      `非法的 MCP server 名：${String(name)}（要求匹配 ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$）`,
    );
  }
  return name;
}

/** 校验环境变量名，非法抛 INVALID_KEY。 */
export function validateEnvKey(key: unknown): string {
  if (typeof key !== "string" || !ENV_KEY_PATTERN.test(key)) {
    throw new LifecycleError(
      "INVALID_KEY",
      `非法的环境变量名：${String(key)}（要求匹配 ^[A-Z][A-Z0-9_]*$）`,
    );
  }
  return key;
}

/**
 * 解析 agent 目录。
 * 优先 `~/.hermes/profiles/<id>`；当 id === "default" 且命名 profile 不存在时，
 * 使用 `~/.hermes` 本身。目录不存在抛 AGENT_NOT_FOUND。
 */
export function resolveAgentDir(id: string, deps: ConfigEditDeps = {}): string {
  const agentId = validateAgentId(id);
  const hermesHome = resolveHermesHome(deps.hermesHome);
  const profilesDir = path.join(hermesHome, "profiles");
  const named = path.join(profilesDir, agentId);

  // 防御性：即便 id 已严格校验，也再次确认没有越出 profilesDir。
  if (!isWithin(profilesDir, named)) {
    throw new LifecycleError("PATH_TRAVERSAL", `拒绝越界路径：${named}`);
  }

  if (existsSync(named) && statSync(named).isDirectory()) return named;

  if (agentId === "default" && existsSync(hermesHome) && statSync(hermesHome).isDirectory()) {
    return hermesHome;
  }

  throw new LifecycleError("AGENT_NOT_FOUND", `未找到 agent 目录：${named}`);
}

/** agent 的 meta.json 路径（工作台自有元数据，与 Hermes 隔离）。 */
export function metaPathFor(id: string, deps: ConfigEditDeps = {}): string {
  const agentId = validateAgentId(id);
  return path.join(resolveMetaRoot(deps.metaDir), agentId, "meta.json");
}

/** 在目录里找到第一个存在的候选文件。 */
function firstExisting(dir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/** 解析要写入的 config 文件路径：已存在则沿用，否则默认 config.yaml。 */
function resolveConfigPath(dir: string): string {
  return firstExisting(dir, ["config.yaml", "config.yml"]) ?? path.join(dir, "config.yaml");
}

/* ------------------------------------------------------------------ *
 * 原子写 / 备份
 * ------------------------------------------------------------------ */

/** ISO 时间戳（把 : 与 . 换成 -，可直接做文件名）。 */
function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 原子写：先写同目录临时文件，再 rename 覆盖。 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 同一目录内按 basename 分组、只保留最近 keep 份备份，删除最旧的。 */
async function pruneBackups(dir: string, base: string, keep: number): Promise<void> {
  const prefix = `${base}.`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .sort();
  const excess = candidates.length - keep;
  for (let i = 0; i < excess; i += 1) {
    await rm(path.join(dir, candidates[i]), { force: true }).catch(() => undefined);
  }
}

/**
 * 写前备份目标文件到 `~/.24os/backups/<id>/<file>.<ISO>.bak`。
 * 目标不存在时返回 null（无需备份）。同毫秒多次写会追加序号避免覆盖。
 */
export async function backupFile(
  id: string,
  file: string,
  deps: ConfigEditDeps = {},
): Promise<string | null> {
  if (!existsSync(file)) return null;
  const dir = path.join(resolveBackupRoot(deps.backupDir), id);
  await mkdir(dir, { recursive: true });
  const base = path.basename(file);
  const stamp = nowStamp();
  let dest = path.join(dir, `${base}.${stamp}.bak`);
  let n = 1;
  while (existsSync(dest)) {
    dest = path.join(dir, `${base}.${stamp}-${n}.bak`);
    n += 1;
  }
  await copyFile(file, dest);
  await pruneBackups(dir, base, MAX_BACKUPS);
  return dest;
}

/** 累加器：记录本次动作写过的文件与产生的备份。 */
interface WriteAcc {
  files: string[];
  backups: string[];
}

/** 备份 + 原子写，并记录到 acc。 */
async function writeWithBackup(
  id: string,
  file: string,
  content: string,
  deps: ConfigEditDeps,
  acc: WriteAcc,
): Promise<void> {
  const backup = await backupFile(id, file, deps);
  if (backup) acc.backups.push(backup);
  await atomicWrite(file, content);
  acc.files.push(file);
}

/* ------------------------------------------------------------------ *
 * YAML / JSON / .env 工具
 * ------------------------------------------------------------------ */

/** 把行首 tab 展开为两个空格（容忍 tab 缩进的 config.yaml）。 */
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

/**
 * 用 Document API 解析 YAML，保留注释与字段顺序。
 * 空内容返回空 Document；无法解析抛 CONFIG_PARSE_FAILED。
 */
function parseYamlDocument(raw: string): Document {
  const text = raw ?? "";
  if (text.trim() === "") return new Document();
  const candidates = [text];
  const expanded = expandLeadingTabs(text);
  if (expanded !== text) candidates.push(expanded);
  for (const candidate of candidates) {
    try {
      return parseDocument(candidate);
    } catch {
      // 尝试下一个候选（如 tab 展开后的版本）。
    }
  }
  throw new LifecycleError(
    "CONFIG_PARSE_FAILED",
    "config.yaml 无法解析为合法 YAML，已放弃写入以保护原文件。",
  );
}

/** 是否为普通对象（非数组 / 非 null）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验并规范化 MCP spec，非法抛 INVALID_MCP_SERVER。 */
export function normalizeMcpSpec(raw: unknown): McpServerSpec {
  if (!isPlainObject(raw)) {
    throw new LifecycleError("INVALID_MCP_SERVER", "spec 必须是对象。");
  }

  const command =
    typeof raw.command === "string" && raw.command.trim() ? raw.command.trim() : undefined;
  const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : undefined;
  if (!command && !url) {
    throw new LifecycleError(
      "INVALID_MCP_SERVER",
      "spec 需提供 command（stdio）或 url（http）。",
    );
  }
  if (url && !/^https?:\/\//i.test(url)) {
    throw new LifecycleError("INVALID_MCP_SERVER", `url 必须是 http(s)://：${url}`);
  }

  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== "string")) {
      throw new LifecycleError("INVALID_MCP_SERVER", "args 必须是字符串数组。");
    }
    args = raw.args as string[];
  }

  let headers: Record<string, string> | undefined;
  if (raw.headers !== undefined) {
    if (!isPlainObject(raw.headers)) {
      throw new LifecycleError("INVALID_MCP_SERVER", "headers 必须是字符串到字符串的对象。");
    }
    headers = {};
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value !== "string") {
        throw new LifecycleError("INVALID_MCP_SERVER", `headers.${key} 必须是字符串。`);
      }
      headers[key] = value;
    }
  }

  let enabled: boolean | undefined;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      throw new LifecycleError("INVALID_MCP_SERVER", "enabled 必须是布尔值。");
    }
    enabled = raw.enabled;
  }

  const spec: McpServerSpec = {};
  if (command) spec.command = command;
  if (args) spec.args = args;
  if (url) spec.url = url;
  if (headers) spec.headers = headers;
  if (enabled !== undefined) spec.enabled = enabled;
  return spec;
}

/** 解析 `.env` 的键名（只返回键，绝不含值）。 */
export function parseEnvKeys(raw: string): string[] {
  const keys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(ENV_LINE_PATTERN);
    if (match && ENV_KEY_PATTERN.test(match[1])) keys.push(match[1]);
  }
  return keys;
}

/** 编码 `.env` 的值（必要时加双引号并转义）。 */
function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 写入 / 替换一行 `KEY=value`，保留其它行。 */
function upsertEnvLine(raw: string, key: string, value: string): string {
  const base = raw.replace(/\r?\n+$/, "");
  const lines = base.length > 0 ? base.split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    const match = line.match(ENV_LINE_PATTERN);
    if (match && match[1] === key) {
      found = true;
      return `${key}=${encodeEnvValue(value)}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${encodeEnvValue(value)}`);
  return next.join("\n") + "\n";
}

/** 删除某键所在的行，保留其它行。 */
function removeEnvLine(raw: string, key: string): string {
  const base = raw.replace(/\r?\n+$/, "");
  const lines = base.length > 0 ? base.split(/\r?\n/) : [];
  const next = lines.filter((line) => {
    const match = line.match(ENV_LINE_PATTERN);
    return !(match && match[1] === key);
  });
  return next.length > 0 ? next.join("\n") + "\n" : "";
}

/** 读取 meta.json 原始对象（缺失 / 损坏返回空对象）。 */
async function readMetaRaw(id: string, deps: ConfigEditDeps): Promise<Record<string, unknown>> {
  const file = metaPathFor(id, deps);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

/** 读取 agent 的结构化配置（env 只返回键名）。 */
export async function readAgentConfig(
  id: string,
  deps: ConfigEditDeps = {},
): Promise<AgentConfig> {
  const agentId = validateAgentId(id);
  const dir = resolveAgentDir(agentId, deps);

  const configPath = firstExisting(dir, ["config.yaml", "config.yml"]);
  let model: string | null = null;
  let mcpServers: McpServer[] = [];
  if (configPath) {
    const raw = await readFile(configPath, "utf8").catch(() => null);
    if (raw !== null) {
      const config = parseConfigObject(raw);
      model = extractModel(config);
      mcpServers = extractMcpServers(config);
    }
  }

  const meta = await readMetaRaw(agentId, deps);
  const description = typeof meta.description === "string" ? meta.description : "";
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  const envPath = path.join(dir, ".env");
  const envRaw = await readFile(envPath, "utf8").catch(() => "");
  const envKeys = parseEnvKeys(envRaw);

  return {
    id: agentId,
    model,
    description,
    tags,
    mcpServers,
    envKeys,
    configPath,
    envPath,
    metaPath: metaPathFor(agentId, deps),
    source: "profiles",
  };
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 写操作统一要求 confirm:true。 */
function requireConfirm(confirm: unknown): void {
  if (confirm !== true) {
    throw new LifecycleError(
      "CONFIRM_REQUIRED",
      "配置写操作需要显式 confirm:true。",
    );
  }
}

/** 读取 config.yaml 并构造可编辑的 YAML Document。 */
async function loadConfigDocument(
  dir: string,
): Promise<{ doc: Document; file: string }> {
  const file = resolveConfigPath(dir);
  const raw = existsSync(file) ? await readFile(file, "utf8").catch(() => "") : "";
  return { doc: parseYamlDocument(raw), file };
}

/**
 * 更新模型 / 描述 / 标签。
 * - model → config.yaml（若原 `model` 是 mapping 则更新其 `default`，保留其它子字段）；
 * - description / tags → `~/.24os/agents/<id>/meta.json`。
 */
export async function updateAgentConfig(
  id: string,
  patch: UpdateAgentConfigRequest,
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(patch.confirm);
  const agentId = validateAgentId(id);
  const dir = resolveAgentDir(agentId, deps);
  const acc: WriteAcc = { files: [], backups: [] };
  const messages: string[] = [];

  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || patch.model.trim().length === 0) {
      throw new LifecycleError("INVALID_VALUE", "model 必须是非空字符串。");
    }
    const value = patch.model.trim();
    const { doc, file } = await loadConfigDocument(dir);
    const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
    if (isPlainObject(plain.model)) {
      // 保留 model 下的 provider 等其它子字段，只改默认模型。
      doc.setIn(["model", "default"], value);
    } else {
      doc.set("model", value);
    }
    await writeWithBackup(agentId, file, doc.toString(), deps, acc);
    messages.push(`模型已更新为 ${value}`);
  }

  if (patch.description !== undefined || patch.tags !== undefined) {
    if (patch.description !== undefined && typeof patch.description !== "string") {
      throw new LifecycleError("INVALID_VALUE", "description 必须是字符串。");
    }
    if (
      patch.tags !== undefined &&
      (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== "string"))
    ) {
      throw new LifecycleError("INVALID_VALUE", "tags 必须是字符串数组。");
    }
    const meta = await readMetaRaw(agentId, deps);
    if (patch.description !== undefined) meta.description = patch.description;
    if (patch.tags !== undefined) meta.tags = patch.tags;
    const file = metaPathFor(agentId, deps);
    await writeWithBackup(
      agentId,
      file,
      `${JSON.stringify(meta, null, 2)}\n`,
      deps,
      acc,
    );
    messages.push("元数据（描述 / 标签）已更新");
  }

  if (acc.files.length === 0) {
    throw new LifecycleError(
      "INVALID_VALUE",
      "没有可更新的字段（model / description / tags 至少提供一个）。",
    );
  }

  return {
    ok: true,
    action: "update-config",
    files: acc.files,
    backups: acc.backups,
    message: messages.join("；"),
  };
}

/** 新增 MCP server（已存在则报 MCP_SERVER_EXISTS）。 */
export async function addMcpServer(
  id: string,
  input: AddMcpServerRequest,
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(input.confirm);
  const agentId = validateAgentId(id);
  const name = validateMcpName(input.name);
  const spec = normalizeMcpSpec(input.spec);
  const dir = resolveAgentDir(agentId, deps);

  const { doc, file } = await loadConfigDocument(dir);
  const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
  const existing = isPlainObject(plain.mcp_servers) ? plain.mcp_servers : {};
  if (Object.prototype.hasOwnProperty.call(existing, name)) {
    throw new LifecycleError(
      "MCP_SERVER_EXISTS",
      `MCP server「${name}」已存在，请使用更新接口。`,
    );
  }

  doc.setIn(["mcp_servers", name], spec);
  const acc: WriteAcc = { files: [], backups: [] };
  await writeWithBackup(agentId, file, doc.toString(), deps, acc);
  return {
    ok: true,
    action: "add-mcp",
    files: acc.files,
    backups: acc.backups,
    message: `已新增 MCP server「${name}」。`,
  };
}

/** 更新 MCP server（不存在则报 MCP_SERVER_NOT_FOUND）。 */
export async function updateMcpServer(
  id: string,
  name: string,
  input: UpdateMcpServerRequest,
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(input.confirm);
  const agentId = validateAgentId(id);
  const serverName = validateMcpName(name);
  const spec = normalizeMcpSpec(input.spec);
  const dir = resolveAgentDir(agentId, deps);

  const { doc, file } = await loadConfigDocument(dir);
  const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
  const existing = isPlainObject(plain.mcp_servers) ? plain.mcp_servers : {};
  if (!Object.prototype.hasOwnProperty.call(existing, serverName)) {
    throw new LifecycleError(
      "MCP_SERVER_NOT_FOUND",
      `未找到 MCP server「${serverName}」。`,
    );
  }

  doc.setIn(["mcp_servers", serverName], spec);
  const acc: WriteAcc = { files: [], backups: [] };
  await writeWithBackup(agentId, file, doc.toString(), deps, acc);
  return {
    ok: true,
    action: "update-mcp",
    files: acc.files,
    backups: acc.backups,
    message: `已更新 MCP server「${serverName}」。`,
  };
}

/** 删除 MCP server（不存在则报 MCP_SERVER_NOT_FOUND）。 */
export async function removeMcpServer(
  id: string,
  name: string,
  options: { confirm?: boolean } = {},
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(options.confirm);
  const agentId = validateAgentId(id);
  const serverName = validateMcpName(name);
  const dir = resolveAgentDir(agentId, deps);

  const { doc, file } = await loadConfigDocument(dir);
  const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
  const existing = isPlainObject(plain.mcp_servers) ? plain.mcp_servers : {};
  if (!Object.prototype.hasOwnProperty.call(existing, serverName)) {
    throw new LifecycleError(
      "MCP_SERVER_NOT_FOUND",
      `未找到 MCP server「${serverName}」。`,
    );
  }

  doc.deleteIn(["mcp_servers", serverName]);
  const acc: WriteAcc = { files: [], backups: [] };
  await writeWithBackup(agentId, file, doc.toString(), deps, acc);
  return {
    ok: true,
    action: "remove-mcp",
    files: acc.files,
    backups: acc.backups,
    message: `已删除 MCP server「${serverName}」。`,
  };
}

/** 校验环境变量值：拒绝换行 / NUL（会破坏 `.env`）。 */
function validateEnvValue(value: string): void {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new LifecycleError("INVALID_VALUE", "环境变量值不能包含换行或 NUL 字符。");
  }
}

/**
 * 设置环境变量。
 *
 * 优先：若 hermes CLI 可用，执行 `hermes config set <KEY> <value>`（值作为单个
 * 参数，绝不经过 shell）。CLI 不可用或执行失败时，回退为直接编辑 `.env`
 * （保留其它行，已存在则替换，原子写）。
 *
 * 无论走哪条路径，返回的 message 都不含明文值；CLI 命令字符串也不外泄——因为
 * 一旦涉及值，我们只回报「成功 / 失败」，不回显命令。
 */
export async function setEnvVar(
  id: string,
  input: SetEnvRequest,
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(input.confirm);
  const agentId = validateAgentId(id);
  const key = validateEnvKey(input.key);
  if (typeof input.value !== "string") {
    throw new LifecycleError("INVALID_VALUE", "value 必须是字符串。");
  }
  validateEnvValue(input.value);

  const dir = resolveAgentDir(agentId, deps);
  const envPath = path.join(dir, ".env");

  // 写前备份一次（无论最终走 CLI 还是直接编辑）。
  const acc: WriteAcc = { files: [], backups: [] };
  const backup = await backupFile(agentId, envPath, deps);
  if (backup) acc.backups.push(backup);

  // 1) 优先 CLI（值作为单个参数；execFile，无 shell）。
  const cliPath = await resolveHermesCli(deps.cliPath);
  if (cliPath) {
    try {
      const result = await runHermes(["config", "set", key, input.value], {
        cliPath,
        timeoutMs: deps.timeoutMs,
      });
      if (result.ok) {
        return {
          ok: true,
          action: "set-env",
          files: [],
          backups: acc.backups,
          message: `已通过 hermes CLI 设置环境变量 ${key}（值已隐藏）。`,
        };
      }
    } catch {
      // CLI 失败（含白名单/启动错误）→ 静默回退到直接编辑 .env，避免明文外泄。
    }
  }

  // 2) 回退：直接编辑 .env（已在上方备份，这里只做原子写）。
  const raw = await readFile(envPath, "utf8").catch(() => "");
  await atomicWrite(envPath, upsertEnvLine(raw, key, input.value));
  acc.files.push(envPath);
  return {
    ok: true,
    action: "set-env",
    files: acc.files,
    backups: acc.backups,
    message: `已写入 .env 的环境变量 ${key}（值已隐藏）。`,
  };
}

/** 删除环境变量（直接编辑 `.env`）。 */
export async function removeEnvVar(
  id: string,
  key: string,
  options: { confirm?: boolean } = {},
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(options.confirm);
  const agentId = validateAgentId(id);
  const envKey = validateEnvKey(key);
  const dir = resolveAgentDir(agentId, deps);
  const envPath = path.join(dir, ".env");

  const acc: WriteAcc = { files: [], backups: [] };
  const raw = await readFile(envPath, "utf8").catch(() => "");
  await writeWithBackup(agentId, envPath, removeEnvLine(raw, envKey), deps, acc);
  return {
    ok: true,
    action: "remove-env",
    files: acc.files,
    backups: acc.backups,
    message: `已从 .env 删除环境变量 ${envKey}。`,
  };
}

/** 校验备份文件名：必须是裸文件名、.bak 结尾、无路径分隔。 */
function validateBackupName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new LifecycleError("INVALID_VALUE", "backupFileName 不能为空。");
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    name.includes("..")
  ) {
    throw new LifecycleError("PATH_TRAVERSAL", `非法的备份文件名：${name}`);
  }
  if (path.basename(name) !== name || !name.endsWith(".bak")) {
    throw new LifecycleError("PATH_TRAVERSAL", `非法的备份文件名：${name}`);
  }
  return name;
}

/** 由备份文件名解析原始目标文件名，并确保在白名单内。 */
function restoreTargetOf(
  id: string,
  backupFileName: string,
  deps: ConfigEditDeps,
): string {
  const match = /^(.*)\.\d{4}-\d{2}-\d{2}T[0-9TZ-]+\.bak$/.exec(backupFileName);
  const base = match?.[1] ?? "";
  if (!RESTORABLE_FILES.has(base)) {
    throw new LifecycleError(
      "INVALID_VALUE",
      `无法从备份名推断可还原文件：${backupFileName}`,
    );
  }
  if (base === "meta.json") return metaPathFor(id, deps);
  return path.join(resolveAgentDir(id, deps), base);
}

/**
 * 从备份还原（可选能力）。
 * 备份文件必须位于 `~/.24os/backups/<id>/` 内；还原前会先给当前文件再做一次备份。
 */
export async function restoreBackup(
  id: string,
  backupFileName: string,
  options: { confirm?: boolean } = {},
  deps: ConfigEditDeps = {},
): Promise<ConfigEditResult> {
  requireConfirm(options.confirm);
  const agentId = validateAgentId(id);
  const name = validateBackupName(backupFileName);
  const backupDir = path.join(resolveBackupRoot(deps.backupDir), agentId);
  const source = path.join(backupDir, name);
  if (!isWithin(backupDir, source)) {
    throw new LifecycleError("PATH_TRAVERSAL", `拒绝越界备份路径：${source}`);
  }
  if (!existsSync(source)) {
    throw new LifecycleError("BACKUP_NOT_FOUND", `未找到备份文件：${name}`);
  }

  const target = restoreTargetOf(agentId, name, deps);
  const content = await readFile(source, "utf8");
  const acc: WriteAcc = { files: [], backups: [] };
  await writeWithBackup(agentId, target, content, deps, acc);
  return {
    ok: true,
    action: "restore-backup",
    files: acc.files,
    backups: acc.backups,
    message: `已从备份 ${name} 还原 ${path.basename(target)}。`,
  };
}
