import type {
  SubagentInfo,
  SubagentInterruptResult,
  SubagentPauseResult,
  SubagentRunResult,
  SubagentSteerResult,
  SubagentSupportInfo,
  SubagentTailResult,
  SubagentsResponse,
} from "@shared/types";
import { detectHermes } from "./detect";
import { lifecycleError } from "./errors";

/**
 * subagent 薄封装（M5/M10，风格对齐 `cron.ts`）。
 *
 * 契约现状（只读依据：`~/hermes-desktop/home/hermes-agent/tui_gateway/`）：
 *   - **没有 `subagent.spawn` / `task.spawn` / `delegate.*` RPC**；子代理由父会话内 LLM
 *     调用**工具 `delegate_task`**在**同一进程内**创建（`delegation.max_spawn_depth` 默认 1）；
 *   - 观测/控制 RPC 存在：
 *       `subagent.list` / `subagent.interrupt` / `subagent.tail`
 *         （methods_subagents.py:29/42/66，params 均为 SessionParams，见
 *          contracts/profiles_vault_complete_foreign_subagents.py:566+）；
 *       `subagent.steer`（methods_session.py:2092，params `session_id`+`subagent_id`+`text`）；
 *       `delegation.pause`（methods_session.py:2086，params `paused`，全局暂停 spawn）；
 *   - 事件 `subagent.spawn_requested/start/progress/thinking/tool/complete`
 *     （contracts/events.py:463-468）由会话内工具在父会话流中发出，经 chat 流透出。
 *
 * 因此本模块**不造假 spawn**：`getSubagentSupport()` 明确 `spawnApi:false`，
 * `runSubagent()` 恒返回 `SPAWN_UNSUPPORTED`（绝不调模型）；其余方法薄封装官方 RPC。
 *
 * 安全：RPC 参数只走 gateway WS JSON-RPC（无 shell），但仍校验 id / text 防异常输入。
 */

/** 研究结论常量（测试与文档引用同一来源）。 */
export const SUBAGENT_CONTRACT: SubagentSupportInfo = Object.freeze({
  spawnApi: false,
  controlApi: true,
  events: true,
  mechanism: "delegate_task (in-session tool)",
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
  eventNames: [
    "subagent.spawn_requested",
    "subagent.start",
    "subagent.progress",
    "subagent.thinking",
    "subagent.tool",
    "subagent.complete",
  ],
  note:
    "gateway v0.21.3 未暴露直接 spawn/run 的 RPC（无 subagent.spawn / task.spawn / " +
    "delegate.*）；子代理由父会话内 LLM 调用工具 delegate_task 创建（同进程子会话）。" +
    "工作台提供观测/控制（list/tail/interrupt/steer/delegation.pause）并透出 subagent.* 事件。",
});

/** 返回 subagent 能力说明（spawn API / 观测控制 / 事件）。 */
export function getSubagentSupport(): SubagentSupportInfo {
  return {
    ...SUBAGENT_CONTRACT,
    methods: [...SUBAGENT_CONTRACT.methods],
    eventNames: [...SUBAGENT_CONTRACT.eventNames],
  };
}

