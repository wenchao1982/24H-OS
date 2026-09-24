import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HermesMode, HermesStatus } from "@shared/types";

/**
 * Hermes 探测层。
 * 负责：找到 hermes CLI（which hermes / hermes --version）、确认 ~/.hermes 是否存在。
 * 注意：这里只做“只读探测”，不修改任何用户文件。
 */

const execFileAsync = promisify(execFile);

/** Hermes 主目录，可通过环境变量 HERMES_HOME 覆盖，便于测试。 */
export const HERMES_HOME =
  process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");

/** Hermes profiles 目录（一个子目录 = 一个 agent）。 */
export const PROFILES_DIR = path.join(HERMES_HOME, "profiles");

/** 探测结果原始数据。 */
export interface HermesDetection {
  /** 是否在 PATH 上找到 hermes 可执行文件。 */
  cliFound: boolean;
  /** hermes --version 输出（首行）。 */
  version: string | null;
  /** hermes 可执行文件绝对路径。 */
  cliPath: string | null;
  /** ~/.hermes 是否存在。 */
  homeExists: boolean;
  /** ~/.hermes/profiles 是否存在。 */
  profilesDirExists: boolean;
  /** ~/.hermes 下是否存在可解析的配置文件。 */
  homeConfigExists: boolean;
}

/** which <bin> 的封装，失败返回 null。 */
async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/** 读取 hermes --version，失败返回 null。 */
async function readVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("hermes", ["--version"], {
      timeout: 4000,
    });
    const firstLine = stdout.trim().split(/\r?\n/)[0] ?? "";
    return firstLine.length > 0 ? firstLine : null;
  } catch {
    return null;
  }
}

/** 执行一次完整探测。 */
export async function detectHermes(): Promise<HermesDetection> {
  const cliPath = await which("hermes");
  const version = cliPath ? await readVersion() : null;
  const homeExists = existsSync(HERMES_HOME);
  const profilesDirExists = existsSync(PROFILES_DIR);
  const homeConfigExists = ["config.yaml", "config.yml", "config.json"].some(
    (file) => existsSync(path.join(HERMES_HOME, file)),
  );

  return {
    cliFound: Boolean(cliPath),
    version,
    cliPath,
    homeExists,
    profilesDirExists,
    homeConfigExists,
  };
}

/**
 * 决定运行模式：
 * - live：能读到真实 Hermes 数据（profiles 目录，或 ~/.hermes 配置文件）。
 * - mock：既没有 profiles 又没有可读配置（例如全新的机器 / 未安装 Hermes）。
 */
export function decideMode(det: HermesDetection): HermesMode {
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
      ? `CLI 已安装${det.version ? `（${det.version}）` : ""}`
      : "未找到 CLI，但检测到 ~/.hermes 配置";
    message = `已连接 Hermes：${cliNote}，加载 ${profileCount} 个 profile。`;
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
    homePath: det.homeExists ? HERMES_HOME : null,
    profileCount,
    message,
  };
}
