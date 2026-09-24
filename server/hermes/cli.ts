import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { detectHermes } from "./detect";
import { LifecycleError, lifecycleError } from "./errors";

/**
 * Hermes CLI 安全执行层。
 *
 * 设计要点：
 *   - 一律使用 child_process.spawn 且 **绝不 shell:true**：参数以数组形式直接交给
 *     可执行文件，用户输入永远不会被 shell 解释，从根上避免命令注入。
 *   - 子命令白名单：只放行 `hermes profile <list|show|install|update|delete|info|export|import>`
 *     与 `--version` / `--help`，其余一律拒绝（COMMAND_NOT_ALLOWED）。
 *   - 带超时，捕获 stdout/stderr/exitCode，统一返回结构化结果。
 *   - dryRun 只返回将执行的命令，不触碰进程。
 */

/** 允许的 `profile` 子命令。 */
export const ALLOWED_PROFILE_SUBCOMMANDS: readonly string[] = [
  "list",
  "show",
  "install",
  "update",
  "delete",
  "info",
  "export",
  "import",
];

const ALLOWED_PROFILE_SET = new Set(ALLOWED_PROFILE_SUBCOMMANDS);

/** 单个参数长度上限，防御异常输入。 */
const MAX_ARG_LENGTH = 4096;

/** 默认超时：60s。 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** runHermes 的选项。 */
export interface RunHermesOptions {
  /** 超时（毫秒），默认 60000。 */
  timeoutMs?: number;
  /** 只返回命令，不执行。 */
  dryRun?: boolean;
  /** 工作目录。 */
  cwd?: string;
  /** 追加/覆盖环境变量。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 显式指定 CLI 路径：
   *   - undefined：走 resolveHermesCli() 自动探测；
   *   - null：视为不可用；
   *   - 字符串：直接使用（测试注入）。
   */
  cliPath?: string | null;
}

/** runHermes 的结构化返回。 */
export interface HermesCommandResult {
  ok: boolean;
  /** 进程退出码；dryRun 或未执行时为 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 可读命令字符串（已做安全引号转义）。 */
  command: string;
  /** 是否 dryRun。 */
  dryRun?: boolean;
}

/**
 * 解析 Hermes CLI 路径。
 * 优先级：显式注入 > OS_HERMES_CLI 环境变量 > detect.ts 探测结果。
 * 返回 null 表示不可用。
 */
export async function resolveHermesCli(
  explicit?: string | null,
): Promise<string | null> {
  if (explicit !== undefined) {
    return explicit && explicit.trim() ? explicit : null;
  }
  const fromEnv = process.env.OS_HERMES_CLI?.trim();
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : null;
  }
  const detection = await detectHermes();
  return detection.cliPath;
}

/**
 * 允许的 `config` 子命令（M3 环境变量写入用；值始终作为单个参数传递）。
 */
export const ALLOWED_CONFIG_SUBCOMMANDS: readonly string[] = [
  "set",
  "get",
  "list",
  "unset",
];

const ALLOWED_CONFIG_SET = new Set(ALLOWED_CONFIG_SUBCOMMANDS);

/**
 * 校验参数是否命中白名单。
 * 仅允许：
 *   - ["--version"] / ["--help"]
 *   - ["profile", <allowed>, ...safeArgs]
 *   - ["config", set, KEY, VALUE] / ["config", get|list|unset, ...safeArgs]
 * 其余（包括其他顶层命令、其他 profile/config 子命令）一律拒绝。
 */
export function isAllowedCommand(args: readonly string[]): boolean {
  if (args.length === 0) return false;

  // 每个参数都必须是安全字符串（无 NUL，长度合理）。
  for (const arg of args) {
    if (typeof arg !== "string") return false;
    if (arg.includes("\0")) return false;
    if (arg.length > MAX_ARG_LENGTH) return false;
  }

  const [first, second] = args;

  if (first === "--version" || first === "--help") {
    return args.length === 1;
  }

  if (first === "config") {
    if (second === undefined) return false;
    if (second === "--help") return true;
    if (!ALLOWED_CONFIG_SET.has(second)) return false;
    // `config set KEY VALUE`：恰好 4 个参数，值作为**单个**参数。
    if (second === "set") return args.length === 4;
    return true;
  }

  if (first !== "profile") return false;
  if (second === undefined) return false;
  if (second === "--help") return true;

  return ALLOWED_PROFILE_SET.has(second);
}

/** 把命令数组转成可读字符串（安全引号转义，便于展示给用户确认）。 */
export function formatCommand(cliPath: string, args: readonly string[]): string {
  const parts = [cliPath, ...args].map((part) =>
    /^[A-Za-z0-9_./:@=+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`,
  );
  return parts.join(" ");
}

/**
 * 执行一次 hermes 命令。
 * 参数白名单不通过 → 抛 COMMAND_NOT_ALLOWED；
 * CLI 不可用 → 抛 HERMES_CLI_UNAVAILABLE。
 */
export async function runHermes(
  args: string[],
  options: RunHermesOptions = {},
): Promise<HermesCommandResult> {
  if (!isAllowedCommand(args)) {
    throw lifecycleError(
      "COMMAND_NOT_ALLOWED",
      `命令未在白名单中：hermes ${args.join(" ")}（仅允许 profile 下的 ${ALLOWED_PROFILE_SUBCOMMANDS.join("/")} 与 --version/--help）`,
    );
  }

  const cliPath = await resolveHermesCli(options.cliPath);
  // dryRun 仅做预览：即使 CLI 不可用，也用占位可执行名展示将执行的命令。
  if (!cliPath && !options.dryRun) {
    throw lifecycleError(
      "HERMES_CLI_UNAVAILABLE",
      "未检测到可用的 hermes CLI，无法执行生命周期操作。",
    );
  }

  const command = formatCommand(cliPath ?? "hermes", args);

  if (options.dryRun) {
    return { ok: true, code: null, stdout: "", stderr: "", command, dryRun: true };
  }

  // 此处 cliPath 必非 null（上面已对非 dryRun 校验）。
  const executable = cliPath as string;

  return await new Promise<HermesCommandResult>((resolve, reject) => {
    let settled = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new LifecycleError(
          "COMMAND_FAILED",
          `无法启动 hermes 进程：${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      if (timedOut) {
        reject(
          new LifecycleError(
            "COMMAND_FAILED",
            `hermes 命令超时（>${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）：${command}`,
          ),
        );
        return;
      }
      resolve({ ok: code === 0, code, stdout, stderr, command });
    });
  });
}
