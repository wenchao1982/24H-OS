import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppManifest } from "@shared/types";
import { LifecycleError } from "../hermes/errors";
import { resolveAppSourceDir } from "./manifest";

/**
 * AppManifest 完整性校验（M6）。
 *
 * 算法（与 docs/APP_MANIFEST.md 一致）：
 *   1. 递归收集 source.path 目录下所有普通文件的**相对路径**（posix 分隔符）；
 *   2. 按相对路径字典序排序；
 *   3. 依次喂入 `sha256.update(relPath + "\n" + fileBytes)`；
 *   4. 输出 hex。
 *
 * `sign.sha256` 为空 → 跳过（返回 "skipped"）；
 * 不匹配 → 抛 `SIGN_MISMATCH`。
 */

export type SignVerifyStatus = "skipped" | "ok";

/** 收集目录内相对文件路径（跳过符号链接，防穿越）。 */
async function walkFiles(root: string, base = root): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, base)));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** 计算目录内容 sha256（相对路径排序 + `path\ncontent` 拼接）。 */
export async function computeSourceSha256(dir: string): Promise<string> {
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new LifecycleError("INVALID_SOURCE", `sign 源不是目录：${dir}`);
  }
  const files = await walkFiles(dir);
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel, "utf8");
    hash.update("\n");
    hash.update(await readFile(path.join(dir, rel)));
  }
  return hash.digest("hex");
}

/**
 * 校验 manifest.sign。
 * - 无 sha256（空 / 缺省）→ `skipped`；
 * - 无 source 目录（如 url 源未下载）→ `skipped`；
 * - 不匹配 → 抛 `SIGN_MISMATCH`。
 */
export async function verifySign(
  manifest: AppManifest,
  sourceDir?: string | null,
): Promise<SignVerifyStatus> {
  const expected = manifest.sign?.sha256?.trim().toLowerCase();
  if (!expected) return "skipped";

  const dir = sourceDir ?? resolveAppSourceDir(manifest);
  if (!dir) return "skipped";

  const actual = (await computeSourceSha256(dir)).toLowerCase();
  if (actual !== expected) {
    throw new LifecycleError(
      "SIGN_MISMATCH",
      `签名校验失败（${manifest.id}）：期望 ${expected}，实际 ${actual}`,
    );
  }
  return "ok";
}
