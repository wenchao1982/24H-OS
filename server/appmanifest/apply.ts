import { cp, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AppApplyMode,
  AppApplyResult,
  AppHookName,
  AppManifest,
  InstalledAppRecord,
  McpServerSpec,
} from "@shared/types";
import { readMarket } from "../market";
import { APP_ROOT } from "../paths";
import {
  addMcpServer,
  readAgentConfig,
  resolveAgentDir,
  resolveHermesHome,
  setEnvVar,
  updateAgentConfig,
  updateMcpServer,
} from "../hermes/configEdit";
import { LifecycleError } from "../hermes/errors";
import { invalidateAgentsCache } from "../hermes/index";
import {
  backupAgent,
  deleteAgent,
  installAgent,
} from "../hermes/lifecycle";
import { runHermes } from "../hermes/cli";
import { appEventType, emitAppEvent } from "./events";
import {
  resolveAppSourceDir,
  validateAppManifest,
} from "./manifest";
import { verifySign } from "./sign";
import {
  readInstalledApp,
  removeInstalledApp,
  sanitizeManifestForStore,
  writeInstalledApp,
} from "./store";

/**
 * AppManifest 安装编排（M6）。
 *
 * 复用已有实现，不重造：
 *   - profile 生命周期 → `lifecycle.install/update/delete/backup`（官方 distribution 思路）；
 *   - model/mcp/env 写入 → `configEdit`（官方命令优先，via: cli|file）；
 *   - 签名 → `sign.ts`；记录 → `store.ts`；事件 → `events.ts`。
 *
 * 安全门禁（所有 mode 共同）：
 *   1. 第一步 `confirm:true`，否则 CONFIRM_REQUIRED（不碰磁盘）；
 *   2. update/uninstall 先备份 profile 到 `~/.24os/backups`；
 *   3. `apps/<id>.json` 原子写且**最后一步**才写（中途失败不破坏已有安装）；
 *   4. store 中 env 明文脱敏为 "***"，响应 message 不含密钥。
 *
 * 可测试性：deps 注入 hermesHome / cliPath / backupDir / appsDir / metaDir，
 * 测试用临时目录 + 假 CLI，绝不触碰真实 `~/.hermes`。
 */

/** 仓库根目录（统一由 server/paths.ts 解析，兼容源码 / 打包形态）。 */
const REPO_ROOT = APP_ROOT;

export interface ApplyAppDeps {
  /** Hermes 主目录（默认 env / detect）。 */
  hermesHome?: string;
  /** 显式 CLI 路径（null=不可用）。 */
  cliPath?: string | null;
  /** 备份根目录。 */
  backupDir?: string;
  /** 安装记录根目录。 */
  appsDir?: string;
  /** 工作台 meta 根目录。 */
  metaDir?: string;
  /** builtin 相对路径的解析根（默认仓库根）。 */
  repoRoot?: string;
  /** CLI 超时。 */
  timeoutMs?: number;
}

function requireConfirm(confirm: unknown): void {
  if (confirm !== true) {
    throw new LifecycleError(
      "CONFIRM_REQUIRED",
      "App 编排操作需要显式 confirm:true。",
    );
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** profile 目录是否存在（id=default 时也认 home 本身）。 */
function profileExists(id: string, deps: ApplyAppDeps): boolean {
  try {
    resolveAgentDir(id, {
      hermesHome: deps.hermesHome,
      cliPath: deps.cliPath,
    });
    return true;
  } catch {
    return false;
  }
}

/** 模板 profile 目录（仅 `profiles/<template>`，绝不把整个 home 当模板）。 */
function templateDirOf(
  template: string | undefined,
  deps: ApplyAppDeps,
): string | null {
  if (!template) return null;
  const home = resolveHermesHome(deps.hermesHome, deps.cliPath);
  const dir = path.join(home, "profiles", template);
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  } catch {
    // ignore
  }
  return null;
}

/** 确保 profile 目录存在（install 后 / 模板 / 空 profile 兜底）。 */
async function ensureProfileDir(
  id: string,
  manifest: AppManifest,
  deps: ApplyAppDeps,
  steps: string[],
): Promise<void> {
  if (profileExists(id, deps)) return;

  const template = templateDirOf(manifest.profile?.template, deps);
  const home = resolveHermesHome(deps.hermesHome, deps.cliPath);
  const target =
    id === "default" ? home : path.join(home, "profiles", id);

  if (template) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(template, target, { recursive: true });
    steps.push(`已从模板 ${path.basename(template)} 创建 profile`);
    return;
  }

  await mkdir(target, { recursive: true });
  steps.push("已创建空 profile 目录");
}

