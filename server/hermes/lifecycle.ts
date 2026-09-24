import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DeleteAgentRequest,
  InstallAgentRequest,
  LifecycleAction,
  LifecycleResult,
  UpdateAgentRequest,
} from "@shared/types";
import { resolveHermesCli, runHermes, type HermesCommandResult } from "./cli";
import { LifecycleError } from "./errors";

/**
 * Agent 生命周期层（M2-core）。
 *
 * 复用 Hermes 原生能力：
 *   hermes profile install <git-url|local-dir> [--name N] [--alias]
 *   hermes profile update <name>
 *   hermes profile delete <name>
 *   hermes profile export <name> -o <tar.gz>   （删除前备份）
 *
 * 安全约束：
 *   - source 必须是 http(s):// / git@ / ssh:// URL，或**确实存在的本地目录**；
 *   - name / id 必须匹配 ^[a-z0-9][a-z0-9_-]{0,63}$；
 *   - 破坏性操作必须显式 confirm:true（dryRun 预览除外）；
 *   - delete 默认先 export 备份，备份失败则中止删除。
 *
 * 可测试性：所有函数支持注入 cliPath / backupDir / timeoutMs。
 */

/** 生命周期依赖注入。 */
export interface LifecycleDeps {
  /** 显式 CLI 路径（null = 不可用）；不传则自动探测。 */
  cliPath?: string | null;
  /** 备份目录，默认 ~/.24os/backups（可用 OS_BACKUP_DIR 覆盖）。 */
  backupDir?: string;
  /** 单条命令超时（毫秒）。 */
  timeoutMs?: number;
}

/** 名称 / id 合法格式。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 默认备份目录。 */
function defaultBackupDir(): string {
  return (
    process.env.OS_BACKUP_DIR ?? path.join(os.homedir(), ".24os", "backups")
  );
}

/** 由 id + 当前时间戳生成备份路径。 */
export function buildBackupPath(id: string, backupDir?: string): string {
  const base = backupDir ?? defaultBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(base, `${id}-${stamp}.tar.gz`);
}

/** 校验 profile 名 / id，非法抛 INVALID_NAME。 */
export function validateName(name: unknown, label = "name"): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new LifecycleError(
      "INVALID_NAME",
      `非法的 ${label}：${String(name)}（要求匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }
  return name;
}

/** 校验 source，非法抛 INVALID_SOURCE；返回原始 source。 */
export function validateSource(source: unknown): string {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new LifecycleError("INVALID_SOURCE", "source 不能为空。");
  }
  const value = source.trim();

  // git@host:path 形式。
  if (/^git@[^:\s]+:[^\s]+$/.test(value)) return value;

  // http(s):// 或 ssh:// URL。
  if (/^(https?|ssh):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ssh:") {
        return value;
      }
    } catch {
      // fallthrough → 报错
    }
    throw new LifecycleError("INVALID_SOURCE", `非法的 URL：${value}`);
  }

  // 本地目录（必须真实存在且为目录）。
  try {
    if (existsSync(value) && statSync(value).isDirectory()) return value;
  } catch {
    // fallthrough → 报错
  }

  throw new LifecycleError(
    "INVALID_SOURCE",
    `非法的 source：${value}（需为 http(s)://、git@、ssh:// 或已存在的本地目录）`,
  );
}

/** 组装 runHermes 选项。 */
function runOptions(deps: LifecycleDeps, dryRun?: boolean) {
  return {
    cliPath: deps.cliPath,
    timeoutMs: deps.timeoutMs,
    dryRun,
  };
}

/** 把 HermesCommandResult 规范化为 LifecycleResult（命令失败抛 COMMAND_FAILED）。 */
function toLifecycleResult(
  action: LifecycleAction,
  result: HermesCommandResult,
  dryRun?: boolean,
  backupPath?: string,
): LifecycleResult {
  if (!result.ok && !result.dryRun) {
    const detail = (result.stderr || result.stdout).trim();
    throw new LifecycleError(
      "COMMAND_FAILED",
      `${action} 失败（exit ${result.code ?? "?"}）：${detail || result.command}`,
    );
  }
  return {
    ok: true,
    action,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    ...(dryRun ? { dryRun: true } : {}),
    ...(backupPath ? { backupPath } : {}),
  };
}

