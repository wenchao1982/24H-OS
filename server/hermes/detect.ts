import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HermesCliSource, HermesMode, HermesStatus } from "@shared/types";

/**
 * Hermes 探测层（M5.0 增强）。
 *
 * 负责：
 *   - 找到 hermes CLI：OS_HERMES_CLI → PATH(which) → ~/.local/bin/hermes → <home>/bin/hermes；
 *   - 解析 HERMES_HOME：OS_HERMES_HOME → HERMES_HOME → CLI 包装脚本声明的 home → ~/.hermes；
 *   - 探测候选 home：~/.hermes、~/hermes-desktop/home（含 config.yaml / profiles 才算有效）；
 *   - 只做“只读探测”，不修改任何用户文件。
 *
 * M5.x：解析 CLI 包装脚本里的 `HERMES_HOME=`（resolveCliHome），在无显式 env 覆盖时
 * 以其声明目录作为 activeHome，确保 configEdit / profiles 与 CLI 写同一个 home。
 *
 * 可测试性：所有函数接受可选的 DetectOptions（homeDir / env 注入），
 * 测试使用临时目录，绝不触碰真实 ~/.hermes。
 */

const execFileAsync = promisify(execFile);

/** 探测选项（测试注入用；生产环境全部走默认）。 */
export interface DetectOptions {
  /** 覆盖 os.homedir()，用于构造临时 home。 */
  homeDir?: string;
  /** 覆盖 process.env（OS_HERMES_CLI / OS_HERMES_HOME / HERMES_HOME / PATH）。 */
  env?: NodeJS.ProcessEnv;
}

/** 解析生效的 HERMES_HOME（不检查存在性）。 */
export function resolveConfiguredHome(options: DetectOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const fromEnv = env.OS_HERMES_HOME?.trim() || env.HERMES_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(homeDir, ".hermes");
}

/**
 * Hermes 主目录，可通过 OS_HERMES_HOME / HERMES_HOME 覆盖。
 * 注意：这是模块加载时解析的常量，供 profiles/discover 复用；
 * 运行期探测请使用 resolveActiveHome()。默认 ~/.hermes。
 */
export const HERMES_HOME = resolveConfiguredHome();

/** Hermes profiles 目录（一个子目录 = 一个 agent）。 */
export const PROFILES_DIR = path.join(HERMES_HOME, "profiles");

/** 探测结果原始数据。 */
export interface HermesDetection {
  /** 是否找到 hermes 可执行文件（任意来源）。 */
  cliFound: boolean;
  /** hermes --version 输出（首行）。 */
  version: string | null;
  /** hermes 可执行文件绝对路径。 */
  cliPath: string | null;
  /** CLI 来源。 */
  cliSource: HermesCliSource | null;
  /** 生效 home 是否存在。 */
  homeExists: boolean;
  /** 生效 home 下 profiles 目录是否存在。 */
  profilesDirExists: boolean;
  /** 生效 home 下是否存在可解析的配置文件。 */
  homeConfigExists: boolean;
  /** 实际生效的 Hermes 主目录。 */
  activeHome: string;
  /** 探测到的所有有效 Hermes 主目录。 */
  hermesHomes: string[];
}

/** CLI 解析结果。 */
export interface ResolvedCli {
  cliPath: string | null;
  cliSource: HermesCliSource | null;
}

/** config 候选文件名。 */
const CONFIG_FILES = ["config.yaml", "config.yml", "config.json"] as const;

function hasConfigFile(dir: string): boolean {
  return CONFIG_FILES.some((file) => existsSync(path.join(dir, file)));
}

/** 目录是否为“有效”的 Hermes home（含配置或 profiles）。 */
export function isValidHermesHome(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (hasConfigFile(dir)) return true;
  return existsSync(path.join(dir, "profiles"));
}

/** 列出所有有效的 Hermes home（去重，保持优先级顺序）。 */
export function listHermesHomes(options: DetectOptions = {}): string[] {
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = [
    resolveConfiguredHome(options),
    path.join(homeDir, ".hermes"),
    path.join(homeDir, "hermes-desktop", "home"),
  ];
  const seen = new Set<string>();
  const homes: string[] = [];
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (isValidHermesHome(abs)) homes.push(abs);
  }
  return homes;
}

/** 生效的 home：优先 env 指定的 home（存在时），否则第一个有效候选。 */
export function resolveActiveHome(options: DetectOptions = {}): string {
  const configured = resolveConfiguredHome(options);
  if (existsSync(configured)) return configured;
  return listHermesHomes(options)[0] ?? configured;
}