/**
 * 把 profile.skills 复制到 `<activeHome>/skills/<name>`。
 * 候选顺序：
 *   1) `<sourceRoot>/skills/<name>`（distribution 布局）
 *   2) `<sourceRoot>/<name>`（仓库 examples 布局）
 *   3) `<sourceRoot>` 本身是 skill 根（含 SKILL.md，且 basename === name 或仅声明一个 skill）
 * 目标必须在 `<activeHome>/skills` 内（防穿越）；源必须在 sourceRoot 内。
 */
async function copySkills(
  manifest: AppManifest,
  deps: ApplyAppDeps,
  steps: string[],
): Promise<void> {
  const declaredSkills = manifest.profile?.skills ?? [];
  if (declaredSkills.length === 0) return;

  const sourceRoot = resolveAppSourceDir(manifest, deps.repoRoot ?? REPO_ROOT);
  if (!sourceRoot || !existsSync(sourceRoot)) return;

  const home = resolveHermesHome(deps.hermesHome, deps.cliPath);
  const skillsRoot = path.join(home, "skills");
  await mkdir(skillsRoot, { recursive: true });

  const sourceAbs = path.resolve(sourceRoot);
  for (const name of declaredSkills) {
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new LifecycleError("PATH_TRAVERSAL", `非法的 skill 名：${name}`);
    }

    const candidates = [
      path.join(sourceAbs, "skills", name),
      path.join(sourceAbs, name),
      sourceAbs,
    ];

    let chosen: string | null = null;
    for (const candidate of candidates) {
      const abs = path.resolve(candidate);
      const rel = path.relative(sourceAbs, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (!existsSync(abs)) continue;
      if (candidate === sourceAbs) {
        // 源即 skill 根：需含 SKILL.md，且 basename 匹配或为唯一 skill。
        const base = path.basename(sourceAbs);
        const single = declaredSkills.length === 1;
        if (!existsSync(path.join(abs, "SKILL.md"))) continue;
        if (base !== name && !single) continue;
      }
      chosen = abs;
      break;
    }
    if (!chosen) continue;

    const dest = path.resolve(skillsRoot, name);
    const destRel = path.relative(skillsRoot, dest);
    if (destRel.startsWith("..") || path.isAbsolute(destRel)) {
      throw new LifecycleError("PATH_TRAVERSAL", `拒绝越界 skills 目标：${dest}`);
    }

    await mkdir(path.dirname(dest), { recursive: true });
    await cp(chosen, dest, { recursive: true, force: true });
    steps.push(`已复制 skill「${name}」→ ${dest}`);
  }
}

