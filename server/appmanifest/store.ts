import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppManifest, InstalledAppRecord } from "@shared/types";
import { LifecycleError } from "../hermes/errors";

/**
 * 已安装 App 记录存储（M6）。
 *
 * 位置：`~/.24os/apps/<id>.json`（可用 OS_APPS_DIR 覆盖）。
 * 安全：
 *   - **原子写**：同目录临时文件 + rename；
 *   - **密钥不回显**：写入前对 manifest.profile.env 的值一律脱敏为 `"***"`；
 *   - id 必须匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，防路径穿越。
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 记录根目录。 */
export function resolveAppsRoot(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.OS_APPS_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".24os", "apps");
}

/** 校验 id，非法抛 INVALID_NAME。 */
export function validateAppId(id: unknown): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new LifecycleError(
      "INVALID_NAME",
      `非法的 app id：${String(id)}（要求匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }
  return id;
}

/** 记录文件路径。 */
export function appRecordPath(id: string, appsRoot?: string): string {
  const appId = validateAppId(id);
  const file = path.join(resolveAppsRoot(appsRoot), `${appId}.json`);
  const root = resolveAppsRoot(appsRoot);
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new LifecycleError("PATH_TRAVERSAL", `拒绝越界记录路径：${file}`);
  }
  return file;
}

/** 深拷贝 manifest 并把 env 明文值脱敏为 `"***"`。 */
export function sanitizeManifestForStore(manifest: AppManifest): AppManifest {
  const clone = JSON.parse(JSON.stringify(manifest)) as AppManifest;
  if (clone.profile?.env) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(clone.profile.env)) {
      env[key] = value === "" ? "" : "***";
    }
    clone.profile.env = env;
  }
  return clone;
}

/** 原子写（同目录临时文件 + rename）。 */
async function atomicWrite(file: string, content: string): Promise<void> {
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

/** 写入安装记录（总是对 env 脱敏）。 */
export async function writeInstalledApp(
  record: InstalledAppRecord,
  appsRoot?: string,
): Promise<string> {
  const id = validateAppId(record.id);
  const file = appRecordPath(id, appsRoot);
  const payload: InstalledAppRecord = {
    ...record,
    id,
    manifest: sanitizeManifestForStore(record.manifest),
    history: (record.history ?? []).map((item) => ({
      ...item,
      manifest: sanitizeManifestForStore(item.manifest),
    })),
  };
  await atomicWrite(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/** 读取安装记录；不存在 / 损坏返回 null。 */
export async function readInstalledApp(
  id: string,
  appsRoot?: string,
): Promise<InstalledAppRecord | null> {
  const file = appRecordPath(id, appsRoot);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as InstalledAppRecord;
  } catch {
    return null;
  }
}

/** 删除安装记录；返回是否删掉了文件。 */
export async function removeInstalledApp(
  id: string,
  appsRoot?: string,
): Promise<boolean> {
  const file = appRecordPath(id, appsRoot);
  if (!existsSync(file)) return false;
  await rm(file, { force: true });
  return true;
}

/** 列出已安装记录 id（按字典序）。 */
export async function listInstalledAppIds(appsRoot?: string): Promise<string[]> {
  const root = resolveAppsRoot(appsRoot);
  try {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(root);
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter((id) => ID_PATTERN.test(id))
      .sort();
  } catch {
    return [];
  }
}
