import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppManifestPlugin } from "@shared/types";
import { resolveAgentDir, type ConfigEditDeps } from "../hermes/configEdit";

/**
 * hooks.outbound：签名 HTTP 推送（M7）。
 *
 * 安全：
 *   - 无 endpoint / 无明文 token → `skipped`（不报错）；
 *   - token 绝不写入日志与 GET 响应；
 *   - 签名：`x-24os-timestamp` + `x-24os-signature: sha256=<HMAC(token, ts.body)>`。
 */

export type PushNotifyStatus = "ok" | "skipped" | "error";

export interface PushNotifyResult {
  status: PushNotifyStatus;
  /** skipped / error 原因（不含 token）。 */
  reason?: string;
  statusCode?: number;
}

/** 推送目标（AppManifestPlugin 子集）。 */
export interface PushNotifyPlugin {
  name?: string;
  endpoint?: string;
  envKey?: string;
}

export interface PushNotifyOptions {
  /** 明文 token（优先；apply 时传入）。 */
  token?: string | null;
  /** 明文 env map（含 envKey 对应值）。 */
  env?: Record<string, string>;
  /** 注入 fetch（测试 mock）。 */
  fetchImpl?: typeof fetch;
  /** 超时毫秒，默认 10000。 */
  timeoutMs?: number;
}

/** 计算签名 hex：`HMAC-SHA256(token, timestamp + "." + body)`。 */
export function signPushBody(
  token: string,
  timestamp: number,
  body: string,
): string {
  return createHmac("sha256", token)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

/** 构造签名请求头（不含 body）。 */
export function buildPushHeaders(
  token: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-24os-timestamp": String(timestamp),
    "x-24os-signature": `sha256=${signPushBody(token, timestamp, body)}`,
  };
}

/**
 * 解析 profile `.env` 的明文键值（进程内 outbound 用；绝不外发整表）。
 * 读不到 / 非法 agent → 空对象。
 */
export async function readProfileEnvValues(
  appId: string,
  deps: ConfigEditDeps = {},
): Promise<Record<string, string>> {
  try {
    const dir = resolveAgentDir(appId, deps);
    const raw = await readFile(path.join(dir, ".env"), "utf8").catch(() => "");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      out[match[1]] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 推送一条 notify 到 http plugin。
 * - 无 endpoint → skipped
 * - 无 token（options.token / env[envKey] / 脱敏 "***"）→ skipped
 * - 网络 / 非 2xx → error（不抛）
 */
export async function pushNotify(
  plugin: PushNotifyPlugin,
  bodyObj: unknown,
  options: PushNotifyOptions = {},
): Promise<PushNotifyResult> {
  const endpoint = plugin.endpoint?.trim();
  if (!endpoint) {
    return { status: "skipped", reason: "plugin 未配置 endpoint" };
  }

  let token = options.token ?? null;
  if (!token && plugin.envKey && options.env) {
    const fromEnv = options.env[plugin.envKey];
    token = fromEnv && fromEnv !== "***" ? fromEnv : null;
  }
  if (!token) {
    return { status: "skipped", reason: "未取到明文 token" };
  }

  const body = JSON.stringify(bodyObj ?? {});
  const timestamp = Date.now();
  const headers = buildPushHeaders(token, timestamp, body);
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          status: "error",
          statusCode: response.status,
          reason: `HTTP ${response.status}`,
        };
      }
      return { status: "ok", statusCode: response.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { status: "error", reason: (error as Error).message };
  }
}

/** 按 plugin 名在一组 manifest plugins 中查找（bot notify 用）。 */
export function findPluginByName(
  plugins: AppManifestPlugin[] | undefined,
  name: string,
): AppManifestPlugin | null {
  return plugins?.find((item) => item.name === name) ?? null;
}