/** 写 model / mcp / env（configEdit 官方命令优先）；返回实际通道聚合。 */
async function applyProfileConfig(
  id: string,
  manifest: AppManifest,
  deps: ApplyAppDeps,
  steps: string[],
): Promise<"cli" | "rpc" | "file" | "none"> {
  const profile = manifest.profile;
  if (!profile) return "none";

  const configDeps = {
    hermesHome: deps.hermesHome,
    backupDir: deps.backupDir,
    metaDir: deps.metaDir,
    cliPath: deps.cliPath,
    timeoutMs: deps.timeoutMs,
  };

  let via: "cli" | "rpc" | "file" | "none" = "none";

  if (profile.model?.default) {
    const result = await updateAgentConfig(
      id,
      { model: profile.model.default, confirm: true },
      configDeps,
    );
    via = result.via;
    steps.push(`模型 → ${profile.model.default}（via ${result.via}）`);
  }

  if (profile.mcp && profile.mcp.length > 0) {
    let existingNames = new Set<string>();
    try {
      const cfg = await readAgentConfig(id, configDeps);
      existingNames = new Set(cfg.mcpServers.map((item) => item.name));
    } catch {
      // 读不到则按新增处理。
    }

    for (const server of profile.mcp) {
      const spec = server.config as McpServerSpec;
      const result = existingNames.has(server.name)
        ? await updateMcpServer(id, server.name, { spec, confirm: true }, configDeps)
        : await addMcpServer(id, { name: server.name, spec, confirm: true }, configDeps);
      via = result.via;
      steps.push(
        existingNames.has(server.name)
          ? `MCP 已更新：${server.name}`
          : `MCP 已新增：${server.name}`,
      );
    }
  }

  if (profile.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      const result = await setEnvVar(id, { key, value, confirm: true }, configDeps);
      via = result.via;
      // 绝不回显明文。
      steps.push(`env 已写入：${key}`);
    }
  }

  return via;
}

/**
 * M7 hooks：重新把该 app 的 profile 段（model/mcp/env）经 configEdit 落盘。
 * 官方命令优先（via: cli|file）。
 */
export async function reapplyProfileConfig(
  id: string,
  manifest: AppManifest,
  deps: ApplyAppDeps = {},
): Promise<"cli" | "rpc" | "file" | "none"> {
  const steps: string[] = [];
  return applyProfileConfig(id, manifest, deps, steps);
}

/** install 的主体（不含 confirm / 记录写入 / emit）。 */
async function runInstallSteps(
  id: string,
  manifest: AppManifest,
  deps: ApplyAppDeps,
  steps: string[],
): Promise<{ backupPath?: string }> {
  const market = readMarket();
  const marketEntry = market.entries.find((entry) => entry.id === id);

  // ① profile 不存在 → lifecycle.install（market 优先，否则本地 path）。
  if (!profileExists(id, deps)) {
    const sourceDir = resolveAppSourceDir(manifest, deps.repoRoot ?? REPO_ROOT);
    const source = marketEntry?.source ?? sourceDir ?? undefined;

    if (source) {
      const result = await installAgent(
        { source, name: id, confirm: true },
        {
          cliPath: deps.cliPath,
          backupDir: deps.backupDir,
          timeoutMs: deps.timeoutMs,
        },
      );
      steps.push(`profile install：${result.command}`);
    }
  }

  // 兜底：CLI 未真正落盘（如假 CLI）或无 source → 模板 / 空目录。
  await ensureProfileDir(id, manifest, deps, steps);

  await applyProfileConfig(id, manifest, deps, steps);

  // ④ skills 复制（防穿越）。
  await copySkills(manifest, deps, steps);

  return {};
}

/** 构造安装记录（env 已脱敏）。 */
function buildRecord(
  manifest: AppManifest,
  history: InstalledAppRecord["history"],
  backupPath: string | undefined,
  existing: InstalledAppRecord | null,
  mode: AppApplyMode,
): InstalledAppRecord {
  const at = nowIso();
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    installedAt: existing?.installedAt ?? at,
    ...(mode === "update" || mode === "rollback" ? { updatedAt: at } : {}),
    ...(backupPath ? { backupPath } : existing?.backupPath
      ? { backupPath: existing.backupPath }
      : {}),
    manifest: sanitizeManifestForStore(manifest),
    ...(history && history.length > 0 ? { history } : {}),
  };
}

