import type { BotConfig, BotRunResult } from "@shared/types";
import { broadcast } from "../dashboard/bus";
import { readInstalledApp, listInstalledAppIds } from "../appmanifest/store";
import { detectHermes } from "../hermes/detect";
import { streamPrompt } from "../hermes/chat";
import { completePrompt } from "../hermes/complete";
import {
  findPluginByName,
  pushNotify,
  readProfileEnvValues,
  type PushNotifyPlugin,
  type PushNotifyResult,
} from "../hooks/outbound";
import {
  isBotEffectivelyEnabled,
  loadRoster,
  nextRunOf,
  resolveBotsFile,
} from "./roster";

/**
 * Bot Mode 调度器（M7）。
 *
 * - `startScheduler(deps)` / `stopScheduler()`；
 * - 内部 `setInterval` 每 30s tick，比对当前 `HH:MM`（deps.now 可注入假时钟）；
 * - 到点且今日该分钟未跑 → run：
 *     ensureGateway → streamPrompt（失败回退 completePrompt 降级链）；
 *     结果经 outbound.pushNotify 推到 bot.notify 的 plugins；
 *     广播 `{type:"bot.run"}`；写环形日志（GET /api/bots/log）。
 *
 * 安全默认：`OS_BOT_ENABLED=1` 才在 server 启动时自动 start（默认关）。
 */

const LOG_LIMIT = 100;
const DEFAULT_TICK_MS = 30_000;

/** 调度器依赖注入（测试用）。 */
export interface SchedulerDeps {
  /** 当前时间（默认 Date）。 */
  now?: () => Date;
  /** tick 间隔 ms（默认 30000）。 */
  tickMs?: number;
  /** 加载花名册（默认 loadRoster）。 */
  loadRoster?: () => { bots: BotConfig[]; errors: string[]; file: string };
  /** 执行 bot prompt（默认 streamPrompt→completePrompt）。 */
  runPrompt?: (bot: BotConfig) => Promise<{ text: string }>;
  /** 推送（默认 outbound.pushNotify）。 */
  pushNotify?: typeof pushNotify;
  /** 广播（默认 dashboard/bus）。 */
  broadcast?: (event: { type: string; at?: string; payload?: Record<string, unknown> }) => void;
  /** 解析 profile env（token）。 */
  readEnv?: (appId: string) => Promise<Record<string, string>>;
}

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  /** botId → "YYYY-MM-DD HH:MM"（同分钟不重复）。 */
  lastRunKey: Map<string, string>;
  /** 内存 enable/disable 覆盖。 */
  enabledOverride: Map<string, boolean>;
  /** botId → 最近结果。 */
  lastByBot: Map<string, BotRunResult>;
  /** 环形运行日志（旧→新）。 */
  log: BotRunResult[];
}

const state: SchedulerState = {
  timer: null,
  lastRunKey: new Map(),
  enabledOverride: new Map(),
  lastByBot: new Map(),
  log: [],
};

let currentDeps: SchedulerDeps = {};

/** 最近运行日志（新→旧副本）。 */
export function getBotLog(): BotRunResult[] {
  return [...state.log].reverse();
}

/** 是否在跑。 */
export function isSchedulerRunning(): boolean {
  return state.timer !== null;
}

/** 内存态 enable/disable（不落盘）。返回是否找到 bot。 */
export function setBotEnabled(id: string, enabled: boolean): boolean {
  const { bots } = currentDeps.loadRoster?.() ?? loadRoster();
  if (!bots.some((bot) => bot.id === id)) return false;
  state.enabledOverride.set(id, enabled);
  return true;
}

/** 清除全部内存覆盖与日志（测试）。 */
export function resetSchedulerState(): void {
  stopScheduler();
  state.lastRunKey.clear();
  state.enabledOverride.clear();
  state.lastByBot.clear();
  state.log.length = 0;
  currentDeps = {};
}

function record(result: BotRunResult): void {
  state.log.push(result);
  if (state.log.length > LOG_LIMIT) {
    state.log.splice(0, state.log.length - LOG_LIMIT);
  }
  state.lastByBot.set(result.botId, result);
}

function emit(
  fn: SchedulerDeps["broadcast"],
  type: string,
  payload: Record<string, unknown>,
): void {
  const impl = fn ?? broadcast;
  impl({ type, at: new Date().toISOString(), payload });
}

/** 默认 prompt 执行：优先 gateway streamPrompt，失败回退 completePrompt。 */
export async function defaultRunPrompt(
  bot: BotConfig,
): Promise<{ text: string }> {
  try {
    const detection = await detectHermes();
    if (detection.cliPath) {
      let text = "";
      let lastLen = 0;
      const result = await streamPrompt({
        profile: bot.profile,
        prompt: bot.prompt,
        onEvent: (event) => {
          if (event.type === "delta") {
            lastLen += (event.text ?? "").length;
          } else if (event.type === "done") {
            text = event.text ?? "";
            if (!text) text = " ".repeat(0);
            lastLen = text.length || lastLen;
          }
        },
        timeoutMs: 120_000,
      });
      if (result.status === "done" && (text || lastLen > 0)) {
        return { text };
      }
    }
  } catch {
    // 回退降级链。
  }
  const completed = await completePrompt(bot.prompt, {
    profile: bot.profile,
    allowStub: true,
  });
  return { text: completed.text };
}

