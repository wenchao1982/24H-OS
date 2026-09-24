import type { SubagentRunResult, SubagentSupportInfo } from "@shared/types";
import { lifecycleError } from "./errors";

/**
 * subagent 契约研究结论（M5，只读依据：
 * `~/hermes-desktop/home/hermes-agent/tui_gateway/` contracts + methods_*）。
 *
 * 结论（gateway v0.21.3 契约）：
 *   - **观测/控制面存在**：
 *       subagent.list / subagent.interrupt / subagent.tail
 *       （contracts/profiles_vault_complete_foreign_subagents.py）
 *       subagent.steer / delegation.status / delegation.pause
 *       （contracts/billing_delegation_pets.py）
 *       spawn_tree.save / spawn_tree.list / spawn_tree.load（contracts/sessions.py）
 *   - **事件存在**：subagent.spawn_requested / start / progress / thinking / tool /
 *     complete（contracts/events.py）——由会话内 `delegate_task` 工具在父会话流中发出。
 *   - **不存在直接 spawn/run 的 RPC**：无 `subagent.spawn` / `task.spawn` / `delegate.*`
 *     等方法；子代理只能由父会话中 LLM 调用 `delegate_task` 工具启动
 *     （tools/delegate_tool_registry）。
 *
 * 因此 `runSubagent({ profile, prompt })` **不造假**：返回 `UNSUPPORTED`，
 * 待官方暴露 spawn 契约后再实现真调模型 + 事件透传。
 */

/** 研究结论常量（测试与文档引用同一来源）。 */
export const SUBAGENT_CONTRACT: SubagentSupportInfo = Object.freeze({
  spawnSupported: false,
  observeSupported: true,
  contractGateway: "v0.21.3",
  methods: [
    "subagent.list",
    "subagent.interrupt",
    "subagent.tail",
    "subagent.steer",
    "delegation.status",
    "delegation.pause",
    "spawn_tree.save",
    "spawn_tree.list",
    "spawn_tree.load",
  ],
  events: [
    "subagent.spawn_requested",
    "subagent.start",
    "subagent.progress",
    "subagent.thinking",
    "subagent.tool",
    "subagent.complete",
  ],
  note:
    "当前 gateway v0.21.3 契约存在 subagent 观测/控制方法与 subagent.* 事件，" +
    "但未暴露直接 spawn/run 的 RPC（无 subagent.spawn / task.spawn / delegate.*）；" +
    "子代理由父会话内 delegate_task 工具启动。runSubagent 返回 unsupported，待官方。",
});

/** 返回 subagent 能力研究结论（spawn / observe 是否可用）。 */
export function getSubagentSupport(): SubagentSupportInfo {
  return { ...SUBAGENT_CONTRACT, methods: [...SUBAGENT_CONTRACT.methods], events: [...SUBAGENT_CONTRACT.events] };
}

/** runSubagent 参数（与路由 body 对齐）。 */
export interface RunSubagentOptions {
  profile?: string;
  prompt: string;
}

/**
 * 最小 subagent 封装：因 spawn RPC 缺失，恒返回 unsupported。
 * **绝不发起模型调用**（不触碰 gateway / CLI）。
 */
export async function runSubagent(
  options: RunSubagentOptions,
): Promise<SubagentRunResult> {
  if (typeof options?.prompt !== "string" || options.prompt.trim() === "") {
    throw lifecycleError("INVALID_VALUE", "prompt 不能为空。");
  }
  const contract = getSubagentSupport();
  return {
    ok: false,
    supported: false,
    code: "UNSUPPORTED",
    message: contract.note,
    contract,
  };
}