/**
 * which <bin> 的纯 JS 实现（不 spawn 外部 which，便于注入 PATH 测试）。
 * 按 PATH 顺序返回第一个可执行的绝对路径，失败返回 null。
 */
function which(bin: string, env?: NodeJS.ProcessEnv): string | null {
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // 不可执行 / 不存在，继续下一个。
    }
  }
  return null;
}

/**
 * 解析 hermes CLI 路径（同步版，供 configEdit / profiles 复用）。
 * 优先级：OS_HERMES_CLI（显式路径，存在才算）→ PATH(which) → ~/.local/bin/hermes → <home>/bin/hermes。
 */
export function resolveCliPathSync(options: DetectOptions = {}): ResolvedCli {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  const fromEnv = env.OS_HERMES_CLI?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return { cliPath: path.resolve(fromEnv), cliSource: "env" };
  }

  const onPath = which("hermes", env);
  if (onPath) {
    return { cliPath: onPath, cliSource: "path" };
  }

  const localBin = path.join(homeDir, ".local", "bin", "hermes");
  if (existsSync(localBin)) {
    return { cliPath: localBin, cliSource: "local-bin" };
  }

  const hermesBin = path.join(resolveConfiguredHome(options), "bin", "hermes");
  if (existsSync(hermesBin)) {
    return { cliPath: hermesBin, cliSource: "hermes-bin" };
  }

  return { cliPath: null, cliSource: null };
}

/** 解析 hermes CLI 路径（异步包装，保持既有 API）。 */
export async function resolveCliPath(
  options: DetectOptions = {},
): Promise<ResolvedCli> {
  return resolveCliPathSync(options);
}

/** 包装脚本最大读取字节数（超过则视为非脚本）。 */
const MAX_CLI_SCRIPT_BYTES = 64 * 1024;

/**
 * 从一行 `HERMES_HOME=...` 赋值中提取可解析的路径字面量。
 * 支持 `export`、单/双引号、`${HERMES_HOME:-/default}` 默认值、行尾注释。
 * 无法解析（自引用 `$HERMES_HOME`、变量插值等）返回 null。
 */
function extractHomeLiteral(rawValue: string): string | null {
  let value = rawValue.trim();
  // 去掉未加引号值的行尾注释（` # ...`）。
  if (!/^["']/.test(value)) {
    const hash = value.search(/\s#/);
    if (hash >= 0) value = value.slice(0, hash).trim();
  }
  // 整段被引号包裹 → 去掉引号。
  const stripQuotes = (text: string): string => {
    const quote = text[0];
    if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
      return text.slice(1, -1);
    }
    return text;
  };
  value = stripQuotes(value);
  // `${HERMES_HOME:-/default}` / `${HERMES_HOME-/default}` → 取默认值。
  const fallback = /\$\{HERMES_HOME:?-([^}]*)\}/.exec(value);
  if (fallback) value = stripQuotes(fallback[1].trim());
  value = value.trim();
  if (!value || value.includes("$")) return null;
  return value;
}

/**
 * 解析 hermes CLI 包装脚本声明的 HERMES_HOME（M5.x）。
 *
 * 本机 CLI（`~/.local/bin/hermes`）是包装脚本，内部 `export HERMES_HOME=<path>`
 * 指向真实数据目录；而探测默认可能选 `~/.hermes`（Studio 部署）。若 CLI 写 A、
 * 文件回退写 B 会造成不一致——因此这里提取脚本里的 home。
 *
 * - 仅接受**文本脚本**（普通文件、非二进制、字节数有限）；
 * - 提取首个可解析的 `HERMES_HOME=...` 赋值，展开前导 `~`，相对路径按 homeDir 解析；
 * - 无法确定返回 null（调用方回退到既有的 home 探测）。
 */
