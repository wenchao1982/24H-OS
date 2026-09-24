import type { DashboardEvent } from "@shared/types";

/**
 * Dashboard 广播总线（M7）。
 *
 * 单一 `broadcast(event)` 注入点：WS 路由挂上后 `setBroadcast`，
 * 其余模块（hooks / bot / chat / gateway / apply）只调 `broadcast`。
 * 未挂载时静默丢弃，便于单测与无 WS 场景。
 */

export type BroadcastFn = (event: DashboardEvent) => void;

let impl: BroadcastFn | null = null;

/** 挂载真实广播实现（WS 路由启动时调用）。返回卸载函数。 */
export function setBroadcast(fn: BroadcastFn | null): () => void {
  impl = fn;
  return () => {
    if (impl === fn) impl = null;
  };
}

/** 当前实现（测试可读取）。 */
export function getBroadcast(): BroadcastFn | null {
  return impl;
}

/**
 * 广播一条事件；自动补 `at`。监听器异常吞掉（绝不影响主流程）。
 * payload **禁止**包含 prompt / 回复正文 / 密钥。
 */
export function broadcast(
  event: Omit<DashboardEvent, "at"> & { at?: string },
): void {
  if (!impl) return;
  const full: DashboardEvent = {
    type: event.type,
    at: event.at ?? new Date().toISOString(),
    ...(event.payload ? { payload: event.payload } : {}),
  };
  try {
    impl(full);
  } catch {
    // 广播失败不影响业务。
  }
}
