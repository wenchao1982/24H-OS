import type {
  AppHookName,
  AppManifest,
  HookLogEntry,
} from "@shared/types";
import {
  appEventType,
  onAppEvent,
  type AppEventListener,
  type AppEventPayload,
  type AppEventType,
} from "../appmanifest/events";
import { reapplyProfileConfig, type ApplyAppDeps } from "../appmanifest/apply";
import { broadcast } from "../dashboard/bus";
import {
  pushNotify,
  readProfileEnvValues,
  type PushNotifyOptions,
  type PushNotifyPlugin,
  type PushNotifyResult,
} from "./outbound";

/**
 * hooks 执行体（M7）。
 *
 * 双通道：
 *   1. 订阅 app 事件总线（apply emit → 本模块监听并执行）；
 *   2. 导出 `runHook` 供 apply 流程直接调用。
 *
 * 语义：
 *   - ui.open      → 广播 `{type:"hook.ui.open", payload:{skillId, appId}}`
 *   - config.apply → reapplyProfileConfig（configEdit 官方命令优先）→ 广播 via
 *   - notify       → outbound.pushNotify（签名）→ 广播结果摘要
 *
 * 每次执行写入内存环形缓冲（最近 100）；异常 catch + 记录，**绝不抛穿**。
 */

const LOG_LIMIT = 100;

const hookLog: HookLogEntry[] = [];
const unsubscribers: Array<() => void> = [];
let started = false;

/** executor 可注入依赖（测试 / 环境隔离）。 */
export interface HookExecutorDeps extends ApplyAppDeps {
  /** 覆盖广播（默认 dashboard/bus）。 */
  broadcast?: (event: { type: string; at?: string; payload?: Record<string, unknown> }) => void;
  /** 覆盖 pushNotify（测试 mock）。 */
  pushNotify?: typeof pushNotify;
  /** 覆盖 config 重放。 */
  reapplyProfileConfig?: typeof reapplyProfileConfig;
  /** 解析 profile 明文 env（token）。 */
  readEnv?: (appId: string) => Promise<Record<string, string>>;
}

let deps: HookExecutorDeps = {};

/** 配置依赖（浅合并；测试可重置）。 */
export function configureHookExecutor(next: HookExecutorDeps = {}): void {
  deps = { ...next };
}

/** 重置依赖与日志（测试用）。 */
export function resetHookExecutor(): void {
  stopHookExecutor();
  deps = {};
  hookLog.length = 0;
  started = false;
}

/** 最近 hook 执行日志（新→旧副本）。 */
export function getHookLog(): HookLogEntry[] {
  return [...hookLog].reverse();
}

function record(entry: HookLogEntry): HookLogEntry {
  hookLog.push(entry);
  if (hookLog.length > LOG_LIMIT) {
    hookLog.splice(0, hookLog.length - LOG_LIMIT);
  }
  return entry;
}

function emit(
  type: string,
  payload?: Record<string, unknown>,
): void {
  const fn = deps.broadcast ?? broadcast;
  fn({ type, at: new Date().toISOString(), ...(payload ? { payload } : {}) });
}

/** runHook 入参。 */
export interface RunHookContext {
  ui?: { skillId?: string; host?: string };
  mode?: string;
  version?: string;
  /** 明文 env（apply 时传入；优先于 profile .env）。 */
  env?: Record<string, string>;
  /** notify 推送 body 附加字段。 */
  extra?: Record<string, unknown>;
}

/**
 * 执行单个 hook；永不抛出（异常 → status:"error" 记录并返回）。
 */
export async function runHook(
  hook: AppHookName,
  manifest: AppManifest,
  context: RunHookContext = {},
): Promise<HookLogEntry> {
  const appId = manifest.id;
  const at = new Date().toISOString();
  try {
    switch (hook) {
      case "ui.open": {
        const skillId = context.ui?.skillId ?? manifest.ui?.skillId;
        emit("hook.ui.open", { skillId, appId });
        break;
      }
      case "config.apply": {
        const reapply = deps.reapplyProfileConfig ?? reapplyProfileConfig;
        const via = await reapply(appId, manifest, deps);
        emit("hook.config.apply", { appId, via });
        break;
      }
      case "notify": {
        const results = await runNotify(manifest, context);
        emit("hook.notify", {
          appId,
          results: results.map((item) => ({
            plugin: item.plugin,
            status: item.result.status,
            ...(item.result.reason ? { reason: item.result.reason } : {}),
          })),
        });
        break;
      }
      default: {
        const exhaustive: never = hook;
        throw new Error(`未知 hook：${String(exhaustive)}`);
      }
    }
    return record({ hook, appId, status: "ok", at });
  } catch (error) {
    return record({
      hook,
      appId,
      status: "error",
      at,
      error: (error as Error).message,
    });
  }
}

/** 对 manifest.plugins 逐个签名推送。 */
async function runNotify(
  manifest: AppManifest,
  context: RunHookContext,
): Promise<Array<{ plugin: string; result: PushNotifyResult }>> {
  const plugins = manifest.plugins ?? [];
  if (plugins.length === 0) return [];

  const push = deps.pushNotify ?? pushNotify;
  const readEnv = deps.readEnv ?? ((id: string) => readProfileEnvValues(id, deps));
  const env = context.env ?? (await readEnv(manifest.id));

  const body = {
    event: "app.hook",
    hook: "notify",
    appId: manifest.id,
    version: context.version ?? manifest.version,
    mode: context.mode,
    at: new Date().toISOString(),
    ...(context.extra ?? {}),
  };

  const out: Array<{ plugin: string; result: PushNotifyResult }> = [];
  for (const plugin of plugins) {
    const options: PushNotifyOptions = { env };
    const result = await push(plugin as PushNotifyPlugin, body, options);
    out.push({ plugin: plugin.name, result });
  }
  return out;
}

/** 处理一条 app 事件：先广播生命周期，再顺序执行 hooks。 */
async function handleAppEvent(
  type: AppEventType,
  payload: AppEventPayload,
): Promise<void> {
  emit(type, {
    id: payload.id,
    version: payload.version,
    mode: payload.mode,
    at: payload.at,
    hooks: payload.hooks,
  });

  const manifest = payload.manifest;
  if (!manifest) return;

  const context: RunHookContext = {
    ...(payload.ui ? { ui: payload.ui } : {}),
    mode: payload.mode,
    version: payload.version,
    env: manifest.profile?.env,
  };
  for (const hook of payload.hooks) {
    await runHook(hook, manifest, context);
  }
}

/**
 * 订阅全部 app 事件（幂等）。返回停止函数。
 * 监听器内部异步任务 fire-and-forget，异常已在 runHook 内吞掉。
 */
export function startHookExecutor(): () => void {
  if (started) return stopHookExecutor;
  started = true;
  const types: AppEventType[] = [
    "app.install",
    "app.update",
    "app.uninstall",
    "app.rollback",
  ];
  for (const type of types) {
    const listener: AppEventListener = (payload) => {
      void handleAppEvent(type, payload).catch(() => undefined);
    };
    unsubscribers.push(onAppEvent(type, listener));
  }
  return stopHookExecutor;
}

/** 取消全部订阅。 */
export function stopHookExecutor(): void {
  for (const off of unsubscribers.splice(0)) {
    try {
      off();
    } catch {
      // ignore
    }
  }
  started = false;
}

/** 是否已启动（测试/状态用）。 */
export function isHookExecutorStarted(): boolean {
  return started;
}

/** 便捷：按 mode 推导事件名并 re-export（对称 events）。 */
export { appEventType };