/**
 * 执行 App 编排。
 * mode 必须与调用方路由一致；manifest 必须已通过 validateAppManifest。
 */
export async function applyAppManifest(
  manifestInput: AppManifest,
  options: { mode: AppApplyMode; confirm?: boolean },
  deps: ApplyAppDeps = {},
): Promise<AppApplyResult> {
  const mode = options.mode;
  // ① confirm 门禁 —— 必须是第一步，未确认绝不触碰磁盘。
  requireConfirm(options.confirm);

  // 再次防御性校验（允许路由直接传入未校验对象）。
  const manifest = validateAppManifest(manifestInput);
  const id = manifest.id;

  const steps: string[] = [];
  const backups: string[] = [];
  let hooks: AppHookName[] = [];
  let backupPath: string | undefined;

  const appsDir = deps.appsDir;
  const existing = await readInstalledApp(id, appsDir);

  const configLike = {
    hermesHome: deps.hermesHome,
    cliPath: deps.cliPath,
    backupDir: deps.backupDir,
    timeoutMs: deps.timeoutMs,
  };

  switch (mode) {
    case "install":
    case "update": {
      // 只读签名校验。
      const signStatus = await verifySign(
        manifest,
        resolveAppSourceDir(manifest, deps.repoRoot ?? REPO_ROOT),
      );
      steps.push(`sign：${signStatus}`);

      if (mode === "update") {
        // ② 先备份当前 profile + 保存上一版 manifest（备份失败则中止，不破坏已有安装）。
        if (profileExists(id, deps)) {
          const backup = await backupAgent(id, configLike);
          if (backup.backupPath) {
            backupPath = backup.backupPath;
            backups.push(backup.backupPath);
            steps.push(`已备份 profile：${backup.backupPath}`);
          }
        }
      }

      await runInstallSteps(id, manifest, deps, steps);

      // ⑤ 最后写安装记录（原子 + 脱敏）。
      let history = existing?.history ? [...existing.history] : [];
      if (mode === "update" && existing) {
        history.push({
          version: existing.version,
          at: existing.updatedAt ?? existing.installedAt,
          manifest: existing.manifest,
          ...(existing.backupPath ? { backupPath: existing.backupPath } : {}),
        });
        // 同时保留本次 update 前刚生成的备份，供 rollback。
        if (backupPath) {
          const last = history[history.length - 1];
          if (last) {
            history[history.length - 1] = {
              ...last,
              backupPath: last.backupPath ?? backupPath,
            };
          }
        }
      }

      const record = buildRecord(manifest, history, backupPath, existing, mode);
      await writeInstalledApp(record, appsDir);
      steps.push(`已写入安装记录 ${id}`);

      hooks =
        mode === "install"
          ? (manifest.hooks?.oninstall ?? [])
          : (manifest.hooks?.onupdate ?? []);

      emitAppEvent(appEventType(mode), {
        id,
        version: manifest.version,
        mode,
        hooks,
        ...(manifest.ui ? { ui: manifest.ui } : {}),
        at: nowIso(),
        ...(backupPath ? { backupPath } : {}),
        // M7 executor 用（进程内 only，含 env 明文 / plugins）。
        manifest,
      });

      invalidateAgentsCache();
      return {
        ok: true,
        mode,
        id,
        version: manifest.version,
        steps,
        backups,
        hooks,
        ...(backupPath ? { backupPath } : {}),
        message:
          mode === "install"
            ? `App「${manifest.name}」安装成功（v${manifest.version}）。`
            : `App「${manifest.name}」已更新至 v${manifest.version}。`,
      };
    }

    case "uninstall": {
      // 删除前自动备份（复用 lifecycle；备份失败中止）。
      if (profileExists(id, deps)) {
        const result = await deleteAgent(id, { confirm: true, backup: true }, configLike);
        if (result.backupPath) {
          backupPath = result.backupPath;
          backups.push(result.backupPath);
          steps.push(`删除前已备份：${result.backupPath}`);
        }
        steps.push(`已删除 profile：${result.command}`);
      } else {
        steps.push("profile 不存在，跳过删除");
      }

      // 删记录。
      const removed = await removeInstalledApp(id, appsDir);
      steps.push(removed ? "已删除安装记录" : "无安装记录");

      hooks = manifest.hooks?.ondelete ?? [];
      emitAppEvent("app.uninstall", {
        id,
        version: manifest.version,
        mode,
        hooks,
        ...(manifest.ui ? { ui: manifest.ui } : {}),
        at: nowIso(),
        ...(backupPath ? { backupPath } : {}),
        manifest,
      });

      invalidateAgentsCache();
      return {
        ok: true,
        mode,
        id,
        version: manifest.version,
        steps,
        backups,
        hooks,
        ...(backupPath ? { backupPath } : {}),
        message: `App「${manifest.name}」已卸载。`,
      };
    }

    case "rollback": {
      if (!existing || !existing.history || existing.history.length === 0) {
        throw new LifecycleError(
          "BACKUP_NOT_FOUND",
          `App「${id}」没有可回滚的历史版本。`,
        );
      }
      const history = [...existing.history];
      const prev = history.pop()!;

      // 恢复 profile（复用 lifecycle 备份机制：export 产物 + profile import）。
      const prevBackup = prev.backupPath ?? existing.backupPath;
      if (prevBackup && existsSync(prevBackup)) {
        await runHermes(["profile", "import", prevBackup], {
          cliPath: deps.cliPath,
          timeoutMs: deps.timeoutMs,
        });
        backups.push(prevBackup);
        steps.push(`已从备份恢复 profile：${prevBackup}`);
        backupPath = prevBackup;
      } else {
        steps.push("无 profile 备份文件，仅回滚配置快照");
      }

      // 确保 profile 目录存在以便重放配置。
      await ensureProfileDir(id, prev.manifest, deps, steps);
      // 用上一版 manifest 重放 model/mcp/env。
      await applyProfileConfig(id, prev.manifest, deps, steps);

      // 写回 version：当前版本压回 history 末尾，便于再滚回。
      const currentEntry: NonNullable<InstalledAppRecord["history"]>[number] = {
        version: existing.version,
        at: existing.updatedAt ?? existing.installedAt,
        manifest: existing.manifest,
        ...(existing.backupPath ? { backupPath: existing.backupPath } : {}),
      };
      const nextHistory = [...history, currentEntry];
      const at = nowIso();
      await writeInstalledApp(
        {
          id: prev.manifest.id,
          name: prev.manifest.name,
          version: prev.manifest.version,
          installedAt: existing.installedAt,
          updatedAt: at,
          ...(backupPath ? { backupPath } : {}),
          manifest: sanitizeManifestForStore(prev.manifest),
          history: nextHistory,
        },
        appsDir,
      );
      steps.push(`已回滚到 v${prev.manifest.version}`);

      hooks = prev.manifest.hooks?.onupdate ?? [];
      emitAppEvent("app.rollback", {
        id,
        version: prev.manifest.version,
        mode,
        hooks,
        ...(prev.manifest.ui ? { ui: prev.manifest.ui } : {}),
        at: nowIso(),
        ...(backupPath ? { backupPath } : {}),
        manifest: prev.manifest,
      });

      invalidateAgentsCache();
      return {
        ok: true,
        mode,
        id,
        version: prev.manifest.version,
        steps,
        backups,
        hooks,
        ...(backupPath ? { backupPath } : {}),
        message: `App「${prev.manifest.name}」已回滚到 v${prev.manifest.version}。`,
      };
    }

    default: {
      const exhaustive: never = mode;
      throw new LifecycleError(
        "INVALID_MANIFEST",
        `未知的编排 mode：${String(exhaustive)}`,
      );
    }
  }
}
