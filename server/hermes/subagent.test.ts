import { describe, expect, it } from "vitest";
import {
  getSubagentSupport,
  interruptSubagent,
  listSubagents,
  runSubagent,
  setSpawnPaused,
  steerSubagent,
  SUBAGENT_CONTRACT,
  tailSubagent,
  type SubagentRpcClient,
} from "./subagent";

/**
 * subagent 薄封装测试（M10）。
 *
 * 只读依据：tui_gateway contracts —— 无 spawn RPC；观测/控制存在
 * （subagent.list/tail/interrupt/steer、delegation.pause）、subagent.* 事件存在。
 * 全部用 mock RPC client，不触碰真实 gateway / ~/.hermes。
 */

interface Call {
  method: string;
  params?: Record<string, unknown>;
}

/** 构造注入用 mock client；responses 可为固定 map 或 (method, params) => value。 */
function makeClient(
  responses:
    | Record<string, unknown>
    | ((method: string, params?: Record<string, unknown>) => unknown),
): { client: SubagentRpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: SubagentRpcClient = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      const value =
        typeof responses === "function" ? responses(method, params) : responses[method];
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
  return { client, calls };
}

function rpcError(code: string, message = "boom"): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe("getSubagentSupport —— 能力语义（无 spawn API）", () => {
  it("spawnApi:false / controlApi:true / events:true + mechanism", () => {
    const support = getSubagentSupport();
    expect(support.spawnApi).toBe(false);
    expect(support.controlApi).toBe(true);
    expect(support.events).toBe(true);
    expect(support.mechanism).toBe("delegate_task (in-session tool)");
    expect(support.contractGateway).toBe("v0.21.3");
    expect(support.methods).toContain("subagent.list");
    expect(support.methods).toContain("subagent.steer");
    expect(support.methods).toContain("delegation.pause");
    expect(support.eventNames).toContain("subagent.spawn_requested");
    expect(support.note).toContain("delegate_task");
    // 不再以「UNSUPPORTED / 不支持」笼统表述。
    expect(support.note).not.toContain("不支持");
  });

  it("返回副本，外部修改不影响常量", () => {
    const support = getSubagentSupport();
    support.methods.push("hacked");
    support.eventNames.push("hacked");
    expect(SUBAGENT_CONTRACT.methods).not.toContain("hacked");
    expect(SUBAGENT_CONTRACT.eventNames).not.toContain("hacked");
  });
});