/** 在已安装 apps 中按 plugin 名解析目标 + 明文 env。 */
async function resolveNotifyTargets(names: string[]): Promise<
  Array<{ plugin: PushNotifyPlugin; env: Record<string, string>; appId: string }>
> {
  const out: Array<{
    plugin: PushNotifyPlugin;
    env: Record<string, string>;
    appId: string;
  }> = [];
  if (names.length === 0) return out;
  const ids = await listInstalledAppIds();
  for (const id of ids) {
    const record = await readInstalledApp(id);
    const plugins = record?.manifest?.plugins;
    if (!plugins) continue;
    for (const name of names) {
      const plugin = findPluginByName(plugins, name);
      if (!plugin) continue;
      const env = await readProfileEnvValues(id);
      out.push({ plugin, env, appId: id });
    }
  }
  return out;
}

/** 执行一个 bot（异常不抛穿调度循环）。 */
export async function runBotOnce(
  bot: BotConfig,
  deps: SchedulerDeps,
  atDate: Date,
): Promise<BotRunResult> {
  const at = atDate.toISOString();
  try {
    const runPrompt = deps.runPrompt ?? defaultRunPrompt;
    const { text } = await runPrompt(bot);

    const push = deps.pushNotify ?? pushNotify;
    const readEnv =
      deps.readEnv ?? ((id: string) => readProfileEnvValues(id, {}));
    const body = {
      event: "bot.run",
      botId: bot.id,
      profile: bot.profile,
      status: "ok",
      at,
      len: text.length,
    };

    const notifyResults: Array<{ target: string; status: PushNotifyResult["status"] }> = [];
    if (bot.notify && bot.notify.length > 0) {
      const targets = await resolveNotifyTargets(bot.notify);
      for (const target of targets) {
        const env =
          target.env && Object.keys(target.env).length > 0
            ? target.env
            : await readEnv(target.appId);
        const result = await push(target.plugin, body, { env });
        notifyResults.push({ target: target.plugin.name ?? "?", status: result.status });
      }
    }

    const result: BotRunResult = {
      botId: bot.id,
      status: "ok",
      at,
      len: text.length,
    };
    record(result);
    emit(deps.broadcast, "bot.run", {
      botId: bot.id,
      status: "ok",
      at,
      len: text.length,
      ...(notifyResults.length > 0 ? { notify: notifyResults } : {}),
    });
    return result;
  } catch (error) {
    const result: BotRunResult = {
      botId: bot.id,
      status: "error",
      at,
      error: (error as Error).message,
    };
    record(result);
    emit(deps.broadcast, "bot.run", {
      botId: bot.id,
      status: "error",
      at,
      error: result.error,
    });
    return result;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 一次 tick：找出应跑的 bots 并触发（同分钟去重）。 */
export function schedulerTick(deps: SchedulerDeps = {}): void {
  const now = (deps.now ?? Date.now.bind(Date))() as unknown as Date;
  const nowDate = now instanceof Date ? now : new Date(now);
  const hhmm = `${pad2(nowDate.getHours())}:${pad2(nowDate.getMinutes())}`;
  const dayKey = `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}`;
  const runKey = `${dayKey} ${hhmm}`;

  const roster =
    deps.loadRoster?.() ?? loadRoster();
  for (const bot of roster.bots) {
    if (!isBotEffectivelyEnabled(bot, state.enabledOverride)) continue;
    if (bot.schedule !== hhmm) continue;
    if (state.lastRunKey.get(bot.id) === runKey) continue;
    state.lastRunKey.set(bot.id, runKey);
    void runBotOnce(bot, deps, nowDate).catch(() => undefined);
  }
}

/**
 * 启动调度（幂等：先 stop 再 start）。
 * 定时器 unref，不阻止进程退出。
 */
export function startScheduler(deps: SchedulerDeps = {}): void {
  stopScheduler();
  currentDeps = { ...deps };
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  state.timer = setInterval(() => {
    try {
      schedulerTick(currentDeps);
    } catch {
      // tick 异常不杀定时器。
    }
  }, tickMs);
  state.timer.unref?.();
}

/** 停止调度（幂等）。 */
export function stopScheduler(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** 当前生效依赖（列表接口用）。 */
export function getSchedulerDeps(): SchedulerDeps {
  return currentDeps;
}

/** 组装 GET /api/bots 的列表（含 nextRun / lastRun）。 */
export function listBotsForApi(): {
  bots: Array<
    BotConfig & { nextRun: string | null; lastRun: BotRunResult | null }
  >;
  file: string;
  errors: string[];
} {
  const now = (currentDeps.now ?? (() => new Date()))();
  const roster = currentDeps.loadRoster?.() ?? loadRoster();
  const bots = roster.bots.map((bot) => {
    const enabled = isBotEffectivelyEnabled(bot, state.enabledOverride);
    return {
      ...bot,
      enabled,
      nextRun: enabled ? nextRunOf(bot.schedule, now) : null,
      lastRun: state.lastByBot.get(bot.id) ?? null,
    };
  });
  return { bots, file: roster.file ?? resolveBotsFile(), errors: roster.errors ?? [] };
}

/** 是否 OS_BOT_ENABLED=1。 */
export function isBotModeEnvEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OS_BOT_ENABLED === "1";
}
