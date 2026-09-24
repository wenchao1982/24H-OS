import type {
  AppApplyMode,
  AppHookName,
  AppManifest,
  AppManifestUi,
} from "@shared/types";

/**
 * App 事件总线（M6 极简实现）。
 *
 * M6 只 emit；M7 再订阅并执行 hooks（ui.open / config.apply / notify）
 * 与推送 Dashboard WS。
 * 同步分发：监听器异常被捕获并忽略，绝不影响编排主流程。
 */

/** 事件类型（编排阶段）。 */
export type AppEventType = "app.install" | "app.update" | "app.uninstall" | "app.rollback";

/** 事件负载。 */
export interface AppEventPayload {
  /** App id（= profile id）。 */
  id: string;
  version: string;
  mode: AppApplyMode;
  /** 该阶段声明、将被 M7 执行的 hooks。 */
  hooks: AppHookName[];
  ui?: AppManifestUi;
  /** ISO 时间。 */
  at: string;
  /** 最近一次 profile 备份（uninstall/update/rollback 可能有）。 */
  backupPath?: string;
  /**
   * M7：完整 manifest（**进程内 only**，含 profile.env 明文与 plugins）。
   * 供 executor 执行 config.apply / notify；绝不落盘、绝不进 GET 响应。
   */
  manifest?: AppManifest;
}

export type AppEventListener = (payload: AppEventPayload) => void;

const listeners = new Map<AppEventType, Set<AppEventListener>>();

/** 订阅；返回取消订阅函数。 */
export function onAppEvent(
  type: AppEventType,
  listener: AppEventListener,
): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/** 分发事件（同步；监听器异常吞掉）。 */
export function emitAppEvent(type: AppEventType, payload: AppEventPayload): void {
  const set = listeners.get(type);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(payload);
    } catch {
      // 监听器失败不影响编排。
    }
  }
}

/** 清空全部监听（测试用）。 */
export function clearAppEventListeners(): void {
  listeners.clear();
}

/** 由 mode 推导事件名。 */
export function appEventType(mode: AppApplyMode): AppEventType {
  switch (mode) {
    case "install":
      return "app.install";
    case "update":
      return "app.update";
    case "uninstall":
      return "app.uninstall";
    case "rollback":
      return "app.rollback";
    default:
      return "app.install";
  }
}
