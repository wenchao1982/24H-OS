import { describe, expect, it } from "vitest";
import {
  getSubagentSupport,
  runSubagent,
  SUBAGENT_CONTRACT,
} from "./subagent";

/**
 * subagent 研究结论测试（M5）。
 *
 * 只读依据：tui_gateway contracts —— subagent 观测/控制方法存在，
 * 但**无直接 spawn/run RPC**；runSubagent 因此恒返回 unsupported，
 * 且绝不发起模型调用。
 */

describe("getSubagentSupport —— 契约研究结论", () => {
  it("spawn 不存在；观测/控制存在；列出已确认方法与事件", () => {
    const support = getSubagentSupport();
    expect(support.spawnSupported).toBe(false);
    expect(support.observeSupported).toBe(true);
    expect(support.contractGateway).toBe("v0.21.3");
    expect(support.methods).toContain("subagent.list");
    expect(support.methods).toContain("subagent.steer");
    expect(support.methods).toContain("delegation.status");
    expect(support.events).toContain("subagent.spawn_requested");
    expect(support.note).toContain("未暴露直接 spawn");
  });

  it("返回副本，外部修改不影响常量", () => {
    const support = getSubagentSupport();
    support.methods.push("hacked");
    expect(SUBAGENT_CONTRACT.methods).not.toContain("hacked");
  });
});

describe("runSubagent —— unsupported（不造假）", () => {
  it("返回 ok:false / supported:false / UNSUPPORTED + 研究结论", async () => {
    const result = await runSubagent({ profile: "writer", prompt: "去干活" });
    expect(result).toMatchObject({
      ok: false,
      supported: false,
      code: "UNSUPPORTED",
    });
    expect(result.contract.spawnSupported).toBe(false);
    expect(result.message).toContain("delegate_task");
  });

  it("空 prompt → INVALID_VALUE", async () => {
    await expect(runSubagent({ prompt: "   " })).rejects.toMatchObject({
      code: "INVALID_VALUE",
    });
  });
});
