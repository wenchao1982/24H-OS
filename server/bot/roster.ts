import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { BotConfig } from "@shared/types";
import { LifecycleError } from "../hermes/errors";

/**
 * Bot Mode 花名册（M7）：读取 `~/.24os/bots.yaml`（可用 OS_BOTS_FILE 覆盖）。
 *
 * 校验：
 *   - id 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`；
 *   - schedule 匹配 `^\d{2}:\d{2}$`（服务器本地时区 HH:MM）；
 *   - prompt 必填非空；
 *   - `enabled:false` 或 `disable:true` → 关闭。
 * 非法条目跳过并记入 errors（不整文件失败）。
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SCHEDULE_PATTERN = /^(\d{2}):(\d{2})$/;

/** 解析 bots.yaml 路径。 */
export function resolveBotsFile(override?: string): string {
  if (override && override.trim()) return path.resolve(override.trim());
  const fromEnv = process.env.OS_BOTS_FILE;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".24os", "bots.yaml");
}

/** 校验并规范化单条 bot；非法抛 LifecycleError。 */
export function validateBot(raw: unknown, index: number): BotConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LifecycleError("INVALID_VALUE", `bots[${index}] 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id || !ID_PATTERN.test(id)) {
    throw new LifecycleError(
      "INVALID_NAME",
      `bots[${index}].id 非法：${String(obj.id)}（需匹配 ^[a-z0-9][a-z0-9_-]{0,63}$）`,
    );
  }

  const schedule = typeof obj.schedule === "string" ? obj.schedule.trim() : "";
  const match = SCHEDULE_PATTERN.exec(schedule);
  if (!match) {
    throw new LifecycleError(
      "INVALID_VALUE",
      `bots[${index}].schedule 非法：${String(obj.schedule)}（需匹配 ^\\d{2}:\\d{2}$）`,
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new LifecycleError(
      "INVALID_VALUE",
      `bots[${index}].schedule 超出范围：${schedule}`,
    );
  }

  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (!prompt) {
    throw new LifecycleError("INVALID_VALUE", `bots[${index}].prompt 不能为空`);
  }

  let notify: string[] | undefined;
  if (obj.notify !== undefined) {
    if (!Array.isArray(obj.notify)) {
      throw new LifecycleError("INVALID_VALUE", `bots[${index}].notify 必须是数组`);
    }
    notify = obj.notify
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    if (notify.length === 0) notify = undefined;
  }

  const profile =
    typeof obj.profile === "string" && obj.profile.trim()
      ? obj.profile.trim()
      : undefined;

  const explicitlyDisabled = obj.disable === true || obj.enabled === false;
  const enabled = !explicitlyDisabled;

  const bot: BotConfig = {
    id,
    schedule,
    prompt,
    enabled,
    ...(profile ? { profile } : {}),
    ...(notify ? { notify } : {}),
  };
  return bot;
}

/** 解析 bots.yaml 文本 → 合法 bots + 跳过错误。 */
export function parseRoster(yamlText: string): {
  bots: BotConfig[];
  errors: string[];
} {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    return { bots: [], errors: [`YAML 解析失败：${(error as Error).message}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { bots: [], errors: ["bots.yaml 根必须是对象（含 bots: 列表）"] };
  }
  const list = (parsed as Record<string, unknown>).bots;
  if (list === undefined || list === null) return { bots: [], errors };
  if (!Array.isArray(list)) {
    return { bots: [], errors: ["bots 必须是数组"] };
  }

  const bots: BotConfig[] = [];
  const seen = new Set<string>();
  list.forEach((item, index) => {
    try {
      const bot = validateBot(item, index);
      if (seen.has(bot.id)) {
        errors.push(`重复 bot id：${bot.id}（已跳过）`);
        return;
      }
      seen.add(bot.id);
      bots.push(bot);
    } catch (error) {
      errors.push((error as Error).message);
    }
  });
  return { bots, errors };
}

/** 读取花名册；文件不存在 → 空列表。 */
export function loadRoster(file?: string): {
  bots: BotConfig[];
  errors: string[];
  file: string;
  exists: boolean;
} {
  const resolved = resolveBotsFile(file);
  if (!existsSync(resolved)) {
    return { bots: [], errors: [], file: resolved, exists: false };
  }
  try {
    const text = readFileSync(resolved, "utf8");
    const result = parseRoster(text);
    return { ...result, file: resolved, exists: true };
  } catch (error) {
    return {
      bots: [],
      errors: [(error as Error).message],
      file: resolved,
      exists: true,
    };
  }
}

/** 生效启用状态：内存覆盖 > 文件 enabled/disable。 */
export function isBotEffectivelyEnabled(
  bot: BotConfig,
  override?: Map<string, boolean>,
): boolean {
  const forced = override?.get(bot.id);
  if (forced !== undefined) return forced;
  return bot.enabled;
}

/** 下次运行 ISO（今日已过则明天）；enabled=false 时由调用方给 null。 */
export function nextRunOf(schedule: string, now: Date): string | null {
  const match = SCHEDULE_PATTERN.exec(schedule);
  if (!match) return null;
  const next = new Date(now.getTime());
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}