export function resolveCliHome(
  cliPath: string,
  options: DetectOptions = {},
): string | null {
  const homeDir = options.homeDir ?? os.homedir();
  try {
    const stat = statSync(cliPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CLI_SCRIPT_BYTES) return null;
  } catch {
    return null;
  }

  let text: string;
  try {
    text = readFileSync(cliPath, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\0")) return null; // 二进制文件。

  for (const rawLine of text.split(/\r?\n/)) {
    const match = /(?:^|\s)HERMES_HOME\s*=\s*(.+)$/.exec(rawLine.trim());
    if (!match) continue;
    const literal = extractHomeLiteral(match[1]);
    if (!literal) continue;
    if (literal === "~") return homeDir;
    if (literal.startsWith("~/")) return path.join(homeDir, literal.slice(2));
    return path.isAbsolute(literal) ? path.resolve(literal) : path.resolve(homeDir, literal);
  }
  return null;
}

/**
 * 由显式/自动探测的 CLI 路径解析其声明的 home。
 * cliPath：
 *   - undefined → 同步自动探测 CLI；
 *   - null → 视为不可用；
 *   - 字符串 → 直接使用。
 */
export function resolveHomeForCli(
  cliPath: string | null | undefined,
  options: DetectOptions = {},
): string | null {
  const resolved = cliPath === undefined ? resolveCliPathSync(options).cliPath : cliPath;
  if (!resolved) return null;
  return resolveCliHome(resolved, options);
}

/** 判断 env 是否显式指定了 HERMES_HOME。 */
function hasExplicitHome(options: DetectOptions): boolean {
  const env = options.env ?? process.env;
  return Boolean(env.OS_HERMES_HOME?.trim() || env.HERMES_HOME?.trim());
}

/** 读取 <cliPath> --version，失败返回 null。 */
async function readVersion(cliPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cliPath, ["--version"], {
      timeout: 4000,
      shell: false,
    });
    const firstLine = stdout.trim().split(/\r?\n/)[0] ?? "";
    return firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

/** 执行一次完整探测。 */
export async function detectHermes(
  options: DetectOptions = {},
): Promise<HermesDetection> {
  const { cliPath, cliSource } = await resolveCliPath(options);
  const version = cliPath ? await readVersion(cliPath) : null;

  // M5.x：CLI 包装脚本声明的 HERMES_HOME 是权威数据目录，优先作为 activeHome，
  // 保证 configEdit / profiles 与 CLI 写的是同一个 home（显式 env 覆盖仍优先）。
  const cliHome = cliPath ? resolveCliHome(cliPath, options) : null;
  let activeHome: string;
  if (hasExplicitHome(options)) activeHome = resolveConfiguredHome(options);
  else if (cliHome) activeHome = cliHome;
  else activeHome = resolveActiveHome(options);

  const listedHomes = listHermesHomes(options);
  const hermesHomes =
    cliHome && existsSync(cliHome) && !listedHomes.includes(cliHome)
      ? [cliHome, ...listedHomes]
      : listedHomes;
  const homeExists = existsSync(activeHome);
  const profilesDirExists = existsSync(path.join(activeHome, "profiles"));
  const homeConfigExists = hasConfigFile(activeHome);

  return {
    cliFound: Boolean(cliPath),
    version,
    cliPath,
    cliSource,
    homeExists,
    profilesDirExists,
    homeConfigExists,
    activeHome,
    hermesHomes,
  };
}

/**
 * 决定运行模式：
 * - live：找到 CLI，或探测到任一有效 Hermes home（有配置 / profiles）。
 * - mock：两者皆无（全新的机器 / 未安装 Hermes）。
 */
export function decideMode(det: HermesDetection): HermesMode {
  if (det.cliFound) return "live";
  if (det.hermesHomes.length > 0) return "live";
  if (det.profilesDirExists) return "live";
  if (det.homeExists && det.homeConfigExists) return "live";
  return "mock";
}

/** 把探测结果 + 模式 + agent 数量组装成前端需要的状态对象。 */
export function buildStatus(
  det: HermesDetection,
  mode: HermesMode,
  profileCount: number,
): HermesStatus {
  const available = mode === "live";

  let message: string;
  if (mode === "live") {
    const cliNote = det.cliFound
      ? `CLI 已安装${det.version ? `（${det.version}）` : ""}${det.cliSource ? ` [${det.cliSource}]` : ""}`
      : "未找到 CLI，但检测到 Hermes 数据目录";
    const homeNote =
      det.homeExists ? det.activeHome : (det.hermesHomes[0] ?? `未找到（预期 ${det.activeHome}）`);
    message = `已连接 Hermes：${cliNote}，主目录 ${homeNote}，加载 ${profileCount} 个 profile。`;
  } else if (det.cliFound) {
    message = "已安装 Hermes CLI，但未发现任何 profile，当前展示 mock 示例数据。";
  } else {
    message = "未检测到 Hermes CLI 或 ~/.hermes 目录，当前展示 mock 示例数据。";
  }

  return {
    available,
    mode,
    version: det.version,
    cliPath: det.cliPath,
    cliSource: det.cliSource,
    homePath: det.homeExists ? det.activeHome : null,
    activeHome: det.activeHome,
    hermesHomes: det.hermesHomes,
    profileCount,
    message,
  };
}