/** gateway 客户端的最小结构（`GatewayClient` 天然满足）。 */
export interface SubagentRpcClient {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

/** 依赖注入（测试用；生产全部走默认）。 */
export interface SubagentDeps {
  /** 直接注入客户端（测试）。 */
  client?: SubagentRpcClient;
  /** 客户端解析函数（默认 detectHermes + ensureGateway）。 */
  getClient?: () => Promise<SubagentRpcClient>;
}

const MAX_TEXT_LENGTH = 8192;
const MAX_ID_LENGTH = 256;

/** 默认客户端：detectHermes → ensureGateway（复用共享 gateway）。 */
async function defaultGetClient(): Promise<SubagentRpcClient> {
  const detection = await detectHermes();
  if (!detection.cliPath) {
    throw lifecycleError(
      "SUBAGENT_UNAVAILABLE",
      "未检测到可用的 hermes CLI，无法访问 subagent 观测/控制。",
    );
  }
  // 动态 import 避免与 gateway 模块的潜在循环依赖。
  const { ensureGateway } = await import("./gateway");
  const entry = await ensureGateway(detection.cliPath);
  return entry.client;
}

/** 把 gateway / 官方错误归一化为结构化 subagent 错误。 */
function toSubagentError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  if (code === "GATEWAY_RPC_ERROR" || code === "SUBAGENT_RPC_ERROR") {
    return lifecycleError(
      "SUBAGENT_RPC_ERROR",
      `subagent RPC 返回错误：${(error as Error).message}`,
    );
  }
  if (
    code === "GATEWAY_UNAVAILABLE" ||
    code === "GATEWAY_TIMEOUT" ||
    code === "HERMES_CLI_UNAVAILABLE" ||
    code === "SUBAGENT_UNAVAILABLE"
  ) {
    return lifecycleError(
      "SUBAGENT_UNAVAILABLE",
      `无法连接 subagent 观测/控制：${(error as Error).message}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function callSubagent(
  method: string,
  params: Record<string, unknown>,
  deps: SubagentDeps,
): Promise<Record<string, unknown>> {
  const client = deps.client ?? (await (deps.getClient ?? defaultGetClient)());
  try {
    const result = await client.call<Record<string, unknown>>(method, params);
    return result && typeof result === "object" ? result : {};
  } catch (error) {
    throw toSubagentError(error);
  }
}

/* ------------------------------------------------------------------ *
 * 参数校验
 * ------------------------------------------------------------------ */

/** 校验非空 id（session_id / subagent_id），返回 trim 后的值。 */
export function validateSubagentId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw lifecycleError("INVALID_VALUE", `${field} 不能为空。`);
  if (id.length > MAX_ID_LENGTH || /[\r\n\0]/.test(id)) {
    throw lifecycleError("INVALID_VALUE", `${field} 含非法字符或过长。`);
  }
  return id;
}

/** 校验 steering 文本，返回 trim 后的值。 */
export function validateSteerText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw lifecycleError("INVALID_VALUE", "text 不能为空。");
  if (text.length > MAX_TEXT_LENGTH) {
    throw lifecycleError("INVALID_VALUE", `text 过长（>${MAX_TEXT_LENGTH}）。`);
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * 观测 / 控制
 * ------------------------------------------------------------------ */

function normalizeSubagent(raw: unknown): SubagentInfo {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { ...obj, subagent_id: typeof obj.subagent_id === "string" ? obj.subagent_id : "" } as SubagentInfo;
}

/**
 * 列出某会话的活跃子代理（官方 `subagent.list`，按会话隔离）。
 * 无 session_id 时官方会报错，故 sessionId 必填（路由对缺省做 0 条降级）。
 */
export async function listSubagents(
  sessionId: unknown,
  deps: SubagentDeps = {},
): Promise<SubagentsResponse> {
  const sid = validateSubagentId(sessionId, "sessionId");
  const result = await callSubagent("subagent.list", { session_id: sid }, deps);
  const raw = Array.isArray(result.subagents) ? result.subagents : [];
  const subagents = raw.map(normalizeSubagent);
  return {
    subagents,
    count: subagents.length,
    sessionId: sid,
    support: getSubagentSupport(),
    message: subagents.length === 0 ? "当前会话没有活跃子代理。" : `当前会话有 ${subagents.length} 个活跃子代理。`,
  };
}

/** 硬中断一个自己拥有的子代理（官方 `subagent.interrupt`）。 */
export async function interruptSubagent(
  sessionId: unknown,
  subagentId: unknown,
  deps: SubagentDeps = {},
): Promise<SubagentInterruptResult> {
  const sid = validateSubagentId(sessionId, "sessionId");
  const id = validateSubagentId(subagentId, "subagentId");
  const result = await callSubagent(
    "subagent.interrupt",
    { session_id: sid, subagent_id: id },
    deps,
  );
  const found = result.found === true;
  return {
    ok: true,
    found,
    subagent_id: id,
    message: found ? `已中断子代理 ${id}。` : `子代理 ${id} 已结束或不存在。`,
  };
}

/** 读取子代理最近 16KB 实时转录（官方 `subagent.tail`）。 */
export async function tailSubagent(
  sessionId: unknown,
  subagentId: unknown,
  deps: SubagentDeps = {},
): Promise<SubagentTailResult> {
  const sid = validateSubagentId(sessionId, "sessionId");
  const id = validateSubagentId(subagentId, "subagentId");
  const result = await callSubagent(
    "subagent.tail",
    { session_id: sid, subagent_id: id },
    deps,
  );
  return {
    subagent_id: typeof result.subagent_id === "string" ? result.subagent_id : id,
    available: result.available === true,
    text: typeof result.text === "string" ? result.text : "",
    truncated: result.truncated === true,
  };
}

/** 向活跃子代理投递 steering 文本（官方 `subagent.steer`；非破坏，不需 confirm）。 */
export async function steerSubagent(
  sessionId: unknown,
  subagentId: unknown,
  text: unknown,
  deps: SubagentDeps = {},
): Promise<SubagentSteerResult> {
  const sid = validateSubagentId(sessionId, "sessionId");
  const id = validateSubagentId(subagentId, "subagentId");
  const value = validateSteerText(text);
  const result = await callSubagent(
    "subagent.steer",
    { session_id: sid, subagent_id: id, text: value },
    deps,
  );
  const status = typeof result.status === "string" ? result.status : "rejected";
  return {
    ok: true,
    status,
    subagent_id: id,
    text: value,
    message: status === "queued" ? `已向子代理 ${id} 投递 steering。` : `steering 被拒绝（子代理可能已结束）。`,
  };
}

/** 全局暂停/恢复 spawn（官方 `delegation.pause`；缺省 paused:true）。 */
export async function setSpawnPaused(
  paused: unknown,
  deps: SubagentDeps = {},
): Promise<SubagentPauseResult> {
  const value = typeof paused === "boolean" ? paused : true;
  const result = await callSubagent("delegation.pause", { paused: value }, deps);
  const next = typeof result.paused === "boolean" ? result.paused : value;
  return {
    ok: true,
    paused: next,
    message: next ? "已全局暂停子代理 spawn。" : "已恢复子代理 spawn。",
  };
}

/* ------------------------------------------------------------------ *
 * spawn（保留：本端点不提供；子代理走会话内 delegate_task）
 * ------------------------------------------------------------------ */

/** runSubagent 参数（与路由 body 对齐）。 */
export interface RunSubagentOptions {
  profile?: string;
  prompt: string;
}

/**
 * 无 spawn API：恒返回 `SPAWN_UNSUPPORTED` + 研究结论。
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
    spawnApi: false,
    code: "SPAWN_UNSUPPORTED",
    message: contract.note,
    contract,
  };
}

// TODO(M10+: groups.*) — Group Chat（多 agent 房间）属官方地盘：内核有 `groups.*` RPC +
// `hosted_room_*`（peer.invite/approve）+ `bot_relay.*`。24H-OS 暂不实现 Group Chat UI
// （决策与入口见 docs/CHANNELS.md §5）。