/** 安装 agent。 */
export async function installAgent(
  input: InstallAgentRequest,
  deps: LifecycleDeps = {},
): Promise<LifecycleResult> {
  if (!input.dryRun && input.confirm !== true) {
    throw new LifecycleError("CONFIRM_REQUIRED", "安装需要显式 confirm:true。");
  }
  const source = validateSource(input.source);
  const name = input.name === undefined ? undefined : validateName(input.name);

  const args = ["profile", "install", source];
  if (name) args.push("--name", name);
  if (input.alias) args.push("--alias");

  const result = await runHermes(args, runOptions(deps, input.dryRun));
  return toLifecycleResult("install", result, input.dryRun);
}

/** 更新 agent。 */
export async function updateAgent(
  id: string,
  input: UpdateAgentRequest,
  deps: LifecycleDeps = {},
): Promise<LifecycleResult> {
  const agentId = validateName(id, "id");
  if (!input.dryRun && input.confirm !== true) {
    throw new LifecycleError("CONFIRM_REQUIRED", "更新需要显式 confirm:true。");
  }

  const result = await runHermes(
    ["profile", "update", agentId],
    runOptions(deps, input.dryRun),
  );
  return toLifecycleResult("update", result, input.dryRun);
}

/** 导出（备份）agent profile 为 tar.gz。 */
export async function backupAgent(
  id: string,
  deps: LifecycleDeps & { dryRun?: boolean } = {},
): Promise<LifecycleResult> {
  const agentId = validateName(id, "id");
  const backupPath = buildBackupPath(agentId, deps.backupDir);

  if (!deps.dryRun) {
    // 先确认 CLI 可用，再创建目录，避免留下无意义的空目录。
    const cliPath = await resolveHermesCli(deps.cliPath);
    if (!cliPath) {
      throw new LifecycleError(
        "HERMES_CLI_UNAVAILABLE",
        "未检测到可用的 hermes CLI，无法执行生命周期操作。",
      );
    }
    await mkdir(path.dirname(backupPath), { recursive: true });
  }

  const result = await runHermes(
    ["profile", "export", agentId, "-o", backupPath],
    runOptions(deps, deps.dryRun),
  );

  if (!deps.dryRun && !existsSync(backupPath)) {
    throw new LifecycleError(
      "COMMAND_FAILED",
      `备份命令已执行但未生成文件：${backupPath}`,
    );
  }

  return toLifecycleResult("backup", result, deps.dryRun, backupPath);
}

/** 删除 agent（默认先备份，备份失败则中止）。 */
export async function deleteAgent(
  id: string,
  input: DeleteAgentRequest,
  deps: LifecycleDeps = {},
): Promise<LifecycleResult> {
  const agentId = validateName(id, "id");
  if (!input.dryRun && input.confirm !== true) {
    throw new LifecycleError("CONFIRM_REQUIRED", "删除需要显式 confirm:true。");
  }

  const shouldBackup = input.backup !== false;

  // 非 dryRun 时必须先确认 CLI 可用；dryRun 预览允许无 CLI（用占位命令名）。
  if (!input.dryRun) {
    const cliPath = await resolveHermesCli(deps.cliPath);
    if (!cliPath) {
      throw new LifecycleError(
        "HERMES_CLI_UNAVAILABLE",
        "未检测到可用的 hermes CLI，无法执行生命周期操作。",
      );
    }
  }

  const backupPath = shouldBackup
    ? buildBackupPath(agentId, deps.backupDir)
    : undefined;

  if (input.dryRun) {
    const commands: string[] = [];
    if (shouldBackup && backupPath) {
      const preview = await runHermes(
        ["profile", "export", agentId, "-o", backupPath],
        runOptions(deps, true),
      );
      commands.push(preview.command);
    }
    const preview = await runHermes(
      ["profile", "delete", agentId],
      runOptions(deps, true),
    );
    commands.push(preview.command);
    return {
      ok: true,
      action: "delete",
      command: commands.join(" && "),
      stdout: "",
      stderr: "",
      code: null,
      dryRun: true,
      ...(backupPath ? { backupPath } : {}),
    };
  }

  // 使用 backupAgent 实际生成的路径，避免与上面预览用路径的时间戳相差 1ms 导致不一致。
  let actualBackupPath: string | undefined;
  if (shouldBackup) {
    // 备份失败会抛错并中止删除。
    const backup = await backupAgent(agentId, deps);
    actualBackupPath = backup.backupPath;
  }

  const result = await runHermes(["profile", "delete", agentId], runOptions(deps));
  return toLifecycleResult("delete", result, false, actualBackupPath);
}
