import { spawn } from "node:child_process";
import type { CompleteVia } from "@shared/types";
import { detectHermes } from "./detect";
import { lifecycleError } from "./errors";
import { ensureGateway } from "./gateway";

/**
 * 模型补全的三级降级链（M5.1）：
 *   1) gateway（`hermes serve` JSON-RPC，主通道）；
 *   2) `hermes -p <profile> -z <prompt>` 一次性（无 gateway 时）；
 *   3) 桩文本（全不可用）。
 *
 * 每次返回附 `via` 便于调试面板区分通道；所有 spawn 一律 shell:false。
 */

/** 补全结果。 */
export interface CompleteResult {
  text: string;
  /** 实际走的通道。 */
  via: CompleteVia;
  /** 是否降级为桩。 */
  stub?: boolean;
  /** 降级原因（各通道失败信息串联，便于排查）。 */
  error?: string;
}

/** 补全依赖注入（全部可选，测试隔离用）。 */
export interface CompleteOptions {
  /** 目标 profile（透传给 gateway / `-p`）。 */
  profile?: string;
  /** 解析 CLI 路径；默认 detectHermes。 */
  resolveCliPath?: () => Promise<string | null>;
  /** gateway 补全；默认 ensureGateway + client.complete。 */
  gatewayComplete?: (
    cliPath: string,
    prompt: string,
    options: { profile?: string },
  ) => Promise<{ text: string }>;
  /** 一次性补全；默认 runOneshotViaCli。 */
  runOneshot?: (
    cliPath: string,
    prompt: string,
    options: { profile?: string },
  ) => Promise<string>;
  /** 是否允许桩降级（默认 true）。 */
  allowStub?: boolean;
}

let lastVia: CompleteVia | null = null;
let lastError: string | null = null;

/** 最近一次 completePrompt 实际通道。 */
export function getLastCompleteVia(): CompleteVia | null {
  return lastVia;
}

/** 最近一次 completePrompt 的降级/错误信息。 */
export function getLastCompleteError(): string | null {
  return lastError;
}

/** 默认 gateway 补全：复用进程内单例 gateway。 */
async function defaultGatewayComplete(
  cliPath: string,
  prompt: string,
  options: { profile?: string },
): Promise<{ text: string }> {
  const entry = await ensureGateway(cliPath);
  return await entry.client.complete(prompt, { profile: options.profile });
}

/**
 * 一次性补全：`hermes [-p <profile>] -z <prompt>`。
 * prompt 作为**单个**参数传递，绝不经过 shell。
 */
export async function runOneshotViaCli(
  cliPath: string,
  prompt: string,
  options: { profile?: string; timeoutMs?: number } = {},
): Promise<string> {
  const args: string[] = [];
  if (options.profile) args.push("-p", options.profile);
  args.push("-z", prompt);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cliPath, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        lifecycleError(
          "GATEWAY_TIMEOUT",
          `hermes -z 超时（>${options.timeoutMs ?? 120_000}ms）。`,
        ),
      );
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        lifecycleError("HERMES_CLI_UNAVAILABLE", `无法启动 hermes：${error.message}`),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        lifecycleError(
          "COMMAND_FAILED",
          `hermes -z 退出码 ${code}：${stderr.trim().slice(0, 300)}`,
        ),
      );
    });
  });
}

/** 按 gateway → oneshot → stub 的顺序完成一次补全。 */
export async function completePrompt(
  prompt: string,
  options: CompleteOptions = {},
): Promise<CompleteResult> {
  const resolveCli =
    options.resolveCliPath ?? (async () => (await detectHermes()).cliPath);
  const gatewayComplete = options.gatewayComplete ?? defaultGatewayComplete;
  const oneshot = options.runOneshot ?? runOneshotViaCli;
  const errors: string[] = [];

  let cliPath: string | null = null;
  try {
    cliPath = await resolveCli();
  } catch (error) {
    errors.push(`resolveCli: ${(error as Error).message}`);
  }

  if (cliPath) {
    try {
      const { text } = await gatewayComplete(cliPath, prompt, {
        profile: options.profile,
      });
      return finalize({ text: text ?? "", via: "gateway" });
    } catch (error) {
      errors.push(`gateway: ${(error as Error).message}`);
    }

    try {
      const text = await oneshot(cliPath, prompt, { profile: options.profile });
      return finalize({ text, via: "oneshot" });
    } catch (error) {
      errors.push(`oneshot: ${(error as Error).message}`);
    }
  } else {
    errors.push("未找到可用的 hermes CLI");
  }

  const detail = errors.join(" | ");
  if (options.allowStub === false) {
    throw lifecycleError("GATEWAY_UNAVAILABLE", `模型补全失败：${detail}`);
  }

  return finalize({
    text: `[stub] 未接入真实 Hermes（补全降级）。prompt=${prompt}`,
    via: "stub",
    stub: true,
    error: detail,
  });
}

/** 记录并返回结果。 */
function finalize(result: CompleteResult): CompleteResult {
  lastVia = result.via;
  lastError = result.via === "stub" ? (result.error ?? "stub") : (result.error ?? null);
  return result;
}