describe("listSubagents —— 观测", () => {
  it("调用 subagent.list{session_id} 并归一化快照", async () => {
    const { client, calls } = makeClient({
      "subagent.list": {
        subagents: [
          { subagent_id: "sa-1", goal: "写报告", depth: 1, status: "running", tool_count: 2 },
        ],
        delegations: [],
      },
    });
    const result = await listSubagents("s1", { client });
    expect(calls[0]).toEqual({ method: "subagent.list", params: { session_id: "s1" } });
    expect(result).toMatchObject({ count: 1, sessionId: "s1" });
    expect(result.subagents[0]).toMatchObject({ subagent_id: "sa-1", goal: "写报告", depth: 1 });
    expect(result.support.spawnApi).toBe(false);
  });

  it("无 sessionId → INVALID_VALUE（官方按会话隔离，必须提供）", async () => {
    const { client } = makeClient({});
    await expect(listSubagents("", { client })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });

  it("空列表 → count 0 + 提示", async () => {
    const { client } = makeClient({ "subagent.list": { subagents: [], delegations: [] } });
    const result = await listSubagents("s1", { client });
    expect(result.count).toBe(0);
    expect(result.message).toContain("没有活跃子代理");
  });

  it("GATEWAY_UNAVAILABLE → SUBAGENT_UNAVAILABLE（503 语义）；RPC 错误 → SUBAGENT_RPC_ERROR", async () => {
    const a = makeClient(() => rpcError("GATEWAY_UNAVAILABLE", "no gateway"));
    await expect(listSubagents("s1", { client: a.client })).rejects.toMatchObject({
      code: "SUBAGENT_UNAVAILABLE",
    });

    const b = makeClient(() => rpcError("GATEWAY_RPC_ERROR", "rpc failed"));
    await expect(listSubagents("s1", { client: b.client })).rejects.toMatchObject({
      code: "SUBAGENT_RPC_ERROR",
    });
  });
});

describe("interruptSubagent —— 控制（硬中断）", () => {
  it("调用 subagent.interrupt{session_id,subagent_id}；found 透传", async () => {
    const { client, calls } = makeClient({
      "subagent.interrupt": { found: true, subagent_id: "sa-1" },
    });
    const result = await interruptSubagent("s1", "sa-1", { client });
    expect(calls[0]).toEqual({
      method: "subagent.interrupt",
      params: { session_id: "s1", subagent_id: "sa-1" },
    });
    expect(result).toMatchObject({ ok: true, found: true, subagent_id: "sa-1" });
  });

  it("found:false → 说明「已结束或不存在」", async () => {
    const { client } = makeClient({
      "subagent.interrupt": { found: false, subagent_id: "sa-x" },
    });
    const result = await interruptSubagent("s1", "sa-x", { client });
    expect(result.found).toBe(false);
    expect(result.message).toContain("已结束或不存在");
  });

  it("缺 subagentId → INVALID_VALUE", async () => {
    const { client } = makeClient({});
    await expect(interruptSubagent("s1", "", { client })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });
});

describe("tailSubagent —— 转录", () => {
  it("调用 subagent.tail 并透传 text/truncated", async () => {
    const { client, calls } = makeClient({
      "subagent.tail": { subagent_id: "sa-1", available: true, text: "hello", truncated: true },
    });
    const result = await tailSubagent("s1", "sa-1", { client });
    expect(calls[0].method).toBe("subagent.tail");
    expect(calls[0].params).toEqual({ session_id: "s1", subagent_id: "sa-1" });
    expect(result).toEqual({
      subagent_id: "sa-1",
      available: true,
      text: "hello",
      truncated: true,
    });
  });

  it("未就绪 → available:false + 空文本", async () => {
    const { client } = makeClient({
      "subagent.tail": { subagent_id: "sa-1", available: false, text: "", truncated: false },
    });
    const result = await tailSubagent("s1", "sa-1", { client });
    expect(result.available).toBe(false);
    expect(result.text).toBe("");
  });
});

describe("steerSubagent —— 投递 steering", () => {
  it("调用 subagent.steer{session_id,subagent_id,text}；queued 透传", async () => {
    const { client, calls } = makeClient({
      "subagent.steer": { status: "queued", subagent_id: "sa-1", text: "换个方向" },
    });
    const result = await steerSubagent("s1", "sa-1", "  换个方向  ", { client });
    expect(calls[0]).toEqual({
      method: "subagent.steer",
      params: { session_id: "s1", subagent_id: "sa-1", text: "换个方向" },
    });
    expect(result).toMatchObject({ ok: true, status: "queued", text: "换个方向" });
  });

  it("空 text → INVALID_VALUE", async () => {
    const { client } = makeClient({});
    await expect(steerSubagent("s1", "sa-1", "   ", { client })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });

  it("rejected 状态 → 提示可能已结束", async () => {
    const { client } = makeClient({ "subagent.steer": { status: "rejected" } });
    const result = await steerSubagent("s1", "sa-1", "x", { client });
    expect(result.status).toBe("rejected");
    expect(result.message).toContain("拒绝");
  });
});

describe("setSpawnPaused —— 全局暂停 spawn", () => {
  it("缺省 paused:true；显式 false 恢复", async () => {
    const pause = makeClient({ "delegation.pause": { paused: true } });
    const r1 = await setSpawnPaused(undefined, { client: pause.client });
    expect(pause.calls[0]).toEqual({ method: "delegation.pause", params: { paused: true } });
    expect(r1).toMatchObject({ ok: true, paused: true });

    const resume = makeClient({ "delegation.pause": { paused: false } });
    const r2 = await setSpawnPaused(false, { client: resume.client });
    expect(resume.calls[0].params).toEqual({ paused: false });
    expect(r2.paused).toBe(false);
  });
});

describe("runSubagent —— 无 spawn API（不造假）", () => {
  it("返回 ok:false / spawnApi:false / SPAWN_UNSUPPORTED + 结论，且不触达 RPC", async () => {
    const result = await runSubagent({
      profile: "writer",
      prompt: "去干活",
    });
    expect(result).toMatchObject({ ok: false, spawnApi: false, code: "SPAWN_UNSUPPORTED" });
    expect(result.contract.spawnApi).toBe(false);
    expect(result.message).toContain("delegate_task");
  });

  it("空 prompt → INVALID_VALUE", async () => {
    await expect(runSubagent({ prompt: "   " })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });
});
